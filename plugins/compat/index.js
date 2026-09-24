/**
 * JiuLi 生态兼容宿主（v2）
 *
 * 这是「一个云崽插件」，负责把 Koishi / GsCore / AstrBot 的插件接进 JiuLi 的分发流程：
 *
 *   JiuLi 收到消息 → loader.deal(e) → 补全 e.msg / 别名 / 权限 / 冷却
 *     → beforeMessage 钩子（本插件）→ 转发给各生态宿主
 *     → 任一外来插件真的回了消息就返回 false，拦截云崽插件的规则匹配
 *
 * 为什么用 beforeMessage 钩子而不是自己监听 Bot 事件：
 * 钩子跑在内核补全 `e`（msg / atBot / isGroup / isMaster / 别名剥离 / 黑白名单 / 冷却）
 * 之后、云崽插件规则匹配之前，既有完整上下文，又能决定是否拦截，还不用重复实现一遍权限与限流。
 *
 * 为什么继承 lib/core/plugin.js：
 * 内核只对「有 init() 的插件类」调用 init/onLoad（见 loader.loadPlugin），
 * 普通类写了 onLoad 也不会被执行，而且拿不到 priority 参与排序。
 *
 * 为什么延迟到 online 再启动宿主：
 * 插件 init 阶段适配器还没加载（bot.run 里 PluginsLoader.load() 在 loadEvents() 之前），
 * 此时拿不到任何账号，宿主想主动发消息会失败。
 */
import BasePlugin from '../../lib/core/plugin.js'
import { compat, getConfig } from '../../lib/compat/index.js'

/** online 监听与启动状态（模块级：热重载时旧实例的清理函数要能被新实例接住） */
const state = {
  started: false,
  starting: null,
  off: null,
}

async function boot() {
  if (state.starting) return state.starting
  state.starting = (async () => {
    try {
      /** 先停掉上一轮（热重载场景），避免重复启动 koishi 或重复拉起 Python 子进程 */
      await compat.stop()
      await compat.start(getConfig())
      state.started = true
    } finally {
      state.starting = null
    }
  })()
  return state.starting
}

class EcoBridgeBase extends BasePlugin {
  constructor(name, event) {
    super({
      name,
      dsc: '加载其它生态的插件（Koishi / GsCore / AstrBot）',
      event,
      /** 极小优先级：在所有云崽插件之前拿到消息（内核 runHooks 按 priority 排序） */
      priority: -1e9,
    })
  }

  async init() {
    if (!getConfig().enabled) return
    const Bot = globalThis.Bot
    /** 已经 online（热重载场景）就直接启动，否则等内核把所有适配器拉起来 */
    if (Bot?.stat?.online >= 2) {
      await boot()
      return
    }
    if (state.off) return
    const onOnline = () => {
      void boot()
    }
    Bot?.once?.('online', onOnline)
    state.off = () => Bot?.off?.('online', onOnline)
  }

  /** 返回 false = 拦截本次分发（外来插件已处理） */
  async beforeMessage(e) {
    /** 还在启动（koishi 首次 import / Python 进程冷启动有耗时）时不拦截，交给云崽插件先响应 */
    if (!state.started) return undefined
    return (await compat.dispatch(e)) ? false : undefined
  }

  async onUnload() {
    state.off?.()
    state.off = null
    state.started = false
    await compat.stop()
  }
}

/** 消息事件 */
export class EcoBridge extends EcoBridgeBase {
  constructor() {
    super('生态兼容', 'message')
  }
}

/** 通知事件（戳一戳 / 进退群等） */
export class EcoNoticeBridge extends EcoBridgeBase {
  constructor() {
    super('生态兼容(通知)', 'notice')
  }
}

/** 请求事件（加好友 / 加群） */
export class EcoRequestBridge extends EcoBridgeBase {
  constructor() {
    super('生态兼容(请求)', 'request')
  }
}

export default EcoBridge
