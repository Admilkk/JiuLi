import EventListener from '../listener/listener.js'

/**
 * 监听请求事件
 */
export default class requestEvent extends EventListener {
  constructor() {
    super({ event: 'request' })
  }

  async execute(e) {
    this.plugins.deal(e)
  }
}
