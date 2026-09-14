/**
 * 插件加载 + 消息分发
 *
 * 相对 TRSS-Yunzai 的改进（保持语义不变）：
 * 1. 事件索引：按插件 event 的第一段（post_type）分桶，避免每条消息全量遍历插件
 * 2. 单实例分发：accept 与 rule 复用同一插件实例（可在 config/jiuli.yaml 关闭）
 * 3. 消息计数改为内存聚合 + 定时批量写回（默认 1s，0 则实时）
 * 4. 插件耗时统计（慢插件日志 + #性能 指令数据）
 * 5. 加载失败回滚、任务去重、热重载逻辑保持与云崽一致
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

/** 全局变量兼容 */
;(globalThis as any).plugin = plugin

/** 简易 truncate（避免核心依赖 lodash） */
function truncate(str: string, length: number) {
  if (!str) return ''
  return str.length > length ? `${str.slice(0, length)}...` : str
}

function isEmptyObject(obj: any) {
  if (!obj) return true
  for (const _ in obj) return false
  return true
}

class PluginsLoader {
  /** 分发列表（赋值时会重建事件索引，兼容插件直接替换 priority 的用法） */
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
  dir = 'plugins'

  /** 事件索引：post_type → 插件条目 */
  eventIndex = new Map<string, PluginEntry[]>()
  /** 命令冷却cd */
  groupCD: Record<string, boolean> = {}
  singleCD: Record<string, boolean> = {}
  /** 消息去重（1s） */
  msgThrottle: Record<string, boolean> = {}

  /** 插件监听 */
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

  /** 计数缓冲（内存聚合 + 定时写回） */
  private countBuffer = new Map<string, number>()
  private countTimer?: NodeJS.Timeout

