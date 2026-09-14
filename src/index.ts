/**
 * JiuLi 原生插件 API
 *
 * 三种插件形态并存，同一套内核：
 * 1. 旧插件：`export class X extends plugin {}`（走 lib/ 兼容层，零改动）
 * 2. 原生类形态：`export default class X extends JiuLiPlugin {}`
 * 3. 原生 DSL：`export default definePlugin({ name, apps: [command(...), task(...)] })`
 *
 * 插件通过 `import { ... } from 'jiuli'` 使用本模块。
 */
import fs from 'node:fs'
import BasePlugin from './core/plugin.js'
import type { JiuLiEvent, Rule, Task, HandlerConfig, PluginOptions, RenderOptions } from './core/types.js'
import { logger, chalk } from './core/log.js'
import cfg from './core/config/index.js'

export type {
  JiuLiEvent,
  Rule,
  Task,
  HandlerConfig,
  PluginOptions,
  RenderOptions,
  Adapter,
  Segment,
  Sender,
  ReplyData,
  PluginMetric,
} from './core/types.js'

export { logger, chalk }
export { default as cfg } from './core/config/index.js'
export { default as util } from './core/util.js'
export { default as segment, getSegment } from './core/segment.js'
export { default as metrics } from './core/metrics.js'
export { default as Runtime } from './core/runtime.js'
export { default as Handler } from './core/handler.js'
export { default as renderService } from './core/render/index.js'
export { default as common } from './core/common.js'
export { default as makeConfig, watcher as configWatcher } from './core/plugin-config.js'

/** 当前 Bot 实例（即 globalThis.Bot） */
export function getBot(): any {
  return (globalThis as any).Bot
}

/** JiuLi 原生插件基类 */
export class JiuLiPlugin extends BasePlugin {
  /** 插件目录名（loader 注入），渲染与数据目录按它定位 */
  declare __key: string
  /** 当前事件 */
  declare e: JiuLiEvent

