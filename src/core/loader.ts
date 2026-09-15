/**
 * 插件加载 + 消息分发
 * 相对 TRSS 的差异：事件按 post_type 分桶索引、accept 与 rule 复用同一插件实例、消息计数内存聚合后批量写回。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import schedule from 'node-schedule'
import chokidar from 'chokidar'
import moment from 'moment'
import cfg from './config/index.js'
import plugin from './plugin.js'
import Runtime from './runtime.js'
import Handler from './handler.js'
import util from './util.js'
import { logger } from './log.js'
import metrics from './metrics.js'
import type { JiuLiEvent, PluginEntry } from './types.js'

/** 兼容旧插件直接使用全局 plugin */
;(globalThis as any).plugin = plugin

/** 简易 truncate，避免核心依赖 lodash */
function truncate(str: string, length: number) {
  if (!str) return ''
  return str.length > length ? `${str.slice(0, length)}...` : str
}

/** 各适配器返回格式不一：{ error: [] } 空数组表示成功，也可能返回 Error 实例或字符串 */
function hasSendError(res: any): boolean {
  if (!res || typeof res !== 'object') return false
  const err = res.error ?? res.err
  if (err === undefined || err === null) return false
  if (Array.isArray(err)) return err.length > 0
  if (err instanceof Error) return true
  return Boolean(err)
}

function describeSendError(res: any): string {
  const err = res?.error ?? res?.err
  const first = Array.isArray(err) ? err[0] : err
  if (!first) return String(err ?? '未知错误')
  if (typeof first === 'string') return first
  if (first instanceof Error) return first.message
  return String(first.message ?? first.code ?? first.msg ?? util.String(first))
}

function isEmptyObject(obj: any) {
  if (!obj) return true
  for (const _ in obj) return false
  return true
}

class PluginsLoader {
  /** 赋值时重建事件索引，兼容插件直接替换 priority 的用法 */
  private _priority: PluginEntry[] = []
  get priority(): PluginEntry[] {
    return this._priority
  }
  set priority(list: PluginEntry[]) {
    this._priority = list
    this.buildEventIndex()
  }

  handler: Record<string, any> = {}
  task: any[] = []
  /** JIULI_PLUGINS_DIR 可指定，用于测试/多实例隔离 */
  dir = process.env.JIULI_PLUGINS_DIR || 'plugins'

  /** 事件索引：post_type → 插件条目 */
  eventIndex = new Map<string, PluginEntry[]>()
  /** 无插件类的文件（适配器/胶水），#重载 时跳过以免重复副作用 */
  inertFiles = new Set<string>()
  /** 加载阶段是否已结束（用于判断插件是否"迟到就绪"） */
  loaded = false
  /** 插件 init 实例，卸载时用于回调 onUnload */
  private initInstances = new Map<string, any>()
  groupCD: Record<string, boolean> = {}
  singleCD: Record<string, boolean> = {}
  /** 消息去重（1s） */
  msgThrottle: Record<string, boolean> = {}

  watcher: Record<string, any> = {}
  taskMap = new Map<string, Set<any>>()
  pluginCountMap = new Map<string, number>()
  pluginCount = 0
  load_time: Record<string, number> = {}
  eventCache = new WeakMap<object, { source: string; event: string[] }>()
  eventMap: Record<string, string[]> = {
    message: ['post_type', 'message_type', 'sub_type'],
    notice: ['post_type', 'notice_type', 'sub_type'],
    request: ['post_type', 'request_type', 'sub_type'],
  }

  /** 星铁命令前缀 */
  srReg = /^#?(\*|星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+/
  /** 绝区零前缀 */
  zzzReg = /^#?(%|％|绝区零|绝区)+/

  /** 计数缓冲：内存聚合 + 定时写回 */
  private countBuffer = new Map<string, number>()
  private countTimer?: NodeJS.Timeout

  /** 只做兼容别名、不作为插件源的目录（云崽的 plugins/other/ 转发到 system/） */
  aliasDirs = new Set(['other'])

  async getPlugins() {
    const files = await fs.readdir(this.dir, { withFileTypes: true }).catch(() => [] as any[])
    const ret: Array<{ name: string; path: string }> = []
    for (const val of files) {
      if (!val.isDirectory() || this.aliasDirs.has(val.name)) continue
      const tmp = { name: val.name, path: `../../${this.dir}/${val.name}` }

      if (await util.fsStat(`${this.dir}/${val.name}/index.js`)) {
        tmp.path = `${tmp.path}/index.js`
        ret.push(tmp)
        continue
      }

      const apps = await fs.readdir(`${this.dir}/${val.name}`, { withFileTypes: true })
      for (const app of apps) {
        if (!app.isFile() || !app.name.endsWith('.js')) continue
        ret.push({ name: `${tmp.name}/${app.name}`, path: `${tmp.path}/${app.name}` })
      }
    }
    return ret
  }