  async getPlugins() {
    const files = await fs.readdir(this.dir, { withFileTypes: true }).catch(() => [] as any[])
    const ret: Array<{ name: string; path: string }> = []
    for (const val of files) {
      if (!val.isDirectory()) continue
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
        this.watch(val.name, app.name)
      }
    }
    return ret
  }

  /** 加载（isRefresh 时先卸载再加载） */
  async load(isRefresh = false) {
    if (isRefresh) {
      const keys = new Set([...this.priority.map(i => i.key), ...this.taskMap.keys(), ...this.pluginCountMap.keys()])
      for (const key of keys) await this.unloadPlugin(key)
    }
    if (this.priority.length) return

    util.makeLog('info', '-----------', 'Plugin')
    util.makeLog('info', '加载插件中...', 'Plugin')

    const files = await this.getPlugins()
    this.pluginCount = 0
    const packageErr: any[] = []

    await Promise.allSettled(
      files.map(async file => {
        if ((await util.sleep(cfg.bot.plugin_load_timeout * 1000, this.importPlugin(file, packageErr))) === util.sleepTimeout)
          util.makeLog('error', `插件加载超时 ${logger.red(file.name)}`, 'Plugin')
      }),
    )

    this.packageTips(packageErr)
    this.createTask()
    this.buildEventIndex()

    util.makeLog('info', `加载定时任务[${this.task.length}个]`, 'Plugin')
    util.makeLog('info', `加载插件[${this.pluginCount}个]`, 'Plugin')

    /** 优先级排序 */
    this.priority.sort((a, b) => a.priority - b.priority)
  }

  /** 构建事件索引 */
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

  /** 候选插件：事件索引 + 通配桶 */
  private candidates(e: JiuLiEvent) {
    if (cfg.getPerf().event_index === false) return this.priority
    const index = this.eventIndex
    const list = index.get(e.post_type)
    const wild = index.get('*')
    if (!list) return wild ? [...wild] : []
    if (!wild) return list
    return [...list, ...wild]
  }

  async importPlugin(file: { name: string; path: string }, packageErr?: any[]) {
    const start_time = Date.now()
    let success = true
    this.pluginCountMap.set(file.name, 0)
    try {
      const module: any = await import(file.path)
      const app = module.apps ? { ...module.apps } : module
      const pluginArray: any[] = []
      for (const key in app) pluginArray.push(this.loadPlugin(file, app[key]))
      for (const i of await Promise.allSettled(pluginArray))
        if (i?.status && i.status !== 'fulfilled') {
          success = false
          util.makeLog('error', [`插件加载错误 ${logger.red(file.name)}`, i], 'Plugin')
        }
    } catch (error: any) {
      success = false
      if (packageErr && String(error?.stack).includes('Cannot find package')) {
        packageErr.push({ error, file })
      } else {
        util.makeLog('error', [`插件加载错误 ${logger.red(file.name)}`, error], 'Plugin')
      }
    }
    this.load_time[file.name] = Date.now() - start_time
    return success
  }

  async loadPlugin(file: { name: string; path: string }, p: any) {
    if (!p?.prototype) return
    this.pluginCount++
    this.pluginCountMap.set(file.name, (this.pluginCountMap.get(file.name) ?? 0) + 1)

    /** 初始化、定时任务实例 */
    const init = new p()
    /** 插件目录名（渲染/数据目录定位用） */
    init.__key = String(file.name).split('/')[0]
    util.makeLog('debug', `加载插件 [${file.name}][${init.name}]`, 'Plugin')
    /** 执行初始化，返回 return 则跳过加载 */
    if (init.init && (await init.init()) === 'return') return
    /** 设置定时任务 */
    this.collectTask(init.task, init.name, file.name)
    /** 处理消息实例（用于规则初始化） */
    const instance = init
    /** 初始化正则表达式 */
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
      name: instance.name,
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

  packageTips(packageErr: any[]) {
    if (!packageErr.length) return
    util.makeLog('error', '--------- 插件加载错误 ---------', 'Plugin')
    for (const i of packageErr) {
      const pack = String(i.error.stack).match(/'(.+?)'/g)?.[0]?.replace(/'/g, '') || '未知依赖'
      util.makeLog('error', `${logger.cyan(i.file.name)} 缺少依赖 ${logger.red(pack)}`, 'Plugin')
    }
    util.makeLog('error', `安装插件后请 ${logger.red('pnpm i')} 安装依赖`, 'Plugin')
    util.makeLog('error', `仍报错${logger.red('进入插件目录')} pnpm add 依赖`, 'Plugin')
    util.makeLog('error', '--------------------------------', 'Plugin')
  }

  /* ==================== 分发 ==================== */

  async deal(e: JiuLiEvent) {
    this.pushCount(e, 'receive', e.message)
    /** 检查黑白名单 */
    if (!this.checkBlack(e)) return
    const groupCfg = cfg.getGroup(e.self_id, e.group_id)
    /** 冷却 */
    if (!this.checkLimit(e, groupCfg)) return
    /** 处理事件 */
    this.dealEvent(e, groupCfg)
    /** 设置冷却 */
    if (e.only_reply_at) this.setLimit(e, groupCfg)
    /** 处理回复 */
    this.reply(e)
    /** 注册 runtime（轻量挂载，重活懒加载） */
    if (cfg.getCompat().runtime !== false) Runtime.attach(e)

    /** 候选插件 */
    const priority: PluginEntry[] = []
    for (const i of this.candidates(e)) {
      if (this.checkDisable({ plugin: i.plugin, e }, groupCfg) && this.filtEvent(e, i.plugin)) priority.push(i)
    }

    /** 实例缓存（单实例分发） */
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
      /** 上下文 hook */
      if (!i.plugin.getContext) continue
      /** 探针对象：只为拿到 conKey（插件名 + 事件），避免为每个插件实例化 */
      const probe = Object.create(i.class.prototype)
      probe.name = i.plugin.name
      probe.e = e
      const context = {
        ...probe.getContext(),
        ...probe.getContext(false, true),
      }
      if (!isEmptyObject(context)) {
        let ret
        for (const fnc in context) ret ||= await getInstance(i)[fnc](context[fnc])
        if (ret === 'continue') continue
        return
      }
    }

    /** 是否只关注主动at */
    if (!e.only_reply_at) return

    // 判断是否是星铁命令，若是星铁命令则标准化处理
    // e.isSr = true，且命令标准化为 #星铁 开头
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

    /** 优先执行 accept */
    for (const i of priority)
      if (i.plugin.accept) {
        const res = await getInstance(i).accept(e)
        if (res === 'return') return
        if (res) break
      }

    for (const i of priority) {
      if (i.plugin.rule)
        for (const v of i.plugin.rule) {
          /** 判断事件 */
          if (v.event && !this.filtEvent(e, v)) continue

          /** 正则匹配 */
          if (!(v.reg as RegExp).test(e.msg as string)) continue
          const instance = getInstance(i)
          e.logFnc = `${logger.blue(`[${i.name}(${typeof v.fnc === 'string' ? v.fnc : v.fnc.name})]`)}`

          util.makeLog(
            v.log === false ? 'debug' : 'info',
            `${e.logText}${e.logFnc}${logger.yellow('[开始处理]')}`,
            false,
          )

          /** 判断权限 */
          if (this.filtPermission(e, v))
            try {
              const start_time = Date.now()
              /** 绑定到插件实例，保持与云崽一致的 this 语义 */
              const fn =
                typeof v.fnc === 'function' ? v.fnc.bind(instance) : instance[v.fnc]?.bind(instance)
              const res = fn && (await fn(e, (v.reg as RegExp).exec(String(e.msg)) || undefined))
              metrics.record(i, Date.now() - start_time)
              if (res === false) continue
              util.makeLog(
                v.log === false ? 'debug' : 'mark',
                `${e.logText}${e.logFnc}${logger.green(`[完成${util.getTimeDiff(start_time)}]`)}`,
                false,
              )
            } catch (err) {
              util.makeLog('error', [`${e.logText}${e.logFnc}`, err], false)
            }
          return
        }
    }

    util.makeLog('debug', `${e.logText}${logger.blue('[暂无插件处理]')}`, false)
  }

  /** 过滤事件 */
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

  /** 判断权限 */
  filtPermission(e: JiuLiEvent, v: any) {
    if (!v.permission || e.isMaster) return true

    if (v.permission === 'master') {
      e.reply?.('暂无权限，只有主人才能操作')
      return false
    }

    if (e.isGroup) {
      if (v.permission === 'owner' && !e.member?.is_owner) {
        e.reply?.('暂无权限，只有群主才能操作')
        return false
      }
      if (v.permission === 'admin' && !e.member?.is_owner && !e.member?.is_admin) {
        e.reply?.('暂无权限，只有管理员才能操作')
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

  /** 处理事件，加入自定义字段 */
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

    /** 只关注主动at msg处理 */
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

  /** 处理回复，捕获发送失败异常 */
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
      try {
        res = await reply(msg)
      } catch (err) {
        util.makeLog('error', ['发送消息错误', msg, err], e.self_id)
        res = { error: [err] }
      }

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
      util.makeLog('error', [name, err], false)
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
    /** 禁言中 */
    if (e.group && (e.group.mute_left > 0 || (e.group.all_muted && !e.group.is_admin && !e.group.is_owner)))
      return false
    if (!e.message || e.isPrivate) return true

    config ||= cfg.getGroup(e.self_id, e.group_id)

    if (config.groupCD && this.groupCD[e.group_id as any]) return false
    if (config.singleCD && this.singleCD[`${e.group_id}.${e.user_id}`]) return false

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

  /** 是否只关注主动at */
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

  /** 判断黑白名单 */
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

  /** 判断是否启用功能 */
  checkDisable(p: { plugin: any; e: JiuLiEvent }, groupCfg?: any) {
    groupCfg ||= cfg.getGroup(p.e.self_id, p.e.group_id)
    if (groupCfg.disable?.length && groupCfg.disable.includes(p.plugin.name)) return false
    if (groupCfg.enable?.length && !groupCfg.enable.includes(p.plugin.name)) return false
    return true
  }

  /* ==================== 卸载/热重载 ==================== */

  async unloadPlugin(key: string, closeWatcher = false) {
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
      const success = await this.importPlugin({
        name: key,
        path: `../../${this.dir}/${key}?${moment().format('x')}`,
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
    } catch (err) {
      util.makeLog('error', [`插件加载错误 ${logger.red(key)}`, err], 'Plugin')
    }
  }

  /** 监听热更新 */
  watch(dirName: string, appName: string) {
    this.watchDir(dirName)
    if (this.watcher[`${dirName}.${appName}`]) return

    const file = `./${this.dir}/${dirName}/${appName}`
    const watcher = chokidar.watch(file)
    const key = `${dirName}/${appName}`

    const changeHandler = util.debounce(() => {
      util.makeLog('mark', `[修改插件][${dirName}][${appName}]`, 'Plugin')
      this.changePlugin(key)
    }, 5000)
    watcher.on('change', changeHandler)

    const unlinkHandler = util.debounce(async () => {
      util.makeLog('mark', `[卸载插件][${dirName}][${appName}]`, 'Plugin')
      await this.unloadPlugin(key, true)
    }, 5000)
    watcher.on('unlink', unlinkHandler)

    const watcherAny = watcher as any
    watcherAny.changeHandler = changeHandler
    watcherAny.unlinkHandler = unlinkHandler
    this.watcher[`${dirName}.${appName}`] = watcher  }

  /** 监听文件夹更新 */
  watchDir(dirName: string) {
    if (this.watcher[dirName]) return
    const watcher = chokidar.watch(`./${this.dir}/${dirName}/`)
    const Bot = (globalThis as any).Bot

    /** chokidar 初次扫描会为已有文件触发 add，ready 之前的一律忽略 */
    let ready = false
    watcher.on('ready', () => (ready = true))

    Bot.once('online', () => {
      watcher.on(
        'add',
        util.debounce(async (PluPath: string) => {
          if (!ready) return
          const appName = path.basename(PluPath)
          if (!appName.endsWith('.js')) return
          util.makeLog('mark', `[新增插件][${dirName}][${appName}]`, 'Plugin')
          await this.importPlugin({ name: `${dirName}/${appName}`, path: `../../${this.dir}/${dirName}/${appName}?${moment().format('X')}` })
          this.priority.sort((a, b) => a.priority - b.priority)
          this.buildEventIndex()
          this.createTask()
          this.watch(dirName, appName)
        }, 5000) as any,
      )
    })
    this.watcher[dirName] = watcher
  }

  /** 关闭全部 watcher（file_watch=false 时由 config 处理） */
  closeWatchers() {
    for (const i in this.watcher) {
      this.watcher[i]?.close?.()
      delete this.watcher[i]
    }
  }
}

export default new PluginsLoader()
export { PluginsLoader }
