/**
 * 事件监听器基类与加载器
 *
 * 兼容云崽 lib/listener/listener.js：
 * - 用户可在 lib/events/ 下新增 .js 监听器（默认导出 EventListener 子类）
 * - 适配器在 Bot.adapter 中注册，load() 时被调用
 */
import fs from 'node:fs/promises'
import util from './util.js'
import PluginsLoader from './loader.js'

export default class EventListener {
  prefix: string
  event: string | string[]
  once: boolean
  plugins = PluginsLoader

  /**
   * @param data.prefix 事件名称前缀
   * @param data.event 监听的事件
   * @param data.once 是否只监听一次
   */
  constructor(data: { prefix?: string; event: string | string[]; once?: boolean }) {
    this.prefix = data.prefix || ''
    this.event = data.event
    this.once = data.once || false
  }
}

export class ListenerLoader {
  /** 加载监听事件与适配器 */
  async load() {
    const Bot = (globalThis as any).Bot

    util.makeLog('info', '加载事件监听器 lib/events/ …', 'Listener')
    const files = (await fs.readdir('./lib/events').catch(() => [] as string[])).filter(f => f.endsWith('.js'))
    const eventPromise = files.map(file => this.loadEvent(file))
    await Promise.allSettled(eventPromise)
    util.makeLog('info', `事件监听器 ${eventPromise.length} 个`, 'Listener')

    util.makeLog('info', '加载适配器 …', 'Adapter')
    const adapters = [...(Bot.adapter as any[])]
    const adapterPromise = adapters.map(adapter => this.loadAdapter(adapter))
    await Promise.allSettled(adapterPromise)
    const names = adapters.map((a: any) => `${a.name}(${a.id})`).join(' · ')
    util.makeLog('info', `适配器 ${adapterPromise.length} 个${names ? ` · ${names}` : ''}`, 'Adapter')
  }

  async loadEvent(file: string) {
    util.makeLog('debug', [`加载监听事件 ${file}`], 'Listener')
    try {
      let listener: any = await import(`../events/${file}`)
      if (!listener.default) return
      listener = new listener.default()
      const Bot = (globalThis as any).Bot
      const on = listener.once ? 'once' : 'on'

      for (const type of Array.isArray(listener.event) ? listener.event : [listener.event]) {
        const fnc = listener[type] ? type : 'execute'
        Bot[on](listener.prefix + type, listener[fnc].bind(listener))
      }
    } catch (err) {
      util.makeLog('error', [`监听事件加载错误 ${file}`, err], 'Listener')
    }
  }

  async loadAdapter(adapter: any) {
    util.makeLog('debug', [`加载适配器 ${adapter.name}(${adapter.id})`], 'Adapter')
    try {
      await adapter.load()
    } catch (err) {
      util.makeLog('error', [`适配器加载错误 ${adapter.name}(${adapter.id})`, err], 'Adapter')
    }
  }
}

export const listenerLoader = new ListenerLoader()

export async function loadEvents() {
  return listenerLoader.load()
}
