/**
 * 生态兼容层：通用事件 / 消息模型
 *
 * 设计要点：
 * - JiuLi 的事件对象 `e` 与 segment 数组（OneBot11 风格）是**内部通用货币**。
 * - 各生态（Koishi / GsCore / AstrBot）各自有一份适配器，只负责两张映射表：
 *   入站 `e → 通用事件`，出站 `通用消息 → segment[]`。
 * - 这里不引入任何第三方依赖，Node 与 Python 两侧都能照着实现。
 *
 * 之所以不直接让各生态读写 `e`：三家的消息模型差别很大
 * （Koishi 的 h()/Elements、AstrBot 的 MessageChain/组件、GsCore 的 Message/MessageSegment），
 * 统一收口到一层以后，新增生态只需要写映射，不用碰分发逻辑。
 */

export const COMPAT_API_VERSION = 1

/* 元素映射 */

/** 入站图片地址：各适配器字段不统一（url / file / data.url） */
export function pickUrl(seg) {
  if (!seg || typeof seg !== 'object') return ''
  return seg.url || seg.file || seg.data?.url || seg.data?.file || seg.src || ''
}

/** JiuLi segment → 通用元素 */
export function elementFromSegment(seg) {
  if (seg == null) return null
  if (typeof seg === 'string') return { type: 'text', text: seg }
  if (typeof seg !== 'object') return { type: 'text', text: String(seg) }

  switch (seg.type) {
    case 'text':
      return { type: 'text', text: String(seg.text ?? seg.data?.text ?? '') }
    case 'image':
      return { type: 'image', url: pickUrl(seg), name: seg.name, raw: seg }
    case 'at':
      return { type: 'at', id: String(seg.qq ?? seg.user_id ?? ''), name: seg.name, raw: seg }
    case 'reply':
      return { type: 'reply', id: String(seg.id ?? ''), raw: seg }
    case 'face':
      return { type: 'face', id: String(seg.id ?? ''), raw: seg }
    case 'record':
      return { type: 'record', url: pickUrl(seg), raw: seg }
    case 'video':
      return { type: 'video', url: pickUrl(seg), raw: seg }
    case 'file':
      return { type: 'file', url: pickUrl(seg), name: seg.name, raw: seg }
    case 'json':
    case 'xml':
    case 'markdown':
    case 'button':
      return { type: seg.type, data: seg.data ?? seg, raw: seg }
    default:
      return { type: seg.type || 'unknown', data: seg.data, raw: seg }
  }
}

/** 通用元素 → JiuLi segment（出站统一走这里，adapter 拿到的一定是云崽认识的形状） */
export function segmentFromElement(el) {
  if (el == null) return null
  if (typeof el === 'string') return { type: 'text', text: el }
  if (typeof el !== 'object') return { type: 'text', text: String(el) }

  switch (el.type) {
    case 'text':
      return { type: 'text', text: String(el.text ?? '') }
    case 'image':
      return { type: 'image', file: el.url || el.file || el.data || '', name: el.name }
    case 'at':
      return { type: 'at', qq: String(el.id ?? el.qq ?? ''), name: el.name }
    case 'reply':
      return { type: 'reply', id: String(el.id ?? '') }
    case 'face':
      return { type: 'face', id: String(el.id ?? '') }
    case 'record':
    case 'video':
    case 'file':
      return { type: el.type, file: el.url || el.file || '', name: el.name }
    case 'json':
      return { type: 'json', data: el.data }
    case 'xml':
      return { type: 'xml', data: el.data }
    case 'markdown':
      return { type: 'markdown', data: el.data }
    case 'button':
      return { type: 'button', data: el.data }
    default:
      /** 未知类型：能拿到 raw 就原样透传，适配器自己决定怎么发 */
      return el.raw && el.raw.type ? { ...el.raw } : { type: 'text', text: String(el.text ?? '') }
  }
}

/**
 * 把「字符串 / 单个元素 / 元素数组 / 混合数组（元素 + 原生 segment）」统一成 segment 数组。
 * 出站消息一律经过它，避免各生态各自拼接字符串。
 */
