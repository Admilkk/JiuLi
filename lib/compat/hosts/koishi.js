/**
 * Koishi 兼容宿主
 *
 * 方案：**直接依赖官方 `koishi` 包**，在本进程内起一个真实的 Koishi Context，
 * 用一个自定义 Bot 把 JiuLi 的消息灌进 Koishi 的事件流，再把 Koishi 发出的消息转回 JiuLi。
 *
 * 为什么这么做而不是自己实现一套 ctx：
 * Koishi 插件拿到的 ctx 是 cordis 的 Context（服务注入 / 生命周期 / schema 校验全在里面），
 * 自己仿一套只能覆盖最表面的几个方法，插件一用 `ctx.inject`、`ctx.setInterval`、
 * `ctx.command().option()` 就会碎。用真包这些全部免费获得，代价只是多一个依赖。
 *
 * 已知缺口（docs/compat-ecosystems.md 里有完整说明）：
 * - `ctx.database`：默认没有。插件 `inject: ['database']` 时不会激活（Koishi 的注入语义就是等待，
 *   不会报错）。需要时在 compat.yaml 的 koishi.database 里填 `@koishijs/plugin-database-sqlite`。
 * - `ctx.console` / `ctx.puppeteer` / `ctx.assets`：控制台与浏览器服务未提供，用到它们的插件不激活。
 *
 * 「谁处理了消息」：Koishi 的中间件链在 `Processor._handleMessage` 里异步执行，没有对外暴露 Promise，
 * 因此只能从「本宿主是否往外发了消息」观察。给一段很短的就绪窗口（compat.yaml → koishi.settle_ms），
 * 窗口内有发送就算已处理 —— 据此拦截云崽那边的同名指令，避免一条指令两边各回一次。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { compatRoot } from '../paths.js'

const PKG_DIR = compatRoot()
const requireFromCompat = createRequire(path.join(PKG_DIR, 'noop.js'))

/** 依赖解析：先按给定基准（如 koishi 自身）解析，再按 plugins/compat，最后退回裸导入 */
async function importOptional(name, base) {
  const resolvers = [base, requireFromCompat].filter(Boolean)
  let firstErr
  for (const resolver of resolvers) {
    try {
      return await import(pathToFileURL(resolver.resolve(name)).href)
    } catch (err) {
      firstErr ||= err
    }
  }
  try {
    return await import(name)
  } catch {
    throw new Error(`无法加载 ${name}：${firstErr?.message || 'not found'}；安装：cd plugins/compat && pnpm add ${name}`)
  }
}

/* ==================== 元素映射 ==================== */

/** 通用元素 → Koishi h 元素 */
export function toKoishiElements(h, elements) {
  const out = []
  for (const el of elements || []) {
    switch (el.type) {
      case 'text':
        out.push(h.text(el.text ?? ''))
        break
      case 'at':
        out.push(h.at(String(el.id)))
        break
      case 'image':
        if (el.url) out.push(h.img(el.url))
        break
      case 'face':
        out.push(h('face', { id: String(el.id) }))
        break
      case 'reply':
        out.push(h.quote(String(el.id)))
        break
      case 'record':
        if (el.url) out.push(h.audio(el.url))
        break
      case 'video':
        if (el.url) out.push(h.video(el.url))
        break
      case 'file':
        if (el.url) out.push(h.file(el.url, { title: el.name }))
        break
      default:
        if (el.text) out.push(h.text(el.text))
    }
  }
  return out
}

/** Koishi h 元素（h.normalize 之后的结果）→ 通用元素 */
export function fromKoishiElements(elements) {
  const out = []
  const push = el => {
    if (el == null) return
    if (typeof el === 'string') return void out.push({ type: 'text', text: el })
    const { type, attrs = {}, children } = el
    switch (type) {
      case 'text':
        return void out.push({ type: 'text', text: attrs.content ?? '' })
      case 'at':
        return void out.push({ type: 'at', id: String(attrs.id ?? attrs.qq ?? '') })
      case 'img':
      case 'image':
        return void out.push({ type: 'image', url: attrs.src ?? '', name: attrs.title })
      case 'face':
      case 'emoji':
        return void out.push({ type: 'face', id: String(attrs.id ?? '') })
      case 'quote':
      case 'reply':
        return void out.push({ type: 'reply', id: String(attrs.id ?? '') })
      case 'audio':
      case 'record':
        return void out.push({ type: 'record', url: attrs.src ?? '' })
      case 'video':
        return void out.push({ type: 'video', url: attrs.src ?? '' })
      case 'file':
        return void out.push({ type: 'file', url: attrs.src ?? '', name: attrs.title ?? attrs.name })
      case 'br':
        return void out.push({ type: 'text', text: '\n' })
      default:
        /** 未识别元素：有子节点就展开，否则退化成文本（Koishi 元素 toString 即其源码形式） */
        if (children?.length) children.forEach(push)
        else if (typeof el.toString === 'function') out.push({ type: 'text', text: el.toString(true) })
    }
  }
  for (const el of elements || []) push(el)
  return out
}

/* ==================== 宿主 ==================== */

