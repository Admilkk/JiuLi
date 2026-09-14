/**
 * JiuLi 公共类型定义
 *
 * 设计原则：
 * - 事件对象保持云崽（TRSS-Yunzai）的字段名，保证旧插件零改动
 * - 通过索引签名允许插件自由扩展字段
 * - 新增能力（store / raw / contact 等）作为可选字段补充
 */

/** 消息元素（segment） */
export interface Segment {
  type: string
  [key: string]: unknown
}

/** 发送者信息 */
export interface Sender {
  user_id?: string | number
  nickname?: string
  card?: string
  role?: string
  [key: string]: unknown
}

/** e.reply 的可选参数 */
export interface ReplyData {
  /** 撤回消息，0-120 秒，0 不撤回 */
  recallMsg?: number
  /** 是否 at 用户 */
  at?: boolean | string | number
  [key: string]: unknown
}

/** 事件对象（兼容云崽字段命名） */
export interface JiuLiEvent {
  [key: string]: any

  post_type: string
  message_type?: string
  notice_type?: string
  request_type?: string
  sub_type?: string

  self_id: string | number
  user_id?: string | number
  group_id?: string | number
  message_id?: string | number

  raw_message?: string
  message?: Segment[]

  /** loader 注入：文本消息 */
  msg?: string
  /** loader 注入：图片 url 数组 */
  img?: string[]
  /** loader 注入：被 at 的用户 */
  at?: string | number
  /** loader 注入：是否 at 机器人 */
  atBot?: boolean
  /** 是否群聊 / 私聊 */
  isGroup?: boolean
  isPrivate?: boolean
  /** 是否主人 */
  isMaster?: boolean
  /** 引用回复的消息 id */
  reply_id?: string | number
  /** 是否存在别名触发 */
  hasAlias?: boolean
  /** 只关注主动 at 的消息 */
  only_reply_at?: boolean

  sender?: Sender
  bot?: any
  friend?: any
  group?: any
  member?: any

  /** 回复消息 */
  reply?: (msg: any, quote?: boolean, data?: ReplyData) => Promise<any>
  /** 撤回消息 */
  recall?: (time?: number) => any
  /** 获取引用消息 */
  getReply?: () => any
  /** 运行时扩展（懒加载） */
  runtime?: any
  /** 插件链内数据传递 */
  store?: Map<string, unknown>
  /** 协议原始事件 */
  raw?: unknown
}

/** 命令规则 */
export interface Rule {
  /** 命令正则 */
  reg: RegExp | string
  /** 执行方法名，或直接传入函数（JiuLi 原生写法） */
  fnc: string | ((e: JiuLiEvent, match?: RegExpMatchArray) => any)
  /** 执行事件，默认 message */
  event?: string
  /** false 时不显示执行日志 */
  log?: boolean
  /** 权限 master / owner / admin / all */
  permission?: 'master' | 'owner' | 'admin' | 'all' | string
  [key: string]: any
}

/** 定时任务 */
export interface Task {
  name?: string
  /** cron 表达式 */
  cron: string
  /** 执行方法名，或直接传入函数 */
  fnc: string | ((...args: any[]) => any)
  /** false 时不显示执行日志 */
  log?: boolean
  [key: string]: any
}

/** 跨插件 handler */
export interface HandlerConfig {
  key?: string
  event?: string
  fnc: string | ((...args: any[]) => any)
  priority?: number
  ns?: string
  [key: string]: any
}

/** 插件构造参数 */
export interface PluginOptions {
  name?: string
  dsc?: string
  event?: string
  priority?: number
  rule?: Rule[]
  task?: Task | Task[]
  handler?: HandlerConfig | HandlerConfig[]
  namespace?: string
  [key: string]: any
}

/** 适配器契约 */
export interface Adapter {
  /** 平台标识，如 QQ */
  id: string
  /** 适配器名称，如 OneBotv11 */
  name: string
  /** 唯一路径（用于去重） */
  path: string
  /** 加载适配器 */
  load: () => any
  [key: string]: any
}

/** 插件类（可被 new 的构造函数） */
export interface PluginClass {
  new (e?: JiuLiEvent): any
  prototype: any
}

/** 已加载插件条目 */
export interface PluginEntry {
  plugin: any
  class: PluginClass
  /** 来源文件 key，如 system/add.js */
  key: string
  name: string
  priority: number
  namespace: string
  /** 事件索引桶 */
  events?: string[]
}

/** 渲染配置 */
export interface RenderOptions {
  /** 返回值类型：default/空 自动发送图片；msgId 返回消息 id；base64 返回 base64 */
  retType?: 'default' | 'msgId' | 'base64' | string
  /** 撤回回复 */
  recallMsg?: boolean
  /** 渲染前改写 data */
  beforeRender?: (data: { data: any }) => any
  [key: string]: any
}

/** 插件性能指标 */
export interface PluginMetric {
  name: string
  key: string
  count: number
  total: number
  max: number
  last: number
  lastAt: number
}
