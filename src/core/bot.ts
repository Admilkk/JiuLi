/**
 * Bot 单例
 * Bot 是 Proxy：属性回落链 Bot.x → util.x → bots[x] → Bot[随机uin].x，
 * 并带 uin / adapter 两个云崽约定的特化数组，内置 HTTP / WebSocket 与文件托管。
 */
import express from 'express'
import compression from 'compression'
import http from 'node:http'
import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { WebSocketServer } from 'ws'
import { ulid } from 'ulid'
import cfg from './config/index.js'
import util from './util.js'
import { logger } from './log.js'
import type { JiuLiEvent } from './types.js'

export default class JiuLiBot extends EventEmitter {
  stat = { start_time: Date.now() / 1000, online: 0 }
  bot = this
  bots: Record<string, any> = {}

  /** 机器人账号列表（特化数组） */
  uin: any = Object.assign([], {
    toJSON(this: any) {
      if (!this.now) {
        switch (this.length) {
          case 0:
            return ''
          case 1:
          case 2:
            return this[this.length - 1]
        }
        const array = this.slice(1)
        this.now = array[Math.floor(Math.random() * array.length)]
        // 60s 内复用同一个随机账号，避免连续操作跨号
        setTimeout(() => delete this.now, 60000)
      }
      return this.now
    },
    toString(this: any, raw?: boolean, ...args: any[]) {
      return raw === true ? Array.prototype.toString.apply(this, args as any) : String(this.toJSON())
    },
    includes(this: any, value: any) {
      return this.some((i: any) => i == value)
    },
  })

  /** 适配器列表（按 path 去重） */
  adapter: any = Object.defineProperty([], 'push', {
    configurable: true,
    writable: true,
    value(this: any[], ...items: any[]) {
      for (const item of items)
        if (!item?.path || !this.some((adapter: any) => adapter.path === item.path)) Array.prototype.push.call(this, item)
      return this.length
    },
  })

  express: any = Object.assign(express(), { skip_auth: [], quiet: [] })
    .use(this.serverAuth.bind(this))
    .use(compression())
    .use('/status', this.serverStatus.bind(this))
    .use(express.urlencoded({ extended: false }))
    .use(express.json())
    .use(express.raw())
    .use(express.text())
    .use(this.serverHandle.bind(this))
    .use('/exit', this.serverExit.bind(this))
    .use('/File', this.fileSend.bind(this))

  server = http
    .createServer(this.express)
    .on('error', (err: any) => {
      if (typeof (this as any)[`server${err.code}`] === 'function') return (this as any)[`server${err.code}`](err)
      util.makeLog('error', err, 'Server')
    })
    .on('upgrade', this.wsConnect.bind(this))

  httpsServer: any
  url = ''
  wss = new WebSocketServer({ noServer: true })
  wsf: Record<string, any[]> = Object.create(null)
  fs: Record<string, any> = Object.create(null)
  fileTimers = new Map<string, NodeJS.Timeout>()
  server_listen_time = 0

