import EventListener from '../listener/listener.js'

export default class onlineEvent extends EventListener {
  constructor() {
    super({
      event: 'online',
      once: true,
    })
  }

  async execute() {
    // getTimeDiff 仅新版内核提供，旧核心下省略耗时
    const cost = typeof Bot?.getTimeDiff === 'function' ? Bot.getTimeDiff() : ''
    logger.mark(`──────── 启动完成${cost ? ` · 总耗时 ${cost}` : ''} ────────`)
  }
}