  /** isRefresh 时先卸载再加载 */
  async load(isRefresh = false) {
    if (isRefresh) {
      const keys = new Set([...this.priority.map(i => i.key), ...this.taskMap.keys(), ...this.pluginCountMap.keys()])
      for (const key of keys) await this.unloadPlugin(key)
    }
    if (this.priority.length) return

    util.makeLog('info', '扫描插件目录 plugins/ …', 'Plugin')

    const files = await this.getPlugins()
    this.pluginCount = 0
    this.load_time = {}
    const packageErr: any[] = []
    const loadStart = Date.now()

    /** 还没就绪的插件：等待期间每 5 秒报一次进度，避免「卡住了一样没输出」 */
    const pending = new Set(files.map(f => f.name))
    const report = setInterval(() => {
      if (!pending.size) return
      const list = [...pending]
      util.makeLog(
        'warn',
        `等待 ${logger.yellow(String(list.length))} 个插件就绪（已等 ${Math.round((Date.now() - loadStart) / 1000)} 秒）：` +
          `${list.slice(0, 6).join(' · ')}${list.length > 6 ? ' …' : ''}\n` +
          `        仍在加载的插件顶层可能在做重活（读资源 / 连服务 / 等网络）；超过 plugin_load_timeout 会跳过`,
        'Plugin',
      )
    }, 5000)
    report.unref?.()

    /**
     * 并发导入插件。
     *
     * 不能一次全放出去：Node 的 ESM 加载器在「多个模块同时求值、其中又有顶层 await」时
     * 会出现锁竞争，实测在 96 个插件的机器上会整体卡死（每个都开始导入、一个都不完成，
     * 事件循环却空闲、没有任何句柄 —— 承诺型死锁）；串行导入同样的插件只要 10 秒。
     * 并发数可用 config/jiuli.yaml → perf.load_concurrency 调整（1 即完全串行）。
     */
    const concurrency = Math.max(1, Math.min(Number(cfg.getPerf().load_concurrency) || 4, files.length))
    const queue = [...files]
    /** 一旦有插件超时，说明加载器被它卡住了：继续导入只会一个个耗完超时，直接收工 */
    let stalled = false
    const worker = async () => {
      while (queue.length && !stalled) {
        const file = queue.shift()!
        const timeout = cfg.bot.plugin_load_timeout * 1000
        const started = Date.now()
        if ((await util.sleep(timeout, this.importPlugin(file, packageErr))) === util.sleepTimeout) {
          stalled = true
          const rest = queue.length
          queue.length = 0
          util.makeLog(
            'error',
            `插件加载超时（${timeout / 1000} 秒）${logger.red(file.name)}\n` +
              `        该插件顶层可能在做重活或卡住了，并且会阻塞后续插件的导入\n` +
              `        本轮已加载 ${this.pluginCount} 个插件${rest ? `，跳过剩余 ${rest} 个` : ''}；修好后发 #重载 或重启即可\n` +
              `        排查：临时把该文件改名（如加 .disabled 后缀）或移走，再看是否恢复正常`,
            'Plugin',
          )
        } else if (Date.now() - started > 5000)
          util.makeLog(
            'warn',
            `插件就绪较慢 ${logger.yellow(file.name)} · ${util.getTimeDiff(started)}（不影响启动，仅供参考）`,
            'Plugin',
          )
        pending.delete(file.name)
      }
    }
    await Promise.allSettled(
      Array.from({ length: concurrency }, () => worker()),
    )
    clearInterval(report)

    this.packageTips(packageErr)
    this.createTask()
    this.buildEventIndex()

    const rules = this.priority.reduce((n, i) => n + (i.plugin.rule?.length || 0), 0)
    const listeners = this.priority.filter(i => i.plugin.accept || i.plugin.event !== 'message').length
    util.makeLog(
      'info',
      `插件 ${logger.green(String(this.pluginCount))} 个 · 规则 ${rules} 条 · 事件监听 ${listeners} 个 · 定时任务 ${this.task.length} 个 · 用时 ${util.getTimeDiff(loadStart)}`,
      'Plugin',
    )
    /** 并行导入下记录的是"开始加载 → 该插件就绪"（含公共依赖解析开销），不代表插件自身有问题 */
    const sorted = Object.entries(this.load_time).sort((a, b) => b[1] - a[1])
    const slow = sorted.filter(([, t]) => t > 200).slice(0, 8)
    if (slow.length)
      util.makeLog('debug', `就绪最慢：${slow.map(([f, t]) => `${f} ${t}ms`).join(' · ')}`, 'Plugin')
    const key = sorted.slice(0, 3).filter(([, t]) => t > 1000)
    if (key.length)
      util.makeLog(
        'mark',
        `启动关键路径：${key.map(([f, t]) => `${f} ${logger.yellow(`${t}ms`)}`).join(' · ')} · 并行导入，耗时含公共依赖解析`,
        'Plugin',
      )

    /** 优先级排序 */
    this.priority.sort((a, b) => a.priority - b.priority)

    /** 加载阶段结束：此后才就绪的插件（超时后才 import 完）会被自动补进分发 */
    this.loaded = true
    this.watchPlugins()
  }

  /** 迟到的插件（超过 plugin_load_timeout 才就绪）：补进索引与定时任务，避免"下次重载才生效" */
  private lateAttach(file: { name: string }) {
    if (!this.loaded || !this.pluginCountMap.get(file.name)) return
    const mine = this.priority.filter(i => i.key === file.name)
    if (!mine.length) return
    this.buildEventIndex()
    this.priority.sort((a, b) => a.priority - b.priority)
    this.createTask()
    util.makeLog(
      'mark',
      `${logger.green(mine.map(i => i.name).join(' · '))} ${logger.gray(file.name)} 迟到就绪，已加入分发`,
      'Plugin',
    )
  }

  buildEventIndex() {
    this.eventIndex = new Map()
    for (const entry of this.priority) {
      const event = entry.plugin?.event || 'message'
      const bucket = Array.isArray(event) ? '*' : String(event).split('.')[0] || '*'
      const list = this.eventIndex.get(bucket) || []
      list.push(entry)
      this.eventIndex.set(bucket, list)
    }
  }

  /** 候选插件：事件索引命中桶 + 通配桶 */
  private candidates(e: JiuLiEvent) {
    if (cfg.getPerf().event_index === false) return this.priority
    const index = this.eventIndex
    const list = index.get(e.post_type)
    const wild = index.get('*')
    if (!list) return wild ? [...wild] : []
    if (!wild) return list
    return [...list, ...wild]
  }

  /**
   * 把插件加载错误翻译成「看得懂 + 有下一步」的一行提示；完整堆栈留给 debug 级别
   * @returns text 提示文本；pkg 是否属于「缺依赖」（汇总后统一提示安装）
   */
  describeLoadError(error: any, file: { name: string }): { text: string; pkg: boolean } {
    const msg = String(error?.message || error)
    const head = `插件加载错误 ${logger.red(file.name)} · `
    const rel = (p: string) => String(p).replace(/\\/g, '/').replace(`${process.cwd().replace(/\\/g, '/')}/`, '')

    /** 路径型模块找不到：插件少放文件 / 相对路径写错（Windows 下 imported from 后不带引号） */
    const missing = msg.match(/Cannot find module '([^']+)'(?:\s+imported from\s+'?([^'\s]+)'?)?/)
    if (missing) {
      const target = missing[1]
      if (target.startsWith('.') || target.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(target)) {
        return {
          text:
            head +
            `找不到文件 ${logger.yellow(rel(target))}\n` +
            `        ${missing[2] ? `由 ${logger.gray(rel(missing[2]))} 引入 —— ` : ''}该文件不存在：插件没放全，或相对路径写错`,
          pkg: false,
        }
      }
    }