  constructor() {
    super()
    /** 记录插件注册的 express 路由与 WS 路径，卸载/重载时清理（避免重复注册与端口/处理器冲突） */
    this.wrapExpress()
    /** 属性回落解析缓存（函数绑定等） */
    const cache = new Map<string | symbol, any>()
    const resolve = (prop: string | symbol) => {
      const cached = cache.get(prop)
      if (cached !== undefined) return cached

      /**
       * 实例自身属性优先（原样返回，不 bind：express app / server 本身是函数对象，bind 会丢掉 .get/.use 等自有属性）。
       * 插件常用 `Bot.xxx = 自定义` 覆盖框架方法，先查原型的话覆盖会被原型方法挡住、等于没生效。
       */
      if (Object.prototype.hasOwnProperty.call(this, prop)) {
        const own = (this as any)[prop]
        if (own !== undefined) return own
      }

      const proto = Object.getPrototypeOf(this)
      const desc = Object.getOwnPropertyDescriptor(proto, prop as string)
      if (desc?.get) return (this as any)[prop]
      if (desc?.value) {
        const value = desc.value
        if (typeof value === 'function') {
          const bound = value.bind(this)
          cache.set(prop, bound)
          return bound
        }
        return value
      }

      /** 继承自更上层原型的方法（如 EventEmitter 的 on / once）原样返回，调用时 this 仍是代理 */
      const inherited = (this as any)[prop]
      if (inherited !== undefined) return inherited

      const u = (util as any)[prop]
      if (u !== undefined) {
        if (typeof u === 'function') {
          const bound = u.bind(util)
          cache.set(prop, bound)
          return bound
        }
        return u
      }

      const target = this.bots[prop as string]
      if (target !== undefined) return target

      for (const i of [this.uin.toString(), ...this.uin]) {
        if (this.bots[i]?.[prop as string] !== undefined) {
          util.makeLog('trace', `因不存在 Bot.${String(prop)} 而重定向到 Bot.${i}.${String(prop)}`)
          const value = this.bots[i][prop as string]
          if (typeof value?.bind === 'function') return value.bind(this.bots[i])
          return value
        }
      }

      util.makeLog('trace', `不存在 Bot.${String(prop)}`)
      return undefined
    }

    return new Proxy(this.bots, {
      get: (_target, prop) => resolve(prop),
      set: (_target, prop, value) => {
        cache.delete(prop)
        const proto = Object.getPrototypeOf(this)
        const isInstanceProp =
          Object.prototype.hasOwnProperty.call(this, prop) ||
          Object.getOwnPropertyDescriptor(proto, prop) !== undefined ||
          (util as any)[prop] !== undefined
        if (isInstanceProp) (this as any)[prop] = value
        else (this.bots as any)[prop] = value
        return true
      },
      has: (_target, prop) => prop in this || prop in util || prop in this.bots,
      ownKeys: () => Reflect.ownKeys(this.bots),
      getOwnPropertyDescriptor: (_target, prop) => Reflect.getOwnPropertyDescriptor(this.bots, prop),
    }) as any
  }

  /* ==================== 插件注册资源（热重载清理） ==================== */

  private pluginLayers = new Map<string, Set<any>>()
  private pluginWs = new Map<string, Set<string>>()

  /** 当前正在加载的插件 key（由 loader 在 import 前后设置） */
  private get loadingKey(): string | undefined {
    return (globalThis as any).__jiuliLoading
  }

  /** 包装 express 路由方法，记录每个插件注册的层；重载时先清理旧层，避免路由重复注册 */
  private wrapExpress() {
    const app = this.express
    for (const method of ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all', 'use', 'route']) {
      const orig = app[method].bind(app)
      app[method] = (...args: any[]) => {
        const key = this.loadingKey
        const router = app.router || app._router
        const before = router?.stack?.length ?? 0
        const ret = orig(...args)
        const after = router?.stack?.length ?? 0
        if (key && after > before) {
          let set = this.pluginLayers.get(key)
          if (!set) this.pluginLayers.set(key, (set = new Set()))
          for (const layer of router.stack.slice(before, after)) set.add(layer)
        }
        return ret
      }
    }

    /** 代理 wsf（WebSocket 处理器表），记录插件占用过的路径 */
    const wsf = this.wsf
    this.wsf = new Proxy(wsf, {
      set: (target, prop: string, value) => {
        const key = this.loadingKey
        if (key && typeof prop === 'string') {
          let set = this.pluginWs.get(key)
          if (!set) this.pluginWs.set(key, (set = new Set()))
          set.add(prop)
        }
        target[prop] = value
        return true
      },
      deleteProperty: (target: any, prop: string | symbol) => {
        delete target[prop as any]
        return true
      },
      get: (target: any, prop: string | symbol) => target[prop as any],
      ownKeys: target => Reflect.ownKeys(target),
      getOwnPropertyDescriptor: (target: any, prop: string | symbol) =>
        Reflect.getOwnPropertyDescriptor(target, prop),
    })
  }

