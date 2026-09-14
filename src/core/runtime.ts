/**
 * Runtime（e.runtime）
 *
 * 与云崽的差异（性能改进）：
 * - TRSS 在每条消息都 await Runtime.init(e)，内部执行 MysInfo.initCache() 与
 *   NoteUser.create(e)（redis + DB 操作），即使这条消息没有任何插件处理。
 * - JiuLi 默认只做一次轻量对象创建；只有当第三方（如 genshin 生态）通过
 *   Runtime.use() 注册了扩展时，才会执行其 user 初始化，且可由插件按需调用。
 */
import type { JiuLiEvent, RenderOptions } from './types.js'
import cfg from './config/index.js'
import common from './common.js'
import Handler from './handler.js'
import { logger } from './log.js'

export interface RuntimeProvider {
  name: string
  /** 是否需要在分发前初始化用户信息 */
  eagerUser?: boolean
  initUser?: (e: JiuLiEvent, runtime: Runtime) => any
  getMysInfo?: (e: JiuLiEvent, targetType: string, runtime: Runtime) => any
  getUid?: (e: JiuLiEvent, runtime: Runtime) => any
  createMysApi?: (uid: any, ck: any, option: any, isSr: boolean, runtime: Runtime) => any
}

/** genshin 生态的懒加载入口（存在时启用，不存在时全为 undefined） */
const genshin: Record<string, any> = { loaded: false }

async function loadGenshin() {
  if (genshin.loaded) return genshin
  genshin.loaded = true
  const tryImport = async (spec: string) => {
    try {
      return (await import(spec)).default
    } catch {
      return undefined
    }
  }
  genshin.gsCfg = await tryImport('../../plugins/genshin/model/gsCfg.js')
  genshin.MysApi = await tryImport('../../plugins/genshin/model/mys/mysApi.js')
  genshin.MysInfo = await tryImport('../../plugins/genshin/model/mys/mysInfo.js')
  genshin.NoteUser = await tryImport('../../plugins/genshin/model/mys/NoteUser.js')
  genshin.MysUser = await tryImport('../../plugins/genshin/model/mys/MysUser.js')
  genshin.Version = await tryImport('#miao')
  if (genshin.Version) genshin.Version = genshin.Version.Version
  return genshin
}

export default class Runtime {
  static providers: RuntimeProvider[] = []

  /** 注册扩展（第三方生态接入点） */
  static use(provider: RuntimeProvider) {
    this.providers.push(provider)
    return this
  }

  e: JiuLiEvent
  handler: { has: typeof Handler.has; call: typeof Handler.call; callAll: typeof Handler.callAll }
  private _mysInfo: Record<string, any> = {}
  private _userReady?: Promise<any>

  constructor(e: JiuLiEvent) {
    this.e = e
    this.handler = {
      has: Handler.has,
      call: Handler.call,
      callAll: Handler.callAll,
    }
  }

  /** 兼容：云崽在分发前调用 Runtime.init(e) */
  static async init(e: JiuLiEvent) {
    const runtime = new Runtime(e)
    e.runtime = runtime
    if (Runtime.providers.some(p => p.eagerUser)) await runtime.ready()
    return runtime
  }