    /** 裸包名：缺依赖 */
    const pkgMatch = msg.match(/Cannot find package '([^']+)'(?:\s+imported from\s+'?([^'\s]+)'?)?/)
    if (pkgMatch) {
      const [, name] = pkgMatch
      const dir = rel(pkgMatch[2] || '').split('/').slice(0, 2).join('/')
      return {
        text:
          head +
          `缺少依赖包 ${logger.red(name)}${pkgMatch[2] ? `（${logger.gray(rel(pkgMatch[2]))} 引入）` : ''}\n` +
          `        安装：${dir ? `cd ${dir} && ` : ''}pnpm add ${name}　或　项目根目录 pnpm i` +
          `　或一键装齐插件依赖：node jiuli deps`,
        pkg: true,
      }
    }

    /** 语法错误：给出位置，便于直接定位 */
    if (error?.name === 'SyntaxError' || /Unexpected|Invalid or unexpected token/.test(msg)) {
      return {
        text:
          head +
          `语法错误 ${logger.yellow(msg)}\n` +
          `        检查该文件是否写完整（括号 / 引号是否闭合），可执行 node --check 自查`,
        pkg: false,
      }
    }

    /** 其它错误：给出原因，能定位到插件内某一行就带上 */
    const frame = util.errorFrame(error)
    return {
      text: head + logger.yellow(msg) + (frame ? `\n        ${logger.gray(frame)}` : ''),
      pkg: false,
    }
  }

  async importPlugin(file: { name: string; path: string }, packageErr?: any[]) {
    const start_time = Date.now()
    let success = true
    this.pluginCountMap.set(file.name, 0)
    /** 标记当前加载的插件，Bot 据此登记该插件注册的 express 路由与 WS 路径 */
    const prevLoading = (globalThis as any).__jiuliLoading
    ;(globalThis as any).__jiuliLoading = file.name
    try {
      const module: any = await import(file.path)
      const app = module.apps ? { ...module.apps } : module
      const pluginArray: any[] = []
      for (const key in app) pluginArray.push(this.loadPlugin(file, app[key]))
      for (const i of await Promise.allSettled(pluginArray))
        if (i?.status && i.status !== 'fulfilled') {
          success = false
          const info = this.describeLoadError(i.reason, file)
          util.makeLog('error', info.text, 'Plugin')
          util.makeLog('debug', [`${file.name} 加载失败详情`, i.reason], 'Plugin')
          if (packageErr && info.pkg) packageErr.push({ error: i.reason, file })
        }
    } catch (error: any) {
      success = false
      const info = this.describeLoadError(error, file)
      util.makeLog('error', info.text, 'Plugin')
      /** 堆栈只在 debug 级别出现，避免刷屏把后面的启动日志顶掉 */
      util.makeLog('debug', [`${file.name} 加载失败详情`, error], 'Plugin')
      if (packageErr && info.pkg) packageErr.push({ error, file })
      /** 插件目录自带 package.json 会断掉对 'jiuli' 的解析，给出修法 */
      if (String(error?.message).includes("Cannot find package 'jiuli'"))
        util.makeLog(
          'error',
          `        提示：${file.name} 所在目录有自己的 package.json，需在其中加 "jiuli": "link:../.."，再执行 pnpm install`,
          'Plugin',
        )
    } finally {
      ;(globalThis as any).__jiuliLoading = prevLoading
      /**
       * 加载成功但没有任何插件类（适配器 / 纯胶水文件）：#重载 时不必再导入。
       * 加载失败的**不能**记为惰性，否则修好后 #重载 会一直跳过它。
       */
      if (success && !this.pluginCountMap.get(file.name)) this.inertFiles.add(file.name)
      else if (!success) this.inertFiles.delete(file.name)
    }
    this.load_time[file.name] = Date.now() - start_time
    /** 加载阶段结束后才就绪（超过 plugin_load_timeout）：补进分发，省得用户手动重载 */
    if (success && this.loaded) this.lateAttach(file)
    return success
  }

  async loadPlugin(file: { name: string; path: string }, p: any) {
    if (!p?.prototype) return
    this.pluginCount++
    this.pluginCountMap.set(file.name, (this.pluginCountMap.get(file.name) ?? 0) + 1)

    const init = new p()
    /** 插件目录名，渲染/数据目录定位用 */
    init.__key = String(file.name).split('/')[0]
    this.initInstances.set(file.name, init)
    util.makeLog('debug', `加载插件 [${file.name}][${init.name}]`, 'Plugin')
    /** init() 返回 "return" 表示跳过加载 */
    if (init.init && (await init.init()) === 'return') return
    this.collectTask(init.task, init.name, file.name)
    const instance = init
    if (instance.rule)
      for (const i of instance.rule) {
        if (!(i.reg instanceof RegExp)) i.reg = new RegExp(i.reg)
        /** 预编译事件分段 */
        if (i.event) this.filtEvent(null, i)
      }

    const namespace = instance.namespace || file.name
    this.priority.push({
      plugin: instance,
      class: p,
      key: file.name,
      /** 旧插件可能没写 name，退化为类名 / 文件名，避免日志出现空名字 */
      name: instance.name || p.name || file.name,
      priority: instance.priority,
      namespace,
    })
    this.registerHandlers(instance, namespace)
  }

  registerHandlers(pluginInstance: any, namespace = pluginInstance.namespace) {
    if (!pluginInstance.handler) return
    const handlers = Array.isArray(pluginInstance.handler) ? pluginInstance.handler : [pluginInstance.handler]
    for (const { fn, key, priority } of handlers) {
      Handler.add({
        ns: namespace,
        key,
        self: pluginInstance,
        priority: priority ?? pluginInstance.priority,
        fn: pluginInstance[fn] ?? fn,
      })
    }
  }

  /** 缺依赖的汇总提示（单个插件的报错已在 importPlugin 里逐条给出） */
  packageTips(packageErr: any[]) {
    if (!packageErr.length) return
    const map = new Map<string, string[]>()
    for (const i of packageErr) {
      const name = String(i.error?.message).match(/Cannot find package '([^']+)'/)?.[1]
      if (!name) continue
      map.set(name, [...(map.get(name) || []), String(i.file.name)])
    }
    if (!map.size) return
    util.makeLog('error', `--------- 有 ${map.size} 个依赖没装 ---------`, 'Plugin')
    for (const [name, files] of map)
      util.makeLog('error', `${logger.red(name)} ← ${files.join(' · ')}`, 'Plugin')
    util.makeLog(
      'error',
      `安装：项目根目录 ${logger.red('pnpm i')}；或进入插件目录 ${logger.red('pnpm add <包名>')}，装完 ${logger.red('#重启')}`,
      'Plugin',
    )
    util.makeLog('error', '------------------------------------------', 'Plugin')
  }

  /* ==================== 分发 ==================== */

  /** 最近的消息记录（供 #诊断 排查"为什么没回复"） */
  recent = {
    receive: [] as Array<{ time: number; scene: string; content: string; matched: string }>,
    send: [] as Array<{ time: number; scene: string; content: string; plugin: string }>,
  }
  private pushRecent(list: any[], item: any) {
    list.push(item)
    if (list.length > 5) list.shift()
  }

  async deal(e: JiuLiEvent) {
    this.pushCount(e, 'receive', e.message)
    if (!this.checkBlack(e)) return
    const groupCfg = cfg.getGroup(e.self_id, e.group_id)
    if (!this.checkLimit(e, groupCfg)) return
    this.dealEvent(e, groupCfg)
    if (e.only_reply_at) this.setLimit(e, groupCfg)
    this.reply(e)
    if (cfg.getCompat().runtime !== false) Runtime.attach(e)

    /** 日志关闭或等级不足时不做任何字符串拼接 */
    const scene = util.describeScene(e)
    const msgLength = Number(cfg.bot.log_msg_length ?? 60)
    const logMsg = cfg.bot.log_msg !== false && util.isLogLevelEnabled('info')
    if (logMsg && e.msg !== undefined)
      util.makeLog(
        'info',
        `收 ◀ ${util.describeScene(e, true)} · ${logger.yellow(
          e.msg ? util.truncate(e.msg, msgLength) : util.describeMsg(e.message),
        )}`,
        'Msg',
      )
    const recentItem = {
      time: Date.now(),
      scene,
      content: e.msg ? util.truncate(e.msg, msgLength) : util.describeMsg(e.message),
      matched: '',
    }
    this.pushRecent(this.recent.receive, recentItem)

    const priority: PluginEntry[] = []
    for (const i of this.candidates(e)) {
      if (this.checkDisable({ plugin: i.plugin, e }, groupCfg) && this.filtEvent(e, i.plugin)) priority.push(i)
    }

    /** 单实例分发时的实例缓存 */
    const onceInstance = cfg.getPerf().once_instance !== false
    const instanceCache = new Map<PluginEntry, any>()
    const createInstance = (entry: PluginEntry) =>
      Object.assign(new entry.class(e), { e, __key: String(entry.key).split('/')[0] })
    const getInstance = (entry: PluginEntry) => {
      if (!onceInstance) return createInstance(entry)
      let instance = instanceCache.get(entry)
      if (!instance) {
        instance = createInstance(entry)
        instanceCache.set(entry, instance)
      }
      return instance
    }

    for (const i of priority) {
      if (!i.plugin.getContext) continue
      /** 探针对象，仅为取 conKey（插件名 + 事件），避免为每个插件实例化 */
      const probe = Object.create(i.class.prototype)
      probe.name = i.plugin.name
      probe.e = e
      const context = {
        ...probe.getContext(),
        ...probe.getContext(false, true),
      }
      if (!isEmptyObject(context)) {
        let ret
        for (const fnc in context) {
          util.makeLog('debug', `上下文命中 ${i.name} <${i.key}> · ${fnc}`, 'Plugin')
          ret ||= await getInstance(i)[fnc](context[fnc])
        }
        if (ret === 'continue') continue
        return
      }
    }

    if (!e.only_reply_at) return

    Object.defineProperty(e, 'isSr', {
      get: () => e.game === 'sr',
      set: (v: boolean) => (e.game = v ? 'sr' : 'gs'),
      configurable: true,
    })
    Object.defineProperty(e, 'isGs', {
      get: () => e.game === 'gs',
      set: (v: boolean) => (e.game = v ? 'gs' : 'sr'),
      configurable: true,
    })
    if (this.srReg.test(String(e.msg))) {
      e.game = 'sr'
      e.msg = String(e.msg).replace(this.srReg, '#星铁')
    } else if (this.zzzReg.test(String(e.msg))) {
      e.game = 'zzz'
      e.msg = String(e.msg).replace(this.zzzReg, '#绝区零')
    }

    /** 原生插件钩子：分发前，任一 beforeMessage 返回 false 即拦截本次分发 */
    if (!(await this.runHooks(e, priority, 'beforeMessage'))) return
    try {
      for (const i of priority)
        if (i.plugin.accept) {
          const res = await getInstance(i).accept(e)
          if (res === 'return') {
            util.makeLog('info', `${i.name} <${i.key}> · accept 终止分发`, 'Plugin')
            return
          }
          if (res) {
            util.makeLog('info', `${i.name} <${i.key}> · accept 命中`, 'Plugin')
            break
          }
        }

      /** 记录"命中指令规则但无插件响应"的情况，用于最后给出提示 */
      const commandMatched: string[] = []
      for (const i of priority) {
        if (!i.plugin.rule) continue
        for (const v of i.plugin.rule) {
          if (v.event && !this.filtEvent(e, v)) continue

          const regStr = String(v.reg)
          if (!(v.reg as RegExp).test(String(e.msg))) continue

          const instance = getInstance(i)
          const fncName = typeof v.fnc === 'string' ? v.fnc : v.fnc.name || 'fnc'
          e.logFnc = `${logger.blue(`[${i.name}(${fncName})]`)}`
          util.markPlugin(e, i.name, i.key)
          recentItem.matched = `${i.name} <${i.key}> → ${fncName}`
          /** 指令型规则（不匹配空串）才算"用户想执行指令" */
          if (!(v.reg as RegExp).test('')) commandMatched.push(`${i.name}`)

          util.makeLog(
            v.log === false ? 'debug' : 'info',
            `中 ▶ ${logger.green.bold(i.name)} ${logger.gray(`<${i.key}>`)} · 规则 ${logger.gray(regStr)} · 方法 ${logger.cyan(
              fncName,
            )} · 优先级 ${i.priority}`,
            'Plugin',
          )

          if (!this.filtPermission(e, v))
            util.makeLog('info', `${i.name} · 权限不足（需要 ${v.permission}）`, 'Plugin')
          else
            try {
              const startTime = Date.now()
              /** 绑定到插件实例，保持与云崽一致的 this 语义 */
              const fn =
                typeof v.fnc === 'function' ? v.fnc.bind(instance) : instance[v.fnc]?.bind(instance)
              const res = fn && (await fn(e, (v.reg as RegExp).exec(String(e.msg)) || undefined))
              const cost = Date.now() - startTime
              metrics.record(i, cost)

              if (res === false) {
                util.makeLog(
                  v.log === false ? 'debug' : 'mark',
                  `${logger.green.bold(i.name)} · 返回 false，继续匹配后续规则 · ${util.colorCost(cost)}`,
                  'Plugin',
                )
                continue
              }
              util.makeLog(
                v.log === false ? 'debug' : 'mark',
                `完成 ${logger.green.bold(i.name)} · ${util.colorCost(cost)}`,
                'Plugin',
              )
            } catch (err) {
              util.makeLog(
                'error',
                util.describeError(
                  err,
                  `执行出错 ${logger.green.bold(i.name)} <${i.key}>`,
                  '插件自身的问题：本次指令未完成，其他插件与启动都不受影响（完整堆栈：log_level: debug）',
                ),
                'Plugin',
              )
              util.makeLog('debug', [`${i.name} 出错堆栈`, err], 'Plugin')
            }
          return
        }
      }

      if (util.isLogLevelEnabled('debug'))
        util.makeLog('debug', `未命中插件 · ${scene} · ${util.truncate(e.msg || util.describeMsg(e.message))}`, 'Msg')

      /**
       * 命中指令型规则却无插件响应时提示一次，避免静默无响应被误认为框架故障
       */
      if (
        commandMatched.length &&
        !e.__replied &&
        cfg.bot.no_handler_tip !== false &&
        e.message &&
        e.msg
      ) {
        const key = `${e.self_id}.${e.user_id}`
        const now = Date.now()
        if (!this.hintThrottle[key] || now - this.hintThrottle[key] > 10000) {
          this.hintThrottle[key] = now
          const tip = e.isMaster
            ? `这条指令没有被执行（参数或触发条件不符）· 可发 #插件列表 查看可用指令`
            : `这条指令没有响应 · 如果它是主人专属指令，请先发 #设置主人 绑定主人账号；也可能是参数不符`
          util.makeLog('info', `提示无响应 · ${util.truncate(e.msg, 20)} · 命中 ${commandMatched.join('/')}`, 'Msg')
          /** 提示由框架发出，避免日志错误归属到最后一个匹配到的插件 */
          e.logPlugin = 'JiuLi'
          await e.reply?.(tip)
        }
      }
  
    } finally {
      /** 原生插件钩子：分发后，无论是否命中都会执行 */
      await this.runHooks(e, priority, 'afterMessage')
    }
  }

  /** 同一用户 10 秒内只提示一次"无响应" */
  private hintThrottle: Record<string, number> = {}

  /**
   * 执行原生插件钩子（beforeMessage / afterMessage）
   * 类形态定义同名方法即可；DSL 形态的 beforeMessage(fn) / afterMessage(fn) 会绑定为同名方法
   */
  private async runHooks(e: JiuLiEvent, entries: PluginEntry[], name: 'beforeMessage' | 'afterMessage') {
    for (const entry of entries) {
      const fn = entry.plugin?.[name]
      if (typeof fn !== 'function') continue
      try {
        const ret = await fn.call(Object.assign(Object.create(entry.class.prototype), entry.plugin), e)
        if (name === 'beforeMessage' && ret === false) {
          util.makeLog('debug', `${entry.name} <${entry.key}> · beforeMessage 拦截`, 'Plugin')
          return false
        }
      } catch (err) {
        util.makeLog(
          'error',
          util.describeError(
            err,
            `${name} 出错 ${logger.green.bold(entry.name)} <${entry.key}>`,
            '插件自身的问题：本次事件的分发已跳过该插件，其他插件不受影响',
          ),
          'Plugin',
        )
        util.makeLog('debug', [`${entry.name} 出错堆栈`, err], 'Plugin')
      }
    }
    return true
  }

  /** 事件表达式与实际事件逐段比对，支持 * 通配 */
  filtEvent(e: JiuLiEvent | null, v: any) {
    if (!v.event) return false
    let cache = this.eventCache.get(v)
    if (!cache || cache.source !== v.event) {
      cache = { source: v.event, event: String(v.event).split('.') }
      this.eventCache.set(v, cache)
    }
    /** 预编译阶段（e 为空）只建立缓存 */
    if (!e) return false

    const eventMap = this.eventMap[e.post_type] || []
    const mappedEvent = cache.event.map((value, i) => (value === '*' ? value : e[eventMap[i]]))
    return v.event === mappedEvent.join('.')
  }

  /** 权限检查；master/owner/admin 校验失败时直接回复用户 */
  filtPermission(e: JiuLiEvent, v: any) {
    if (!v.permission || e.isMaster) return true

    if (v.permission === 'master') {
      e.reply?.('没有权限哦，只有主人才可以使用！')
      return false
    }

    if (e.isGroup) {
      if (v.permission === 'owner' && !e.member?.is_owner) {
        e.reply?.('没有权限哦，只有群主才可以使用！')
        return false
      }
      if (v.permission === 'admin' && !e.member?.is_owner && !e.member?.is_admin) {
        e.reply?.('没有权限哦，只有群管理员才可以使用！')
        return false
      }
    }

    return true
  }

  dealText(text = '') {
    if (cfg.bot['/→#']) text = text.replace(/^\s*\/\s*/, '#')
    return text
      .replace(/^\s*[＃井]\s*/, '#')
      .replace(/^\s*[＊※]\s*/, '*')
      .trim()
  }

  /** 解析消息，补齐 e.msg / e.img / e.isGroup / e.isMaster 等派生字段 */
  dealEvent(e: JiuLiEvent, groupCfg?: any) {
    if (e.message)
      for (const i of e.message) {
        switch (i.type) {
          case 'text':
            e.msg = (e.msg || '') + this.dealText(i.text as string)
            break
          case 'image':
            if (Array.isArray(e.img)) e.img.push(i.url as string)
            else e.img = [i.url as string]
            break
          case 'at':
            if (i.qq == e.self_id) e.atBot = true
            else e.at = i.qq as any
            break
          case 'reply':
            e.reply_id = i.id as any
            if (e.group?.getMsg) e.getReply = () => e.group.getMsg(e.reply_id)
            else if (e.friend?.getMsg) e.getReply = () => e.friend.getMsg(e.reply_id)
            break
          case 'file':
            e.file = i
            break
          case 'xml':
          case 'json':
            e.msg = (e.msg || '') + (typeof i.data === 'string' ? i.data : JSON.stringify(i.data))
            break
        }
      }

    e.logText = ''
    if (e.sender) e.sender.card ||= e.sender.nickname
    if (e.message_type === 'private' || e.notice_type === 'friend') {
      e.isPrivate = true
      e.logText = `[${e.sender?.nickname ? `${e.sender.nickname}(${e.user_id})` : e.user_id}]`

      if (!e.recall && e.message_id && e.friend?.recallMsg) e.recall = e.friend.recallMsg.bind(e.friend, e.message_id)
    } else if (e.message_type === 'group' || e.notice_type === 'group') {
      e.isGroup = true
      e.logText = `[${e.group_name ? `${e.group_name}(${e.group_id})` : e.group_id}, ${
        e.sender?.card ? `${e.sender.card}(${e.user_id})` : e.user_id
      }]`

      if (!e.recall && e.message_id && e.group?.recallMsg) e.recall = e.group.recallMsg.bind(e.group, e.message_id)
    }

    e.logText = `${logger.cyan(e.logText)}${logger.red(`[${truncate(String(e.msg || e.raw_message || util.String(e)), 100)}]`)}`

    if (e.user_id && cfg.master[e.self_id]?.includes(String(e.user_id))) e.isMaster = true

    /** 群聊未 at 机器人时，剥掉消息开头的 bot 别名并标记 hasAlias */
    if (e.msg && e.isGroup && !e.atBot) {
      groupCfg ||= cfg.getGroup(e.self_id, e.group_id)
      const alias = groupCfg.botAlias
      for (const i of Array.isArray(alias) ? alias : [alias])
        if (i && e.msg.startsWith(i)) {
          e.msg = e.msg.replace(i, '')
          e.hasAlias = true
          break
        }
    }

    e.only_reply_at = this.onlyReplyAt(e, groupCfg)
  }

  /** 包装 e.reply：拼装 at/引用、记录发送日志，并在失败时捕获异常 */
  reply(e: JiuLiEvent) {
    if (!e.reply?.bind) return
    const reply = e.reply.bind(e)

    e.reply = async (msg: any = '', quote = false, data: any = {}) => {
      if (!msg) return false

      let { recallMsg = 0, at = '' } = data
      const segment = (globalThis as any).segment

      if (at && e.isGroup) {
        if (at === true) at = e.user_id as any
        if (Array.isArray(msg)) msg.unshift(segment.at(at), '\n')
        else msg = [segment.at(at), '\n', msg]
      }

      if (quote && e.message_id) {
        if (Array.isArray(msg)) msg.unshift(segment.reply(e.message_id))
        else msg = [segment.reply(e.message_id), msg]
      }

      let res
      const sendStart = Date.now()
      try {
        res = await reply(msg)
      } catch (err) {
        util.makeLog('error', ['发送消息错误', msg, err], e.self_id)
        res = { error: [err] }
      }

      /** 日志用带色目标，最近消息记录用无色的 targetPlain */
      const targetPlain =
        e.isGroup || e.group_id ? `群 ${e.group_name || ''}(${e.group_id})` : `好友 ${e.user_id}`
      const target = e.isGroup || e.group_id
        ? `群 ${logger.cyan(e.group_name || '')}(${logger.cyan(e.group_id)})`
        : `好友 ${logger.magenta(e.user_id)}`
      const content = util.describeMsg(msg)
      const byPlugin = e.logPlugin ? ` · 由 ${logger.green.bold(e.logPlugin)}` : ''
      const cost = Date.now() - sendStart
      const failed = hasSendError(res)
      const failReason = failed ? util.truncate(describeSendError(res), 120) : ''
      util.makeLog(
        failed ? 'error' : 'info',
        `发 ${failed ? '✖' : '▶'} ${target} · ${logger.yellow(content)}${byPlugin} · ${util.colorCost(cost)}${
          failed ? ` · 发送失败：${failReason}` : ''
        }`,
        'Msg',
      )
      this.pushRecent(this.recent.send, {
        time: Date.now(),
        scene: targetPlain,
        content,
        plugin: e.logPlugin || '',
      })
      /** 标记本事件已有回复，供"无响应"提示判断 */
      e.__replied = true

      if (recallMsg > 0 && res?.message_id) {
        if (e.group?.recallMsg)
          setTimeout(() => {
            e.group.recallMsg(res.message_id)
            if (e.message_id) e.group.recallMsg(e.message_id)
          }, recallMsg * 1000)
        else if (e.friend?.recallMsg)
          setTimeout(() => {
            e.friend.recallMsg(res.message_id)
            if (e.message_id) e.friend.recallMsg(e.message_id)
          }, recallMsg * 1000)
      }

      this.pushCount(e, 'send', msg)
      return res
    }
  }

  /* ==================== 计数（批量写回） ==================== */

  private pushCount(e: JiuLiEvent, type: string, msg?: any) {
    const buf = this.countBuffer
    const add = (key: string, value = 1) => buf.set(key, (buf.get(key) || 0) + value)

    const items: Array<[string, number]> = [[`${type}:msg`, 1]]
    if (cfg.bot.msg_type_count)
      for (const i of Array.isArray(msg) ? msg : [msg]) items.push([`${type}:${i?.type || 'text'}`, 1])

    const now = moment()
    const stamps = [now.format('YYYY:MM:DD'), now.format('YYYY:MM'), now.format('YYYY'), 'total']
    for (const [kind, value] of items)
      for (const stamp of stamps) {
        add(`Yz:count:${kind}:total:${stamp}`, value)
        if (e.self_id) add(`Yz:count:${kind}:bot:${e.self_id}:${stamp}`, value)
        if (e.user_id) add(`Yz:count:${kind}:user:${e.user_id}:${stamp}`, value)
        if (e.group_id) add(`Yz:count:${kind}:group:${e.group_id}:${stamp}`, value)
      }

    const flushMs = Number(cfg.getPerf().count_flush_ms ?? 1000)
    if (!flushMs) return this.flushCount()
    if (!this.countTimer) {
      this.countTimer = setTimeout(() => {
        this.countTimer = undefined
        this.flushCount().catch(() => {})
      }, flushMs)
      this.countTimer.unref?.()
    }
  }

  async flushCount() {
    if (!this.countBuffer.size) return
    const redis = (globalThis as any).redis
    if (!redis) return
    const buffer = this.countBuffer
    this.countBuffer = new Map()
    try {
      const multi = redis.multi()
      for (const [key, value] of buffer) multi.incrBy(key, value)
      await multi.exec()
    } catch (err) {
      util.makeLog('error', ['写入消息计数错误', err], 'Count')
    }
  }

  async saveCount(e: JiuLiEvent, type: string) {
    this.pushCount(e, type)
    return true
  }

  /* ==================== 定时任务 ==================== */

  collectTask(task: any, name: string, key: string) {
    let tasks: Set<any> | undefined
    if (key) {
      tasks = this.taskMap.get(key) ?? new Set()
      this.taskMap.set(key, tasks)
    }
    for (const i of Array.isArray(task) ? task : [task])
      if (i?.cron && i?.fnc) {
        i.name ??= name
        this.task.push(i)
        tasks?.add(i)
      }
  }

  async startTask(name: string, i: any) {
    try {
      const start_time = Date.now()
      util.makeLog(i.log === false ? 'debug' : 'mark', `${name}${logger.yellow('[开始处理]')}`, false)
      const fn = typeof i.fnc === 'function' ? i.fnc.bind(i.self ?? i) : i.self?.[i.fnc] ?? i.fnc
      await fn()
      util.makeLog(i.log === false ? 'debug' : 'mark', `${name}${logger.green(`[完成${util.getTimeDiff(start_time)}]`)}`, false)
    } catch (err) {
      util.makeLog('error', util.describeError(err, `定时任务出错 ${logger.green.bold(name)}`, '该任务的这次执行中断；完整堆栈见 debug 日志'), 'Task')
      util.makeLog('debug', [`${name} 任务堆栈`, err], 'Task')
    }
  }

  createTask() {
    const created = new Set()
    for (const i of this.task) {
      if (i.job?.cancel) i.job.cancel()
      const name = `${logger.blue(`[${i.name}(${i.cron})]`)}`
      if (created.has(name)) {
        util.makeLog('warn', `重复定时任务 ${name} 已跳过`, 'Task')
        continue
      }
      created.add(name)
      util.makeLog('debug', `加载定时任务 ${name}`, 'Task')
      i.job = schedule.scheduleJob(String(i.cron).split(/\s+/).slice(0, 6).join(' '), this.startTask.bind(this, name, i))
    }
  }

  /* ==================== 过滤/冷却 ==================== */

  checkLimit(e: JiuLiEvent, config?: any) {
    if (e.group && (e.group.mute_left > 0 || (e.group.all_muted && !e.group.is_admin && !e.group.is_owner)))
      return false
    if (!e.message || e.isPrivate) return true

    config ||= cfg.getGroup(e.self_id, e.group_id)

    if (config.groupCD && this.groupCD[e.group_id as any]) return false
    if (config.singleCD && this.singleCD[`${e.group_id}.${e.user_id}`]) return false

    /** 同一用户同一消息 1s 内只处理一次 */
    const msgId = `${e.self_id}:${e.user_id}:${e.raw_message}`
    if (this.msgThrottle[msgId]) return false

    this.msgThrottle[msgId] = true
    setTimeout(() => delete this.msgThrottle[msgId], 1000).unref?.()

    return true
  }

  setLimit(e: JiuLiEvent, config?: any) {
    if (e.isPrivate) return
    config ||= cfg.getGroup(e.self_id, e.group_id)

    if (config.groupCD) {
      this.groupCD[e.group_id as any] = true
      setTimeout(() => delete this.groupCD[e.group_id as any], config.groupCD).unref?.()
    }
    if (config.singleCD) {
      const key = `${e.group_id}.${e.user_id}`
      this.singleCD[key] = true
      setTimeout(() => delete this.singleCD[key], config.singleCD).unref?.()
    }
  }

  onlyReplyAt(e: JiuLiEvent, groupCfg?: any) {
    if (!e.message || e.isPrivate) return true

    groupCfg ||= cfg.getGroup(e.self_id, e.group_id)

    /** 模式0，未开启前缀 */
    if (groupCfg.onlyReplyAt === 0 || !groupCfg.botAlias) return true
    /** 模式2，非主人开启 */
    if (groupCfg.onlyReplyAt === 2 && e.isMaster) return true
    /** at机器人 */
    if (e.atBot) return true
    /** 消息带前缀 */
    if (e.hasAlias) return true

    return false
  }

  /** 命中 other 中的黑名单即拦截；白名单存在时未命中即拦截 */
  checkBlack(e: JiuLiEvent) {
    const other = cfg.getOther()

    if (other.blackUser?.length && other.blackUser.includes(Number(e.user_id) || String(e.user_id))) return false
    if (other.whiteUser?.length && !other.whiteUser.includes(Number(e.user_id) || String(e.user_id))) return false

    if (e.group_id) {
      if (other.blackGroup?.length && other.blackGroup.includes(Number(e.group_id) || String(e.group_id))) return false
      if (other.whiteGroup?.length && !other.whiteGroup.includes(Number(e.group_id) || String(e.group_id))) return false
    }

    return true
  }

  /** groupCfg 的 disable 列表命中即禁用；enable 列表存在时不在其中即禁用 */
  checkDisable(p: { plugin: any; e: JiuLiEvent }, groupCfg?: any) {
    groupCfg ||= cfg.getGroup(p.e.self_id, p.e.group_id)
    if (groupCfg.disable?.length && groupCfg.disable.includes(p.plugin.name)) return false
    if (groupCfg.enable?.length && !groupCfg.enable.includes(p.plugin.name)) return false
    return true
  }

  /* ==================== 卸载/热重载 ==================== */

  async unloadPlugin(key: string, closeWatcher = false) {
    /** 插件的清理回调（定时器、连接等） */
    const initInstance = this.initInstances.get(key)
    if (typeof initInstance?.onUnload === 'function')
      try {
        await initInstance.onUnload()
      } catch (err) {
        util.makeLog('error', util.describeError(err, `onUnload 出错 ${logger.green.bold(key)}`, '清理资源的代码有问题；热重载仍会继续'), 'Plugin')
        util.makeLog('debug', [`${key} onUnload 堆栈`, err], 'Plugin')
      }
    this.initInstances.delete(key)

    /** 清理插件注册的 express 路由与 WS 路径（热重载不重复注册） */
    ;(globalThis as any).Bot?.cleanupPluginResources?.(key)

    const entries = this.priority.filter(i => i.key === key)
    const namespaces = new Set(entries.map(i => i.namespace || i.plugin.namespace || key))
    for (const ns of namespaces) Handler.del(ns)

    const tasks = this.taskMap.get(key)
    if (tasks) {
      for (const i of tasks) i.job?.cancel?.()
      this.task = this.task.filter(i => !tasks.has(i))
      this.taskMap.delete(key)
    }

    this.priority = this.priority.filter(i => i.key !== key)
    const pluginCount = this.pluginCountMap.get(key) ?? entries.length
    if (typeof this.pluginCount === 'number') this.pluginCount = Math.max(0, this.pluginCount - pluginCount)
    this.pluginCountMap.delete(key)
    delete this.load_time[key]
    this.buildEventIndex()
    metrics.remove(key)

    if (closeWatcher) {
      const watcherKey = key.replace('/', '.')
      const watcher = this.watcher[watcherKey]
      if (watcher) {
        ;(watcher as any).changeHandler?.cancel?.()
        ;(watcher as any).unlinkHandler?.cancel?.()
        await Promise.resolve(watcher.close?.()).catch(() => {})
        delete this.watcher[watcherKey]
      }
    }
  }

  async changePlugin(key: string) {
    const oldPriority = this.priority.filter(i => i.key === key)
    const oldTasks = this.taskMap.get(key)
    const oldPluginFileCount = this.pluginCountMap.get(key)
    const oldLoadTime = this.load_time[key]
    const oldPluginCount = this.pluginCount
    try {
      await this.unloadPlugin(key)
      /** 目录型插件需指向 index.js，Node 不支持目录 import */
      const target = key.endsWith('.js') ? key : `${key}/index.js`
      const success = await this.importPlugin({
        name: key,
        path: `../../${this.dir}/${target}?${moment().format('x')}`,
      })
      if (!success) {
        await this.unloadPlugin(key)
        this.priority.push(...oldPriority)
        if (oldTasks) {
          const tasks = [...oldTasks]
          this.task.push(...tasks)
          this.taskMap.set(key, new Set(tasks))
        }
        if (oldLoadTime !== undefined) this.load_time[key] = oldLoadTime
        this.pluginCount = oldPluginCount
        if (oldPluginFileCount !== undefined) this.pluginCountMap.set(key, oldPluginFileCount)
        for (const i of oldPriority) this.registerHandlers(i.plugin, i.namespace || key)
      }
      this.priority.sort((a, b) => a.priority - b.priority)
      this.buildEventIndex()
      this.createTask()
      return success
    } catch (err) {
      util.makeLog('error', this.describeLoadError(err, { name: key }).text, 'Plugin')
      util.makeLog('debug', [`${key} 重载失败详情`, err], 'Plugin')
      return false
    }
  }

  /* ==================== 热重载 ==================== */

  /** plugins/ 下的相对路径 → 插件 key，命名与 getPlugins 保持一致 */
  private keyOf(rel: string): string | null {
    const parts = rel.split('/')
    if (parts.length < 2) return null
    if (parts.length === 2) return parts[1] === 'index.js' ? parts[0] : rel
    /** apps/ 等更深层的文件归属到其插件目录 */
    return parts[0]
  }

  /** 适配器 / 胶水文件（无插件类） */
  isInert(key: string) {
    return this.inertFiles.has(key)
  }

  private isLoaded(key: string) {
    return this.pluginCountMap.has(key) || this.priority.some(i => i.key === key)
  }

  /** 按 key 加载；已加载则重载 */
  async reloadKey(key: string) {
    if (this.isLoaded(key)) return this.changePlugin(key)
    return this.loadKey(key)
  }

  private async loadKey(key: string) {
    const target = key.endsWith('.js') ? key : `${key}/index.js`
    await this.importPlugin({ name: key, path: `../../${this.dir}/${target}?${Date.now()}` })
    this.priority.sort((a, b) => a.priority - b.priority)
    this.buildEventIndex()
    this.createTask()
  }

  /**
   * 监听整个 plugins/ 目录：新增 js 自动加载、修改自动重载、删除自动卸载
   * 非 js 资源变化不触发重载（渲染层自带缓存失效）
   */
  watchPlugins() {
    if (this.watcher['#root']) return
    const root = `./${this.dir}`
    /** 忽略 node_modules/.git：clone 第三方插件时避免扫描上万文件导致重载风暴 */
    const watcher = chokidar.watch(root, {
      depth: 4,
      ignoreInitial: true,
      ignored: [/[\\/]node_modules[\\/]/, /[\\/]\.git[\\/]/, /[\\/]\.git$/, /[\\/]temp[\\/]/],
    })
    const Bot = (globalThis as any).Bot

    const relOf = (file: string) => path.relative(path.resolve(root), path.resolve(file)).replace(/\\/g, '/')

    const handle = (action: 'add' | 'change' | 'unlink') =>
      util.debounce(async (file: string) => {
        const rel = relOf(file)
        if (!rel || rel.startsWith('..')) return
        if (!rel.endsWith('.js')) {
          if (action === 'change') util.makeLog('debug', `资源变化（无需重载）· ${rel}`, 'Plugin')
          return
        }
        const key = this.keyOf(rel)
        if (!key) return

        if (action === 'unlink') {
          if (!this.isLoaded(key)) return
          util.makeLog('mark', `插件已删除 → 卸载 · ${logger.cyan(rel)}`, 'Plugin')
          await this.unloadPlugin(key)
          return
        }

        const loaded = this.isLoaded(key)
        util.makeLog(
          'mark',
          `插件${action === 'add' ? '新增' : '修改'} → ${loaded ? '重载' : '加载'} · ${logger.cyan(rel)}`,
          'Plugin',
        )
        if (loaded) await this.changePlugin(key)
        else await this.loadKey(key)
      }, 2000)

    Bot.once('online', () => {
      watcher.on('add', handle('add'))
      watcher.on('change', handle('change'))
      watcher.on('unlink', handle('unlink'))
      watcher.on(
        'addDir',
        util.debounce(async (dir: string) => {
          const rel = relOf(dir)
          if (!rel || rel.startsWith('..') || rel.includes('/')) return
          util.makeLog('debug', `检测到新插件目录 · ${rel}（放入 .js 文件后自动加载）`, 'Plugin')
        }, 2000) as any,
      )
      util.makeLog('info', '热重载已开启（plugins/ 下新增 / 修改 / 删除 js 即时生效）', 'Plugin')
    })
    this.watcher['#root'] = watcher
  }

  /** 兼容旧调用 */
  watch() {
    this.watchPlugins()
  }

  /** closeWatchers：file_watch=false 时改由 config 用 NullWatcher 接管 */
  closeWatchers() {
    for (const i in this.watcher) {
      this.watcher[i]?.close?.()
      delete this.watcher[i]
    }
  }
}

export default new PluginsLoader()
export { PluginsLoader }
