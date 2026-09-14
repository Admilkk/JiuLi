/**
 * 插件基类（兼容云崽 plugin，旧插件 `extends plugin` 零改动）
 *
 * 同时作为 JiuLi 原生类形态插件的基类（见 src/index.ts 的 JiuLiPlugin）
 */
import type { JiuLiEvent, PluginOptions, Rule, Task, HandlerConfig } from './types.js'

const stateArr: Record<string, Record<string, any>> = {}
const SymbolTimeout = Symbol('Timeout')
const SymbolResolve = Symbol('Resolve')

export default class plugin {
  /** 插件名称 */
  name: string
  /** 插件描述 */
  dsc: string
  /** 监听事件，默认 message */
  event: string
  /** 优先级，数字越小优先级越高 */
  priority: number
  /** 定时任务 */
  task: Task | Task[]
  /** 命令规则 */
  rule: Rule[]
  /** 跨插件 handler */
  handler?: HandlerConfig | HandlerConfig[]
  /** handler 命名空间 */
  namespace?: string

  /** 当前事件（由 loader 注入） */
  e!: JiuLiEvent
  /** 上下文相关字段（旧插件常用 this.group_id / this.user_id / this.self_id 简化写法） */
  [key: string]: any

  constructor({
    name = 'your-plugin',
    dsc = '无',
    handler,
    namespace,
    event = 'message',
    priority = 5000,
    task = { name: '', fnc: '', cron: '' },
    rule = [],
  }: PluginOptions = {}) {
    this.name = name
    this.dsc = dsc
    this.event = event
    this.priority = priority
    this.task = task
    this.rule = rule

    if (handler) {
      this.handler = handler
      this.namespace = namespace || ''
    }
  }

  /**
   * 回复消息
   * @param msg 发送的消息
   * @param quote 是否引用回复
   * @param data.recallMsg 群聊是否撤回消息，0-120秒，0不撤回
   * @param data.at 是否at用户
   */
  reply(msg: any = '', quote = false, data: any = {}) {
    if (!this.e?.reply || !msg) return false
    return this.e.reply(msg, quote, data)
  }

  conKey(isGroup = false) {
    return `${this.name}.${this.self_id || this.e.self_id}.${
      isGroup ? this.group_id || this.e.group_id : this.user_id || this.e.user_id
    }`
  }

  /**
   * 设置上下文
   * @param type 执行方法
   * @param isGroup 是否群聊
   * @param time 操作时间（秒）
   * @param timeout 操作超时回复
   */
  setContext(type: string, isGroup?: boolean, time = 120, timeout = '操作超时已取消') {
    const key = this.conKey(isGroup)
    stateArr[key] ??= {}
    const oldContext = stateArr[key][type]
    if (oldContext) {
      clearTimeout(oldContext[SymbolTimeout])
      oldContext[SymbolResolve]?.(false)
    }

    const context = this.e as any
    stateArr[key][type] = context
    if (time)
      context[SymbolTimeout] = setTimeout(() => {
        if (stateArr[key]?.[type] !== context) return
        const resolve = context[SymbolResolve]
        delete stateArr[key][type]
        if (!Object.keys(stateArr[key]).length) delete stateArr[key]
        resolve ? resolve(false) : this.reply(timeout, true)
      }, time * 1000)
    return context
  }

  getContext(type?: string, isGroup?: boolean) {
    if (type) return stateArr[this.conKey(isGroup)]?.[type]
    return stateArr[this.conKey(isGroup)]
  }

  finish(type: string, isGroup?: boolean) {
    const key = this.conKey(isGroup)
    const context = stateArr[key]?.[type]
    if (context) {
      clearTimeout(context[SymbolTimeout])
      delete stateArr[key][type]
      if (!Object.keys(stateArr[key]).length) delete stateArr[key]
    }
  }

  awaitContext(...args: any[]) {
    return new Promise(resolve => ((this.setContext('resolveContext', ...args) as any)[SymbolResolve] = resolve))
  }

  resolveContext(context: any) {
    this.finish('resolveContext')
    context?.[SymbolResolve]?.(this.e)
  }

  /**
   * 渲染图片并发送
   * 优先使用 miao-plugin 的 Common.render（旧生态布局），不可用时走内核渲染
   */
  async renderImg(pluginName: string, tpl: string, data: any = {}, cfg: any = {}) {
    const spec = '#miao'
    try {
      const miao: any = await import(spec)
      return miao.Common.render(pluginName, tpl, data, { ...cfg, e: this.e })
    } catch {
      const Runtime = (await import('./runtime.js')).default
      const runtime = this.e?.runtime ?? Runtime.attach(this.e)
      return runtime.render(pluginName, tpl, data, { ...cfg })
    }
  }
}

export { stateArr }