export default {
  id: 'koishi',
  name: 'Koishi',

  app: null,
  h: null,
  BotClass: null,
  /** selfId → Koishi Bot */
  bots: new Map(),
  /** 已知群号：插件主动发送时用来判断该发群还是发私聊 */
  knownGroups: new Set(),
  loaded: [],
  /** 出站消息计数：dispatch 用它判断「Koishi 侧是否已经回复」 */
  sendCount: 0,
  settle: 250,

  async start(api) {
    const koishi = await importOptional('koishi')
    const { Context, h, Bot } = koishi
    /**
     * koishi 的服务插件（@koishijs/plugin-http 等）是 koishi 自己的依赖，
     * pnpm 的隔离 node_modules 下只能从 koishi 所在位置解析，从 plugins/compat 解析会找不到。
     */
    const requireFromKoishi = createRequire(requireFromCompat.resolve('koishi'))
    const cfg = api.config || {}
    const self = this

    this._api = api
    this.h = h
    this.settle = Number(cfg.settle_ms) > 0 ? Number(cfg.settle_ms) : 250
    this.app = new Context({
      ...(cfg.prefix ? { prefix: cfg.prefix } : {}),
      nickname: cfg.nickname || [],
      autoAssign: true,
    })

    /** 官方 http 服务：大量插件用 ctx.http.get/post，不装的话它们直接不激活 */
    if (cfg.http !== false) {
      try {
        const mod = await importOptional('@koishijs/plugin-http', requireFromKoishi)
        this.app.plugin(mod.default ?? mod, cfg.http_config || {})
      } catch (err) {
        api.log('warn', `Koishi http 服务加载失败（用 ctx.http 的插件会不激活）：${err?.message || err}`)
      }
    }

    /** 可选数据库：填了才加载 */
    if (cfg.database) {
      try {
        const mod = await importOptional(cfg.database, requireFromKoishi)
        this.app.plugin(mod.default ?? mod, cfg.database_config || {})
      } catch (err) {
        api.log('warn', `Koishi 数据库插件加载失败：${err?.message || err}`)
      }
    }

    /**
     * JiuLi 的协议端 → 一个 Koishi Bot。
     * 只实现 sendMessage（session.send / ctx.broadcast 最终都走到它），
     * 其余方法（getMessage 等）留空，用到它们的插件会拿到 undefined 而不是静默出错。
     */
    this.BotClass = class JiuLiBot extends Bot {
      constructor(ctx, config) {
        super(ctx, config, 'jiuli')
        this.user = { id: config.selfId, name: config.nickname || config.selfId }
        this.status = 1
      }

      async sendMessage(channelId, content, referrer, options) {
        const elements = fromKoishiElements(h.normalize(content))
        if (!elements.length) return []
        self.sendCount++
        const isGroup = options?.session ? !options.session.isDirect : self.knownGroups.has(String(channelId))
        const id = `koishi-${Date.now()}-${self.sendCount}`
        await self._api.sendTo({ selfId: this.selfId, channelId: String(channelId), isGroup }, elements)
        return [id]
      }
    }

    for (const uin of api.info().uin) this._ensureBot(String(uin))

    /** 插件来源：compat.yaml 里列出的包名 + pkgs/koishi/ 下的目录 */
    const specs = []
    for (const item of cfg.plugins || []) {
      if (typeof item === 'string') specs.push({ name: item, config: cfg.config?.[item] })
      else if (item?.name) specs.push({ name: item.name, config: item.config ?? cfg.config?.[item.name] })
    }
    for (const dir of scanPluginDirs(path.join(PKG_DIR, 'pkgs', 'koishi'))) specs.push({ name: dir.name, path: dir.path })

    /** 去重：同一个插件既写在 config.plugins 又躺在 pkgs/koishi/ 下时只加载一次（cordis 会警告 duplicate plugin） */
    const seen = new Set()
    for (const spec of specs) {
      const key = spec.path ? path.resolve(spec.path) : spec.name
      if (seen.has(key)) continue
      seen.add(key)
      try {
        /** 也允许直接写目录/文件路径（测试与本地开发用），不是路径才当包名解析 */
        const asPath =
          spec.path ||
          (/^(\.|\.\.|[a-zA-Z]:)?[\\/]/.test(spec.name) || spec.name.startsWith('.') ? path.resolve(spec.name) : null)
        const mod = asPath
          ? await import(pathToFileURL(fs.existsSync(path.join(asPath, 'package.json')) ? resolveEntry(asPath) : asPath).href)
          : await importOptional(spec.name)
        /** ESM 与 CJS 两种导出形状都要接住 */
        const plugin = mod.apply && mod.name ? mod : (mod.default ?? mod)
        this.app.plugin(plugin, spec.config || {})
        this.loaded.push(spec.name)

        /**
         * cordis 的注入语义是「等」：插件 inject 了不存在的服务时，apply 根本不执行、
         * 不报错、也没有 error 事件 —— 表现为「加载成功但功能不存在」。
         * 所以这里主动预检一次，把静默失败变成一行明确的警告。
         */
        const Inject = koishi.Inject
        const injects = plugin?.inject || plugin?.using
        if (Inject?.resolve && injects) {
          try {
            const deps = Inject.resolve(injects)
            const missing = Object.keys(deps).filter(k => deps[k]?.required && !this.app.get(k))
            if (missing.length)
              api.log('warn', `Koishi 插件 ${spec.name} 依赖的服务不存在，它不会生效：${missing.join(' · ')}`)
          } catch {
            /* 解析失败就算了，不影响加载 */
          }
        }
      } catch (err) {
        api.log('error', [
          `Koishi 插件加载失败 · ${spec.name}：${String(err?.message || err)}`,
          '        缺依赖时在该插件目录里装依赖，或把它从 compat.yaml 的 koishi.plugins 里去掉',
        ])
        api.log('debug', [`${spec.name} 加载失败详情`, err])
      }
    }

    await this.app.start()
    api.log(
      this.loaded.length ? 'mark' : 'info',
      this.loaded.length
        ? `Koishi 插件 ${this.loaded.length} 个 · ${this.loaded.slice(0, 8).join(' · ')}${this.loaded.length > 8 ? ' …' : ''}`
        : 'Koishi 已就绪，但还没有插件：放进 plugins/compat/pkgs/koishi/ 或 cd plugins/compat && pnpm add koishi-plugin-xxx',
    )
  },

  _ensureBot(selfId) {
    if (!selfId || !this.BotClass) return null
    if (this.bots.has(selfId)) return this.bots.get(selfId)
    const bot = new this.BotClass(this.app, { selfId })
    this.bots.set(selfId, bot)
    return bot
  },

  async dispatch(u) {
    if (!this.app?.lifecycle?.isActive) return false
    const bot = this.bots.get(u.selfId) || this._ensureBot(u.selfId)
    if (!bot) return false

    if (u.isGroup) this.knownGroups.add(String(u.groupId))
    const channelId = u.isGroup ? String(u.groupId) : String(u.userId)

    const session = bot.session({
      type: 'message',
      selfId: u.selfId,
      platform: 'jiuli',
      timestamp: u.time,
      user: { id: u.userId, name: u.sender.nick, nick: u.sender.name, avatar: u.raw?.sender?.avatar },
      member: u.isGroup
        ? { user: { id: u.userId, name: u.sender.nick }, nick: u.sender.name, name: u.sender.name, roles: [] }
        : undefined,
      guild: u.isGroup ? { id: String(u.groupId), name: u.raw?.group_name } : undefined,
      channel: { id: channelId, type: u.isGroup ? 0 : 1, name: u.raw?.group_name },
      message: { id: u.messageId, elements: toKoishiElements(this.h, u.elements) },
      /** 原始 JiuLi 事件挂上去，宿主增强 / 调试插件可以取用 */
      _jiuli: u.raw,
    })

    const before = this.sendCount
    bot.dispatch(session)
    /** 同步就回了（多数指令插件直接 return 结果）：不用等窗口 */
    if (this.sendCount > before) return true
    return await this._waitSettle(before)
  },

  _waitSettle(before) {
    return new Promise(resolve => {
      const started = Date.now()
      const tick = () => {
        if (this.sendCount > before) return resolve(true)
        if (Date.now() - started >= this.settle) return resolve(false)
        /** 不能 unref：这个定时器是 Promise 唯一的推进来源，unref 后事件循环空了会直接退出 */
        setTimeout(tick, 30)
      }
      setTimeout(tick, 30)
    })
  },

  async stop() {
    /**
     * 先把 Bot 摘掉再停 Context：satori 的 Bot 自己监听了 'dispose'，
     * 但 Context 拆除服务时 ctx.bots 已经没了，回调里 `ctx.bots.findIndex` 会抛
     * "Cannot read properties of undefined"。先手动 dispose 再把它变成空操作即可。
     */
    for (const bot of this.bots.values()) {
      try {
        await bot.dispose()
      } catch {}
      bot.dispose = () => {}
    }
    try {
      await this.app?.stop?.()
    } catch {}
    this.app = null
    this.h = null
    this.BotClass = null
    this.bots.clear()
    this.knownGroups.clear()
    this.loaded = []
    this.sendCount = 0
  },

  pluginCount() {
    return this.loaded.length
  },

  describe() {
    return `插件 ${this.loaded.length} 个`
  },
}

/** 扫描插件目录：带 package.json 的子目录视为一个 Koishi 插件包 */
function scanPluginDirs(dir) {
  try {
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => ({ name: d.name, path: path.join(dir, d.name) }))
      .filter(d => fs.existsSync(path.join(d.path, 'package.json')))
  } catch {
    return []
  }
}

/** 取包入口文件（module / main / exports['.'] 的 import 分支） */
function resolveEntry(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  let entry = pkg.module || pkg.main || 'index.js'
  const exp = pkg.exports?.['.'] ?? pkg.exports
  if (typeof exp === 'string') entry = exp
  else if (exp && typeof exp === 'object') entry = exp.import?.default || exp.import || exp.default || exp.require || entry
  if (typeof entry === 'object') entry = entry.default || entry.node || 'index.js'
  return path.resolve(dir, entry)
}