  /** 插件卸载/重载前清理它注册的路由与 WS 路径 */
  cleanupPluginResources(key: string) {
    const router = this.express?.router || this.express?._router
    let routes = 0
    const layers = this.pluginLayers.get(key)
    if (layers) {
      for (const layer of layers) {
        const index = router?.stack?.indexOf(layer) ?? -1
        if (index > -1) {
          router.stack.splice(index, 1)
          routes++
        }
      }
      this.pluginLayers.delete(key)
    }

    let ws = 0
    const paths = this.pluginWs.get(key)
    if (paths) {
      for (const p of paths)
        if (p in this.wsf) {
          delete (this.wsf as any)[p]
          ws++
        }
      this.pluginWs.delete(key)
    }

    if (routes || ws)
      util.makeLog('debug', `已清理插件注册的 express 路由 ${routes} 条 · WS 路径 ${ws} 个 · ${key}`, 'Plugin')
    return { routes, ws }
  }

  /* ==================== HTTP 服务 ==================== */

  serverAuth(req: any): any {
    if (this.stat.online !== 2) return this.once('online', this.serverAuth.bind(this, req))

    req.rid ??= `${req.ip}:${req.socket.remotePort}`
    req.sid ??= `${req.protocol}://${req.hostname}:${req.socket.localPort}${req.originalUrl}`
    if (!cfg.server.auth || !Object.keys(cfg.server.auth).length) return req.next?.()

    for (const i of req.app?.skip_auth || []) if (req.originalUrl.startsWith(i)) return req.next()

    for (const i in cfg.server.auth) {
      if (req.headers[i.toLowerCase()] === cfg.server.auth[i] || req.query[i] === cfg.server.auth[i]) continue
      req.res?.sendStatus(401)

      const msg: any = { headers: req.headers }
      if (Object.keys(req.query).length) msg.query = req.query
      util.makeLog('error', ['HTTP', req.method, '请求', i, '鉴权失败', msg], `${req.sid} <≠ ${req.rid}`, true)
      return false
    }
    req.next?.()
  }

