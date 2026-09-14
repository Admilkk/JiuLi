import EventListener from '../listener/listener.js'

/**
 * 监听上线事件
 */
export default class onlineEvent extends EventListener {
  constructor() {
    super({
      event: 'online',
      once: true,
    })
  }

  async execute() {
    const cost = typeof Bot?.getTimeDiff === 'function' ? Bot.getTimeDiff() : ''
    logger.mark(`──────── 启动完成${cost ? ` · 总耗时 ${cost}` : ''} ────────`)
  }
}