export function toSegments(input) {
  if (input == null) return []
  const list = Array.isArray(input) ? input : [input]
  const out = []
  for (const item of list) {
    if (item == null) continue
    /** 原生 segment 与通用元素都带 type，用 raw 标记区分，其余按通用元素处理 */
    const seg = segmentFromElement(item)
    if (seg) out.push(seg)
  }
  /** 相邻 text 合并，减少 segment 数量（部分协议端对段数有限制） */
  const merged = []
  for (const seg of out) {
    const last = merged[merged.length - 1]
    if (seg.type === 'text' && last?.type === 'text') last.text += seg.text
    else merged.push(seg)
  }
  return merged
}

/** 元素数组 → 纯文本（至少保留 @ 信息，否则指令匹配会丢上下文） */
export function elementsToText(elements, opts = {}) {
  const { atFormat = (id) => `<at:${id}>` } = opts
  let text = ''
  for (const el of elements || []) {
    if (!el) continue
    if (el.type === 'text') text += el.text
    else if (el.type === 'at' && el.id) text += atFormat(el.id)
    else if (el.type === 'face') text += `<face:${el.id}>`
    else if (el.type === 'image') text += '[图片]'
  }
  return text
}

/* 事件映射 */

/** JiuLi 事件 → 通用事件 */
export function jiuLiToUniversal(e) {
  const isGroup = e?.message_type === 'group' || e?.notice_type === 'group' || (e?.group_id !== undefined && e?.group_id !== null && e?.group_id !== '')

  const elements = []
  if (Array.isArray(e?.message)) {
    for (const seg of e.message) {
      const el = elementFromSegment(seg)
      if (el) elements.push(el)
    }
  } else if (e?.raw_message || e?.msg) {
    elements.push({ type: 'text', text: String(e.raw_message ?? e.msg ?? '') })
  }

  const selfId = e?.self_id != null ? String(e.self_id) : ''
  const userId = e?.user_id != null ? String(e.user_id) : ''

  return {
    /** 通用事件 id */
    id: e?.message_id != null ? `jiuli-${e.message_id}` : `jiuli-${Date.now()}`,
    platform: e?.adapter_name || e?.adapter_id || 'jiuli',
    /** 原始 post_type：message / notice / request */
    postType: e?.post_type || 'message',
    selfId,
    userId,
    groupId: isGroup ? String(e?.group_id ?? '') : '',
    /** 会话 id：群聊取群号，私聊取用户号 */
    channelId: isGroup ? String(e?.group_id ?? '') : userId,
    messageId: e?.message_id != null ? String(e.message_id) : undefined,
    isGroup,
    isDirect: !isGroup,
    isMaster: !!e?.isMaster,
    sender: {
      id: userId,
      name: e?.sender?.card || e?.sender?.nickname || e?.member?.card || userId,
      nick: e?.sender?.nickname || userId,
      card: e?.sender?.card,
      role: e?.sender?.role || (e?.member?.is_owner ? 'owner' : e?.member?.is_admin ? 'admin' : 'member'),
    },
    elements,
    /** 文本化结果：默认沿用内核已经处理好的 e.msg（已做别名剥离、/→# 等） */
    text: e?.msg ?? elementsToText(elements),
    rawText: elementsToText(elements),
    time: e?.time ? Number(e.time) * 1000 : Date.now(),
    /** 平台原始事件：桥接层回写/回执时用得上，不代表可以序列化 */
    raw: e,
  }
}

/* 发送 */

/**
 * 构造一个「发到当前会话」的发送函数。
 * 所有生态的出站都走它，从而自动获得：at/引用拼装、撤回、日志归属、失败捕获。
 * @returns {(msg:any, opts?:{reply?:boolean,at?:string|boolean|number,recall?:number}) => Promise<any>}
 */
export function makeSender(e) {
  return async (msg, opts = {}) => {
    if (!e?.reply) return false
    const data = {}
    if (opts.recall) data.recallMsg = opts.recall
    if (opts.at) data.at = opts.at
    const segments = toSegments(msg)
    if (!segments.length) return false
    return e.reply(segments, opts.reply ?? false, data)
  }
}