  serverStatus(req: any) {
    req.res.type('json')
    req.res.send(
      JSON.stringify(process.report.getReport()).replace(
        /(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/g,
        '[IPv4]',
      ),
    )
  }

  serverHandle(req: any) {
    let quiet = false
    for (const i of req.app.quiet)
      if (req.originalUrl.startsWith(i)) {
        quiet = true
        break
      }

    const msg: any = { headers: req.headers }
    for (const i of ['query', 'body']) if (req[i] && Object.keys(req[i]).length) msg[i] = req[i]
    util.makeLog(quiet ? 'debug' : 'mark', ['HTTP', req.method, '请求', msg], `${req.sid} <= ${req.rid}`, true)
    req.next()
  }

  async serverExit(req: any) {
    if (req.ip !== '::1' && req.ip !== '::ffff:127.0.0.1') return
    this.exit(1)
  }

  wsConnect(req: any, socket: any, head: any): any {
    if (this.stat.online !== 2) return this.once('online', this.wsConnect.bind(this, req, socket, head))

    req.rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers['sec-websocket-key']}`
    req.sid = `ws://${
      req.headers['x-forwarded-host'] || req.headers.host || `${req.socket.localAddress}:${req.socket.localPort}`
    }${req.url}`
    req.query = Object.fromEntries(new URL(req.sid).searchParams.entries())
    if (this.serverAuth(req) === false) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return socket.destroy()
    }

    const msg: any = { headers: req.headers }
    if (Object.keys(req.query).length) msg.query = req.query

    const path = req.url.split('/')[1]
    if (!(path in this.wsf)) {
      util.makeLog('error', ['WebSocket 处理器', path, '不存在', msg], `${req.sid} <≠> ${req.rid}`, true)
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      return socket.destroy()
    }

    this.wss.handleUpgrade(req, socket, head, conn => {
      util.makeLog('mark', ['建立连接', msg], `${req.sid} <=> ${req.rid}`, true)
      conn.on('error', (...args: any[]) => util.makeLog('error', args, `${req.sid} <=> ${req.rid}`, true))
      conn.on('close', () => {
        util.makeLog('mark', '断开连接', `${req.sid} <≠> ${req.rid}`, true)
        this.cleanupBotConnection(conn)
      })
      conn.on('message', (m: any) => util.makeLog('debug', ['消息', util.String(m)], `${req.sid} <= ${req.rid}`, true))
      ;(conn as any).sendMsg = (m: any) => {
        if (!Buffer.isBuffer(m)) m = util.String(m)
        util.makeLog('debug', ['消息', m], `${req.sid} => ${req.rid}`, true)
        return conn.send(m)
      }
      for (const i of this.wsf[path]) i(conn, req, socket, head)
    })
  }

  async serverEADDRINUSE(err: any, https?: boolean) {
    util.makeLog('error', ['监听端口', https ? cfg.server.https.port : cfg.server.port, '错误', err], 'Server')
    if (https) return
    try {
      await fetch(`http://localhost:${cfg.server.port}/exit`, { headers: cfg.server.auth || undefined })
    } catch {}
    this.server_listen_time = (this.server_listen_time || 0) + 1
    await util.sleep(this.server_listen_time * 1000)
    this.server.listen(cfg.server.port)
  }

  serverError(err: any, req: any, res: any, _next?: any) {
    util.makeLog('error', ['HTTP', req.method, '请求错误', err], `${req.sid} <≠ ${req.rid}`, true)
    return res.end()
  }

  async serverLoad(https?: boolean) {
    const server = https ? 'httpsServer' : 'server'
    ;(this as any)[server].listen(https ? cfg.server.https.port : cfg.server.port)
    try {
      await util.promiseEvent((this as any)[server], 'listening', https ? 'error' : undefined)
    } catch {
      return
    }
    const { address, port } = (this as any)[server].address()
    util.makeLog('mark', [`启动 HTTP${https ? 'S' : ''} 服务器`, logger.green(`http${https ? 's' : ''}://[${address}]:${port}`)], 'Server')
    this.url = (https && cfg.server.https.url) || cfg.server.url
    for (const name of [404, 'timeout'])
      this.fileToUrl(`resources/http/File/${name}.jpg`, { name, time: false, times: false })
  }

  async httpsLoad() {
    try {
      this.httpsServer = (await import('node:https'))
        .createServer(
          {
            key: await fs.readFile(cfg.server.https.key),
            cert: await fs.readFile(cfg.server.https.cert),
          },
          this.express,
        )
        .on('error', (err: any) => {
          if (typeof (this as any)[`server${err.code}`] === 'function')
            return (this as any)[`server${err.code}`](err, true)
          util.makeLog('error', err, 'Server')
        })
        .on('upgrade', this.wsConnect.bind(this))
      return this.serverLoad(true)
    } catch (err) {
      util.makeLog('error', ['创建 HTTPS 服务器错误', err], 'Server')
    }
  }

  /* ==================== 启动 ==================== */

  async run() {
    if (this.stat.online !== 0) return
    this.stat.online = 1

    const { default: PluginsLoader } = await import('./loader.js')
    const { loadEvents } = await import('./events.js')
    const { initRedisOrFallback, ensureDirs } = await import('./start.js')

    await ensureDirs()
    await initRedisOrFallback()
    await this.serverLoad()
    if (cfg.server.https?.key && cfg.server.https?.cert) await this.httpsLoad()
    /** 加载渲染后端，浏览器仍在首次截图时懒启动 */
    const { default: renderService } = await import('./render/index.js')
    await renderService.load()
    /** 预热框架模块，使"插件加载耗时"只反映插件自身成本 */
    await import('./index.js')
    await import('../index.js')
    await PluginsLoader.load()
    await loadEvents()

    this.stat.online = 2
    this.express.use((req: any) => req.res.redirect(cfg.server.redirect)).use(this.serverError.bind(this))
    util.makeLog(
      'info',
      `连接地址：${logger.blue(`${this.url.replace(/^http/, 'ws')}/`)}${logger.cyan(`[${Object.keys(this.wsf)}]`)}`,
      'WebSocket',
    )
    const adapterNames = this.adapter.map((a: any) => `${a.name}(${a.id})`).join(' · ')
    util.makeLog(
      'mark',
      `JiuLi 就绪 · 用时 ${util.getTimeDiff(this.stat.start_time * 1000)} · 适配器 ${this.adapter.length} 个${
        adapterNames ? `（${adapterNames}）` : ''
      } · 在线账号 ${[...this.uin].length} 个`,
      'Online',
    )
    this.emit('online', this)
  }

  /* ==================== 文件托管 ==================== */

  async fileToUrl(file: any, opts: any = {}) {
    const { name, time = cfg.bot.file_to_url_time * 60000, times = cfg.bot.file_to_url_times } = opts

    file =
      (typeof file === 'object' && !Buffer.isBuffer(file) && { ...file }) ||
      (await util.fileType({ file, name }, { http: true }))
    if (!Buffer.isBuffer(file.buffer)) return file.buffer
    file.name = file.name ? encodeURIComponent(file.name) : ulid()

    if (typeof times === 'number') file.times = times
    this.fs[file.name] = file
    this.setFileTimeout(file.name, file, time)

    const url = new URL(`File/${encodeURIComponent(file.name)}`, this.url)
    for (const i in cfg.server.auth) url.searchParams.set(i, cfg.server.auth[i])
    return url
  }

  setFileTimeout(name: string, file: any, time?: number) {
    const oldTimer = this.fileTimers.get(name)
    if (oldTimer) clearTimeout(oldTimer)
    this.fileTimers.delete(name)
    if (!time) return

    const timer = setTimeout(() => {
      if (this.fileTimers.get(name) !== timer || this.fs[name] !== file) return
      this.fileTimers.delete(name)
      this.expireFile(name, file)
    }, time)
    this.fileTimers.set(name, timer)
  }

  expireFile(name: string, file: any) {
    if (this.fs[name] !== file) return
    this.fs[name] = (this.fs as any).timeout

    const oldTimer = this.fileTimers.get(name)
    if (oldTimer) clearTimeout(oldTimer)
    const timer = setTimeout(() => {
      if (this.fs[name] === (this.fs as any).timeout) delete this.fs[name]
      if (this.fileTimers.get(name) === timer) this.fileTimers.delete(name)
    }, 60000)
    this.fileTimers.set(name, timer)
  }

  cleanupBotConnection(ws: any) {
    for (const [self_id, bot] of Object.entries(this.bots)) {
      if ((bot as any).ws !== ws) continue
      delete this.bots[self_id]
      for (let i = this.uin.length - 1; i >= 0; i--) if (this.uin[i] == self_id) this.uin.splice(i, 1)
      if (this.uin.now == self_id) delete this.uin.now
    }
  }

  fileSend(req: any) {
    const url = req.path.replace(/^\//, '')
    let file = this.fs[url] || this.fs[404]

    if (typeof file?.times === 'number') {
      if (file.times > 0) {
        file.times--
        if (file.times <= 0) this.expireFile(url, file)
      } else {
        this.expireFile(url, file)
        file = (this.fs as any).timeout
      }
    }

    if (file?.type?.mime) req.res.setHeader('Content-Type', file.type.mime)
    util.makeLog(
      'mark',
      `发送文件：${file?.name}(${file?.url} ${(file?.buffer?.length / 1024).toFixed(2)}KB)`,
      `${req.sid} => ${req.rid}`,
      true,
    )
    req.res.send(file?.buffer)
  }

  /* ==================== 事件分发 ==================== */

  prepareEvent(data: JiuLiEvent) {
    if (!this.bots[data.self_id as string]) return
    if (!data.bot)
      Object.defineProperty(data, 'bot', {
        value: this.bots[data.self_id as string],
      })

    if (data.user_id) {
      if (!data.friend)
        Object.defineProperty(data, 'friend', {
          value: data.bot.pickFriend(data.user_id),
        })
      data.sender ||= { user_id: data.user_id }
      data.sender.nickname ||= data.friend?.name || data.friend?.nickname
    }

    if (data.group_id) {
      if (!data.group)
        Object.defineProperty(data, 'group', {
          value: data.bot.pickGroup(data.group_id),
        })
      data.group_name ||= data.group?.name || data.group?.group_name
    }

    if (data.group && data.user_id) {
      if (!data.member)
        Object.defineProperty(data, 'member', {
          value: data.group.pickMember(data.user_id),
        })
      data.sender!.nickname ||= data.member?.name || data.member?.nickname
      data.sender!.card ||= data.member?.card
    }

    if (data.bot.adapter?.id) data.adapter_id = data.bot.adapter.id
    if (data.bot.adapter?.name) data.adapter_name = data.bot.adapter.name

    const segment = (globalThis as any).segment
    for (const i of [data.friend, data.group, data.member]) {
      if (typeof i !== 'object' || !i) continue
      i.sendFile ??= (file: any, name?: string) => i.sendMsg(segment.file(file, name))
      i.makeForwardMsg ??= this.makeForwardMsg
      i.sendForwardMsg ??= (msg: any) => this.sendForwardMsg((m: any) => i.sendMsg(m), msg)
      i.getInfo ??= () => i.info || i
    }

    if (!data.reply) {
      if (data.group?.sendMsg) data.reply = data.group.sendMsg.bind(data.group)
      else if (data.friend?.sendMsg) data.reply = data.friend.sendMsg.bind(data.friend)
    }
  }

  /** 逐级 emit：message.group.normal → message.group → message */
  em(name = '', data: JiuLiEvent = {} as JiuLiEvent) {
    this.prepareEvent(data)
    while (true) {
      this.emit(name, data)
      const i = name.lastIndexOf('.')
      if (i === -1) break
      name = name.slice(0, i)
    }
  }

  /* ==================== 账号/好友/群 ==================== */

  getFriendArray() {
    const array: any[] = []
    for (const bot_id of this.uin) for (const [id, i] of (this.bots[bot_id].fl as Map<any, any>) || []) array.push({ ...i, bot_id })
    return array
  }

  getFriendList() {
    const array: any[] = []
    for (const bot_id of this.uin) array.push(...(((this.bots[bot_id].fl as Map<any, any>)?.keys() as any) || []))
    return array
  }

  getFriendMap() {
    const map = new Map()
    for (const bot_id of this.uin)
      for (const [id, i] of (this.bots[bot_id].fl as Map<any, any>) || []) map.set(id, { ...(i as any), bot_id })
    return map
  }
  get fl() {
    return this.getFriendMap()
  }

  getGroupArray() {
    const array: any[] = []
    for (const bot_id of this.uin) for (const [id, i] of (this.bots[bot_id].gl as Map<any, any>) || []) array.push({ ...(i as any), bot_id })
    return array
  }

  getGroupList() {
    const array: any[] = []
    for (const bot_id of this.uin) array.push(...(((this.bots[bot_id].gl as Map<any, any>)?.keys() as any) || []))
    return array
  }

  getGroupMap() {
    const map = new Map()
    for (const bot_id of this.uin)
      for (const [id, i] of (this.bots[bot_id].gl as Map<any, any>) || []) map.set(id, { ...(i as any), bot_id })
    return map
  }
  get gl() {
    return this.getGroupMap()
  }
  get gml() {
    const map = new Map()
    for (const bot_id of this.uin)
      for (const [id, i] of (this.bots[bot_id].gml as Map<any, any>) || [])
        map.set(id, Object.assign(new Map(i), { bot_id }))
    return map
  }

  pickFriend(user_id: any, strict?: boolean) {
    user_id = Number(user_id) || user_id
    if (this.bots[this.uin]?.fl.has(user_id)) return this.bots[this.uin].pickFriend(user_id)

    let user: any
    for (const bot_id of this.uin)
      for (const [id, info] of (this.bots[bot_id]?.fl as Map<any, any>) || [])
        if (id === user_id) user = { ...(info as any), bot_id }

    if (!user) {
      const memberMaps = new Map()
      for (const bot_id of this.uin)
        for (const [group_id, members] of (this.bots[bot_id]?.gml as Map<any, any>) || [])
          memberMaps.set(group_id, { bot_id, members })

      for (const { bot_id, members } of memberMaps.values()) {
        user = (members as Map<any, any>).get(user_id)
        if (user) {
          user.bot_id = bot_id
          break
        }
      }
    }

    if (user) return this.bots[user.bot_id].pickFriend(user_id)
    if (strict) return false
    util.makeLog('debug', ['因不存在用户', user_id, '而随机选择Bot', this.uin.toJSON()])
    return this.bots[this.uin].pickFriend(user_id)
  }
  get pickUser() {
    return this.pickFriend
  }

  pickGroup(group_id: any, strict?: boolean) {
    group_id = Number(group_id) || group_id
    if (this.bots[this.uin]?.gl.has(group_id)) return this.bots[this.uin].pickGroup(group_id)

    let group: any
    for (const bot_id of this.uin)
      for (const [id, info] of (this.bots[bot_id]?.gl as Map<any, any>) || [])
        if (id === group_id) group = { ...(info as any), bot_id }

    if (group) return this.bots[group.bot_id].pickGroup(group_id)
    if (strict) return false
    util.makeLog('debug', ['因不存在群', group_id, '而随机选择Bot', this.uin.toJSON()])
    return this.bots[this.uin].pickGroup(group_id)
  }

  pickMember(group_id: any, user_id: any) {
    return this.pickGroup(group_id).pickMember(user_id)
  }

  sendFriendMsg(bot_id: any, user_id: any, ...args: any[]) {
    try {
      if (!bot_id) return this.pickFriend(user_id).sendMsg(...args)
      if (this.uin.includes(bot_id) && this.bots[bot_id]) return this.bots[bot_id].pickFriend(user_id).sendMsg(...args)
      if (!args.length && this.pickFriend(bot_id, true)) return this.pickFriend(bot_id).sendMsg(user_id)

      const { promise, resolve, reject } = Promise.withResolvers<any>()
      const listener = (data: any) => {
        resolve(data.bot.pickFriend(user_id).sendMsg(...args))
        clearTimeout(timeout)
      }
      const timeout = setTimeout(() => {
        reject(Object.assign(Error('等待 Bot 上线超时'), { bot_id, user_id, args }))
        this.off(`connect.${bot_id}`, listener)
      }, 300000)
      this.once(`connect.${bot_id}`, listener)
      return promise
    } catch (err) {
      util.makeLog('error', ['发送好友消息错误', args, err], `${bot_id} => ${user_id}`, true)
    }
  }

  sendGroupMsg(bot_id: any, group_id: any, ...args: any[]) {
    try {
      if (!bot_id) return this.pickGroup(group_id).sendMsg(...args)
      if (this.uin.includes(bot_id) && this.bots[bot_id]) return this.bots[bot_id].pickGroup(group_id).sendMsg(...args)
      if (!args.length && this.pickGroup(bot_id, true)) return this.pickGroup(bot_id).sendMsg(group_id)

      const { promise, resolve, reject } = Promise.withResolvers<any>()
      const listener = (data: any) => {
        resolve(data.bot.pickGroup(group_id).sendMsg(...args))
        clearTimeout(timeout)
      }
      const timeout = setTimeout(() => {
        reject(Object.assign(Error('等待 Bot 上线超时'), { bot_id, group_id, args }))
        this.off(`connect.${bot_id}`, listener)
      }, 300000)
      this.once(`connect.${bot_id}`, listener)
      return promise
    } catch (err) {
      util.makeLog('error', ['发送群消息错误', args, err], `${bot_id} => ${group_id}`, true)
    }
  }

  /** 等待下一条符合条件的文本消息 */
  getTextMsg(fnc: any = () => true) {
    if (typeof fnc !== 'function') {
      const { self_id, user_id } = fnc
      fnc = (data: any) => data.self_id == self_id && data.user_id == user_id
    }

    const { promise, resolve } = Promise.withResolvers<string>()
    const listener = (data: any) => {
      try {
        if (!fnc(data)) return
        let msg = ''
        for (const i of data.message) if (i.type === 'text' && i.text) msg += i.text.trim()
        if (!msg) return
        resolve(msg)
        this.off('message', listener)
      } catch (err) {
        util.makeLog('error', err, data.self_id)
      }
    }
    this.on('message', listener)
    return promise
  }

  /** 等待主人消息 */
  getMasterMsg() {
    return this.getTextMsg((data: any) => cfg.master[data.self_id]?.includes(String(data.user_id)))
  }

  /** 给全部主人发送消息 */
  async sendMasterMsg(msg: any, bot_array?: any, sleep = 5000) {
    const ret: any = {}
    await Promise.allSettled(
      (Array.isArray(bot_array) ? bot_array : bot_array ? [bot_array] : Object.keys(cfg.master)).map(async (bot_id: string) => {
        ret[bot_id] = {}
        for (const user_id of cfg.master[bot_id] || []) {
          ret[bot_id][user_id] = this.sendFriendMsg(bot_id, user_id, msg)
          if (sleep) await util.sleep(sleep, ret[bot_id][user_id])
        }
      }),
    )
    return ret
  }

  makeForwardMsg(msg: any) {
    return { type: 'node', data: msg }
  }

  makeForwardArray(msg: any = [], node: any = {}) {
    const forward = []
    for (const message of Array.isArray(msg) ? msg : [msg]) forward.push({ ...node, message })
    return this.makeForwardMsg(forward)
  }

  async sendForwardMsg(send: any, msg: any) {
    const messages = []
    for (const { message } of Array.isArray(msg) ? msg : [msg]) messages.push(await send(message))
    return messages
  }

  /* ==================== 退出/重启 ==================== */

  async redisExit() {
    const redis = (globalThis as any).redis
    if (!(typeof redis === 'object' && redis.process)) return false
    const p = redis.process
    delete redis.process
    await util.sleep(
      5000,
      redis.save?.().catch(() => {}),
    )
    return p.kill()
  }

  async exit(code = 0) {
    await this.redisExit()
    if ((globalThis as any).start_type === 'pm2') return util.exec('pnpm stop')
    process.exit(code)
  }

  async restart() {
    const { default: loader } = await import('./loader.js')
    const { RESTART_CODE } = await import('./start.js')
    /** 先把计数写回，避免重启丢统计 */
    await loader.flushCount().catch(() => {})
    await this.redisExit()

    util.makeLog('mark', '正在重启…', 'Restart')
    try {
      this.server.close()
    } catch {}
    try {
      this.httpsServer?.close()
    } catch {}

    /** pm2 模式交给 pm2；其余模式以 255 退出，由守护进程/外部管理器在同一终端拉起 */
    if ((globalThis as any).start_type === 'pm2') {
      await util.exec('pnpm run restart')
      process.exit()
    }
    process.exit(RESTART_CODE)
  }
}