  /** 插件私有数据目录 data/plugins/<插件名>，首次访问自动创建 */
  get dataDir(): string {
    const dir = `data/plugins/${this.__key || this.name}`
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 插件私有配置目录 resources 路径前缀（渲染模板里用 pluResPath 即可） */
  get resDir(): string {
    return `plugins/${this.__key || this.name}/resources/`
  }

  /**
   * 渲染模板为图片（不发送）
   * @param tpl 模板路径，相对插件 resources 目录，如 'help/index'
   * @param data 模板数据
   * @param opts 渲染选项；retType 默认 base64
   */
  async render(tpl: string, data: any = {}, opts: RenderOptions = {}) {
    const plugin = this.__key || this.name
    if (this.e?.runtime?.render) return this.e.runtime.render(plugin, tpl, data, { retType: 'base64', ...opts })

    /** 未经过分发（如定时任务）时的兜底渲染 */
    const { default: renderService } = await import('./core/render/index.js')
    const paths = String(tpl).replace(/\.html$/, '').split('/').filter(Boolean)
    const up = '../'.repeat(paths.length)
    const tplData = {
      sys: { scale: 1 },
      ...data,
      _plugin: plugin,
      _htmlPath: paths.join('/'),
      pluResPath: `../../../${up}plugins/${plugin}/resources/`,
      _res_path: `../../../${up}plugins/${plugin}/resources/`,
      tplFile: `./plugins/${plugin}/resources/${paths.join('/')}.html`,
      saveId: data.saveId || paths[paths.length - 1],
    }
    const img = await renderService.render(`${plugin}/${paths.join('/')}`, tplData)
    if (!img) return false
    if (opts.retType === 'base64') return `base64://${Buffer.from(img).toString('base64')}`
    return img
  }
}

/* ==================== 函数 DSL ==================== */

export interface CommandOptions {
  event?: string
  permission?: 'master' | 'owner' | 'admin' | 'all' | string
  log?: boolean
  priority?: number
  /** 日志中显示的名称 */
  name?: string
}

export interface AppDescriptor {
  __type: 'command' | 'task' | 'accept' | 'handler'
  [key: string]: any
}

/**
 * 命令：正则 → 处理函数
 * @param reg 命令正则
 * @param fnc 处理函数，(e, match) => any；返回 false 继续匹配后续规则
 * @param options 事件/权限/日志/优先级
 */
export function command(
  reg: RegExp | string,
  fnc: (e: JiuLiEvent, match?: RegExpMatchArray) => any,
  options: CommandOptions = {},
): AppDescriptor {
  return { __type: 'command', reg, fnc, ...options }
}

/**
 * 定时任务
 * @param cron cron 表达式（5/6 段）
 * @param fnc 执行函数
 * @param options name 任务名；log false 不显示日志；skip 上次未完成时跳过
 */
export function task(
  cron: string,
  fnc: (...args: any[]) => any,
  options: { name?: string; log?: boolean; skip?: boolean } = {},
): AppDescriptor {
  return { __type: 'task', cron, fnc, ...options }
}

/**
 * 事件监听（通知/请求等），等价于插件级 accept
 * @param event 事件名，如 notice.group.poke / request.friend
 * @param fnc 处理函数
 */
export function accept(event: string, fnc: (e: JiuLiEvent) => any, options: { priority?: number } = {}): AppDescriptor {
  return { __type: 'accept', event, fnc, ...options }
}

/**
 * 注册跨插件 handler
 * @param key handler key，其他插件可用 e.runtime.handler.call(key, e, args)
 */
export function handler(key: string, fnc: (...args: any[]) => any, options: { priority?: number } = {}): AppDescriptor {
  return { __type: 'handler', key, fnc, ...options }
}

export interface DefinePluginOptions {
  name: string
  dsc?: string
  priority?: number
  /** 插件级事件，默认取第一个 accept / command 的 event，否则 message */
  event?: string
  apps?: AppDescriptor[]
}

/**
 * 定义插件（返回可被内核加载的类）
 *
 * ```ts
 * export default definePlugin({
 *   name: '示例',
 *   apps: [
 *     command(/^#示例$/, async e => e.reply('hi')),
 *     task('0 8 * * *', async () => logger.mark('早上好')),
 *   ],
 * })
 * ```
 */
export function definePlugin(options: DefinePluginOptions) {
  const { name = 'jiuli-plugin', dsc = '无', priority = 5000, apps = [] } = options
  const commands = apps.filter(a => a.__type === 'command')
  const tasks = apps.filter(a => a.__type === 'task')
  const accepts = apps.filter(a => a.__type === 'accept')
  const handlers = apps.filter(a => a.__type === 'handler')
  const pluginEvent =
    options.event ??
    accepts[0]?.event ??
    commands.find(c => c.event)?.event ??
    tasks.find(t => t.event)?.event ??
    'message'

  const named = (fn: any, fnName: string) => {
    try {
      Object.defineProperty(fn, 'name', { value: fnName, configurable: true })
    } catch {}
    return fn
  }

  return class extends JiuLiPlugin {
    constructor(e?: any) {
      super({ name, dsc, priority, event: pluginEvent } as PluginOptions)
      void e

      this.rule = commands.map(c => ({
        reg: c.reg,
        event: c.event,
        permission: c.permission,
        log: c.log,
        priority: c.priority,
        fnc: named((ev: JiuLiEvent, match?: RegExpMatchArray) => c.fnc.call(this, ev, match), c.name || 'command'),
      })) as Rule[]

      this.task = tasks.map(t => ({
        name: t.name ?? name,
        cron: t.cron,
        log: t.log,
        fnc: named((...args: any[]) => t.fnc.call(this, ...args), t.name || 'task'),
      })) as Task[]

      if (accepts.length) {
        this.accept = named((ev: JiuLiEvent) => accepts[0].fnc.call(this, ev), `${name}:accept`)
      }

      if (handlers.length) {
        this.handler = handlers.map(h => ({
          key: h.key,
          priority: h.priority,
          fnc: named((...args: any[]) => h.fnc.call(this, ...args), `${name}:${h.key}`),
        })) as HandlerConfig[]
        this.namespace ||= name
      }
    }

    /** DSL 形态下插件级 accept（动态注入） */
    declare accept?: (e: JiuLiEvent) => any
  }
}

/** 兼容别名：definePlugin 返回的类也可直接当 plugin 用 */
export default { JiuLiPlugin, definePlugin, command, task, accept, handler, getBot, cfg, logger, segment: undefined as any }
