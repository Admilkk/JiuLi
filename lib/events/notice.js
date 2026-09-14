import EventListener from '../listener/listener.js'

/**
 * 监听通知事件
 */
export default class noticeEvent extends EventListener {
  constructor() {
    super({ event: 'notice' })
  }

  async execute(e) {
    this.plugins.deal(e)
  }
}
