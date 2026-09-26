/**
 * 云崽 ck 文件兼容层（框架内置，随 `#更新` 分发，不改任何第三方插件）
 *
 * 背景
 *   JiuLi 把米游社 ck 存在 `data/db/data.db`（genshin 插件的数据层），而大量云崽插件不看 DB，
 *   只按 `data/MysCookie/<qq>.yaml` 找 uid / ck —— 逍遥插件的 `#更新抽卡记录` 就是这么读的
 *   （`apps/user.js` → `gsCfg.getBingCookie`）。JiuLi 迁移到 DB 后这个文件就没了，插件永远读不到，
 *   表现就是 `uid:undefined,authkey获取失败：登录状态失效，请重新登录`。
 *
 * 做法
 *   1. 旁路捕获：用户粘贴 ck 的消息里带 `login_ticket`（DB 不保存这个字段，但米游社 stoken 要用），
 *      在 beforeMessage 里记到自己的数据目录；消息照常走 genshin 的绑定流程，绝不拦截。
 *   2. 导出：把 runtime 里的 uid / ck 按云崽 v3 的文件格式写回 `data/MysCookie/<qq>.yaml`。
 *      触发点：启动 online 后全量同步一次、ck 变动（首次绑定 / 重绑 / 删除）时补写、
 *      文件被删时按需重建（genshin 启动迁移会"导入即删"，所以导出必须放在它之后）。
 *
 * 注意
 *   - 只导出国服（`type: mys`）的 gs / sr uid：genshin 的迁移靠 `region_name` 猜游戏与类型，
 *     绝区零会被猜成 gs、国际服会被猜成 mys，导出去反而污染 DB；不导出时 genshin 会保留 DB 原值。
 *   - 文件由本插件维护，`data/MysCookie/` 里其它（云崽遗留）文件不动，仍交给 genshin 迁移处理。
 *   - 每次启动 genshin 迁移都会"重新导入 + 删掉"我们的文件（日志里的"DB导入V3用户ck N 个"），
 *     内容与 DB 镜像一致所以是无害的；导入完本插件会在 online 后重新写出来。
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { JiuLiPlugin, Runtime, logger } from 'jiuli'

/** 云崽 v3 的 ck 文件目录（生态插件按这个路径读） */
const COOKIE_DIR = path.join(process.cwd(), 'data', 'MysCookie')
/** genshin 启动迁移会把导入过的文件备份到这里，login_ticket 可以从这里捞回来 */
const BAK_DIR = path.join(process.cwd(), 'temp', 'MysCookieBak')
/** 游戏 → 云崽 v3 的 region_name：迁移用 `region_name === '星穹列车'` 判断星铁，其余认成原神 */
const GAME_REGION = { gs: '天空岛', sr: '星穹列车' }
/** 参与导出的游戏，见文件头注释 */
const EXPORT_GAMES = ['gs', 'sr']
/** 米游社 ck 的两个特征串 */
const TICKET_RE = /login_ticket=([^;\s&'"]+)/
const CK_RE = /(ltoken|cookie_token)/

const fileOf = qq => path.join(COOKIE_DIR, `${qq}.yaml`)

/**
 * 模块级状态
 *
 * beforeMessage / afterMessage 跑在加载期的共享实例上，而规则（#同步ck）跑在「每事件 new 一个」
 * 的实例上 —— 放在 this 上的状态两边不通，所以这里统一放模块级。
 */
let store = null
/** 本轮消息里捕获到 login_ticket 的用户（首次绑定时 ck 要等分发结束才入库） */
const pending = new Set()

function emptyStore() {
  return { tickets: {}, exported: {} }
}

export default class MysCookieCompat extends JiuLiPlugin {
  constructor() {
    super({
      name: '云崽ck兼容',
      dsc: '#同步ck',
      event: 'message',
      /** 只做旁路观察与补写，排在最后，不跟任何插件抢指令 */
      priority: Infinity,
      rule: [{ reg: '^#同步ck$', fnc: 'syncCk', permission: 'master', log: false }],
    })
  }

  async init() {
    this.loadStore()
    const sync = () => this.syncAll().catch(err => logger.debug(`[云崽ck兼容] 同步失败：${err}`))
    /**
     * online 在所有插件 init() 之后：genshin 的启动迁移（导入 data/MysCookie/ 后删文件）
     * 已经跑完，这时候导出的文件才不会被它吃掉。热重载 / 迟到加载时 online 早发过了，直接同步。
     */
    if (Bot.stat?.online === 2) sync()
    else Bot.once('online', sync)
  }

  /* ==================== 旁路捕获 ==================== */

  /**
   * 分发前：只观察，不拦截（返回 undefined）
   *
   * 粘贴的完整 ck 里有 login_ticket，DB 不存它，但米游社 stoken / genAuthKey 要用，
   * 而逍遥等插件又是从 `data/MysCookie/<qq>.yaml` 里取它的 —— 只能在这儿顺手记下来。
   */
  async beforeMessage(e) {
    const user = e.user
    const raw = String(e.raw_message || e.msg || '')
    if (raw.includes('login_ticket=') && CK_RE.test(raw)) {
      const qq = String(e.user_id || '')
      const ticket = TICKET_RE.exec(raw)?.[1]
      if (qq) {
        if (ticket) this.remember(qq, ticket)
        pending.add(qq)
        /** 已有 ck 的老用户重绑：文件立刻刷新；首次绑定等 afterMessage（那时 ck 才入库） */
        if (user?.hasCk) await this.writeUser(user, ticket)
        return
      }
    }

    /** 文件被删（例如 genshin 启动时"导入即删"）时按需重建，保证生态插件随时读得到 */
    if (user?.hasCk && !fs.existsSync(fileOf(user.qq))) await this.writeUser(user)
  }

  /** 分发后：ck 绑定已在本轮消息里完成，补写一次 */
  async afterMessage(e) {
    const qq = String(e.user_id || '')
    if (!qq || !pending.delete(qq)) return
    await this.writeUser(e.user, this.ticketOf(qq))
  }

  /* ==================== 导出 ==================== */

  /** 全量同步：runtime 里所有绑定过 ck 的用户 → data/MysCookie/<qq>.yaml */
  async syncAll() {
    const { NoteUser } = await Runtime.ecosystem()
    if (typeof NoteUser?.forEach !== 'function') return 0
    let count = 0
    await NoteUser.forEach(async user => {
      if (await this.writeUser(user)) count++
    })
    if (count > 0) logger.mark(`[云崽ck兼容] 已同步 ${count} 个用户的 ck → data/MysCookie/`)
    return count
  }

  /** 手动同步（#同步ck） */
  async syncCk() {
    const count = await this.syncAll()
    return this.reply(`已同步 ${count} 个用户的 ck → data/MysCookie/`)
  }

  /**
   * 写一个用户的兼容文件
   * @param user NoteUser（runtime 初始化过的 e.user）
   * @param loginTicket 本次消息里捕获到的 login_ticket（可选）
   */
  async writeUser(user, loginTicket = '') {
    const qq = String(user?.qq || '')
    if (!qq) return false
    const state = this.loadStore()

    /** ck 已删除：只清理我们导出过的文件，云崽遗留文件不动 */
    if (!user.hasCk) {
      if (state.exported[qq]) {
        if (fs.existsSync(fileOf(qq))) fs.unlinkSync(fileOf(qq))
        delete state.exported[qq]
        this.saveStore()
      }
      return false
    }

    const ticket = loginTicket || this.ticketOf(qq)
    const mainUid = String(user.getCkUid('gs') || '')
    const out = {}
    for (const ltuid in user.mysUsers) {
      const mys = user.mysUsers[ltuid]
      /** 只导出国服 ck，见文件头注释 */
      if (!mys?.ck || mys.type !== 'mys') continue
      for (const game of EXPORT_GAMES) {
        for (const uid of mys.uids?.[game] || []) {
          const id = String(uid)
          out[id] = {
            uid: id,
            qq,
            ltuid: mys.ltuid,
            ck: mys.ck,
            type: mys.type,
            device_id: mys.device,
            login_ticket: ticket,
            isMain: id === mainUid,
            region_name: GAME_REGION[game],
          }
        }
      }
    }

    if (!Object.keys(out).length) {
      if (state.exported[qq]) {
        if (fs.existsSync(fileOf(qq))) fs.unlinkSync(fileOf(qq))
        delete state.exported[qq]
        this.saveStore()
      }
      return false
    }
    /** 没有原神 ck-uid 时至少留一个 isMain：逍遥用 isMain 那条取 uid / game_uid */
    if (!Object.values(out).some(ds => ds.isMain)) Object.values(out)[0].isMain = true

    fs.mkdirSync(COOKIE_DIR, { recursive: true })
    fs.writeFileSync(
      fileOf(qq),
      `# 由 JiuLi「云崽ck兼容」自动维护：改 ck 请用 #绑定ck，不要手工编辑\n${YAML.stringify(out)}`,
      'utf8',
    )
    if (!state.exported[qq]) {
      state.exported[qq] = Date.now()
      this.saveStore()
    }
    return true
  }

  /* ==================== login_ticket 存取 ==================== */

  get storeFile() {
    return path.join(this.dataDir, 'mys-ck.json')
  }

  /** 读取（只读一次）login_ticket / 导出记录 */
  loadStore() {
    if (store) return store
    try {
      const raw = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'))
      store = { tickets: raw?.tickets || {}, exported: raw?.exported || {} }
    } catch {
      store = emptyStore()
    }
    return store
  }

  saveStore() {
    try {
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true })
      fs.writeFileSync(this.storeFile, JSON.stringify(store || emptyStore(), null, 2), 'utf8')
    } catch (err) {
      logger.debug(`[云崽ck兼容] 保存 login_ticket 失败：${err}`)
    }
  }

  remember(qq, ticket) {
    this.loadStore().tickets[qq] = { login_ticket: ticket, at: Date.now() }
    this.saveStore()
  }

  /** 优先用捕获到的，其次沿用上一次导出 / 迁移备份里的（老用户不用重新绑定） */
  ticketOf(qq) {
    const saved = this.loadStore().tickets[qq]?.login_ticket
    if (saved) return saved
    for (const file of [fileOf(qq), path.join(BAK_DIR, `${qq}.yaml`)]) {
      try {
        const data = YAML.parse(fs.readFileSync(file, 'utf8')) || {}
        for (const key in data) if (data[key]?.login_ticket) return data[key].login_ticket
      } catch {
        /* 文件不存在或格式不对，继续找下一个来源 */
      }
    }
    return ''
  }
}