  /** JiuLi：轻量挂载，重活留给首次访问 */
  static attach(e: JiuLiEvent) {
    if (e.runtime) return e.runtime
    const runtime = new Runtime(e)
    Object.defineProperty(e, 'runtime', {
      value: runtime,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    if (Runtime.providers.length) runtime.ready().catch(() => {})
    return runtime
  }

  /** 用户信息初始化（懒） */
  ready() {
    this._userReady ??= (async () => {
      for (const provider of Runtime.providers) if (provider.initUser) await provider.initUser(this.e, this)
      if (!Runtime.providers.length) {
        const g = await loadGenshin()
        if (g.NoteUser) await this.initUser()
      }
      return this
    })()
    return this._userReady
  }

  get uid() {
    return this.user?.uid
  }

  get hasCk() {
    return this.user?.hasCk
  }

  get user() {
    return this.e.user
  }

  get cfg() {
    return cfg
  }

  get common() {
    return common
  }

  get gsCfg() {
    return genshin.gsCfg
  }

  get MysInfo() {
    return genshin.MysInfo
  }

  get NoteUser() {
    return genshin.NoteUser
  }

  get MysUser() {
    return genshin.MysUser
  }

  /** 旧生态用户代理（与云崽行为一致，仅在 genshin 存在时生效） */
  async initUser() {
    const g = await loadGenshin()
    if (!g.NoteUser) return
    const e = this.e
    const user = await g.NoteUser.create(e)
    if (user) {
      e.user = new Proxy(user, {
        get(self: any, key: string) {
          const game = e.game
          const fnMap: Record<string, string> = {
            uid: 'getUid',
            uidList: 'getUidList',
            mysUser: 'getMysUser',
            ckUidList: 'getCkUidList',
          }
          if (fnMap[key]) return self[fnMap[key]](game)
          if (key === 'uidData') return self.getUidData('', game)
          if (['getUid', 'getUidList', 'getMysUser', 'getCkUidList', 'getUidMapList', 'getGameDs'].includes(key))
            return (_game: string, arg2: any) => self[key](_game || game, arg2)
          if (['getUidData', 'hasUid', 'addRegUid', 'delRegUid', 'setMainUid'].includes(key))
            return (uid: any, _game = '') => self[key](uid, _game || game)
          return self[key]
        },
      })
    }
  }

  async getMysInfo(targetType = 'all') {
    for (const provider of Runtime.providers)
      if (provider.getMysInfo) return provider.getMysInfo(this.e, targetType, this)

    const g = await loadGenshin()
    if (!g.MysInfo) return false
    if (!this._mysInfo[targetType])
      this._mysInfo[targetType] = await g.MysInfo.init(this.e, targetType === 'cookie' ? 'detail' : 'roleIndex')
    return this._mysInfo[targetType]
  }

  async getUid() {
    for (const provider of Runtime.providers) if (provider.getUid) return provider.getUid(this.e, this)
    const g = await loadGenshin()
    return g.MysInfo ? g.MysInfo.getUid(this.e) : undefined
  }

  async getMysApi(targetType = 'all', option: any = {}, isSr = false) {
    for (const provider of Runtime.providers)
      if (provider.createMysApi) {
        const mys = await this.getMysInfo(targetType)
        if (!mys?.uid || !mys?.ckInfo?.ck) return false
        return provider.createMysApi(mys.uid, mys.ckInfo.ck, option, isSr, this)
      }

    const mys: any = await this.getMysInfo(targetType)
    const g = await loadGenshin()
    if (mys?.uid && mys?.ckInfo?.ck && g.MysApi) {
      if (isSr) option.game = 'sr'
      return new g.MysApi(mys.uid, mys.ckInfo.ck, option)
    }
    return false
  }

  createMysApi(uid: any, ck: any, option: any, isSr = false) {
    for (const provider of Runtime.providers)
      if (provider.createMysApi) return provider.createMysApi(uid, ck, option, isSr, this)
    if (isSr) option.game = 'sr'
    if (!genshin.MysApi) return false
    return new genshin.MysApi(uid, ck, option)
  }

  /**
   * 渲染（兼容云崽 e.runtime.render）
   * @param pluginName plugin key
   * @param path html 文件路径，相对于 plugin resources 目录
   * @param data 渲染数据
   * @param cfg.retType default/空 自动发送图片；msgId 返回消息 id；base64 返回 base64
   * @param cfg.beforeRender({data}) 可改写渲染的 data
   */
  async render(pluginName: string, path: string, data: any = {}, cfgIn: RenderOptions = {}) {
    const { default: renderService } = await import('./render/index.js')

    let filePath = path.replace(/.html$/, '')
    const paths = filePath.split('/').filter(Boolean)
    filePath = paths.join('/')

    await (globalThis as any).Bot.mkdir(`temp/html/${pluginName}/${filePath}`)

    const up = '../'.repeat(paths.length)
    const pluResPath = `../../../${up}plugins/${pluginName}/resources/`
    const miaoResPath = `../../../${up}plugins/miao-plugin/resources/`
    const miaoRoot = `${process.cwd()}/plugins/miao-plugin/resources/`

    let out = {
      sys: { scale: 1 },
      copyright: `Created By JiuLi`,
      _res_path: pluResPath,
      _miao_path: miaoResPath,
      _tpl_path: `${miaoRoot}common/tpl/`,
      defaultLayout: `${miaoRoot}common/layout/default.html`,
      elemLayout: `${miaoRoot}common/layout/elem.html`,

      ...data,

      _plugin: pluginName,
      _htmlPath: filePath,
      pluResPath,
      tplFile: `./plugins/${pluginName}/resources/${filePath}.html`,
      saveId: data.saveId || data.save_id || paths[paths.length - 1],
    }

    if (cfgIn.beforeRender) out = cfgIn.beforeRender({ data: out }) || out

    if (process.argv.includes('dev')) {
      const saveDir = `temp/ViewData/${pluginName}`
      await (globalThis as any).Bot.mkdir(saveDir)
      const file = `${saveDir}/${out._htmlPath.split('/').join('_')}.json`
      const fs = await import('node:fs/promises')
      await fs.writeFile(file, JSON.stringify(out))
    }

    const base64 = await renderService.screenshot(`${pluginName}/${filePath}`, out)
    if (cfgIn.retType === 'base64') return base64

    let ret: any = true
    if (base64) {
      if (cfgIn.recallMsg) ret = await this.e.reply?.(base64, false, {})
      else ret = await this.e.reply?.(base64)
    }
    return cfgIn.retType === 'msgId' ? ret : true
  }
}

export { logger }
