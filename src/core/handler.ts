/**
 * 跨插件 handler 总线（兼容云崽 Handler）
 *
 * Handler.add({ ns, key|event, fn, self, priority })
 * Handler.call(key, e, args) → 依优先级调用，返回第一个非 reject 的结果
 */
import { logger } from './log.js'

interface HandlerItem {
  priority: number
  fn: (...args: any[]) => any
  ns: string
  self: any
  key: string
}

const events: Record<string, HandlerItem[]> = {}

const Handler = {
  add(cfg: { ns: string; fn: any; self?: any; priority?: number; key?: string; event?: string }) {
    const { ns, fn, self, priority = 500 } = cfg
    const key = cfg.key || cfg.event
    if (!key || !fn) return
    Handler.del(ns, key)
    logger.mark(`[Handler][Reg]: [${ns}][${key}]`)
    events[key] = events[key] || []
    events[key].push({ priority, fn, ns, self, key })
    events[key].sort((a, b) => a.priority - b.priority)
  },

  del(ns: string, key = '') {
    if (!key) {
      for (const i in events) Handler.del(ns, i)
      return
    }
    if (!events[key]) return
    events[key] = events[key].filter(handler => handler.ns !== ns)
    if (!events[key].length) delete events[key]
  },

  async callAll(key: string, e: any, args?: any) {
    return Handler.call(key, e, args, true)
  },

  async call(key: string, e: any, args?: any, allHandler = false) {
    let ret
    for (const obj of events[key] ?? []) {
      let done = true
      const reject = (msg = '') => {
        if (msg) logger.mark(`[Handler][Reject]: [${obj.ns}][${key}] ${msg}`)
        done = false
      }
      ret = await obj.fn.call(obj.self, e, args, reject)
      if (done && !allHandler) {
        logger.mark(`[Handler][Done]: [${obj.ns}][${key}]`)
        return ret
      }
    }
    return ret
  },

  has(key: string) {
    return !!events[key]
  },

  list() {
    return events
  },
}

export default Handler
