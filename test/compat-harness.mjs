/**
 * 生态兼容层测试公共部分：假 api + 造 JiuLi 事件
 */
import { jiuLiToUniversal, toSegments } from '../lib/compat/bridge.js'

let failed = 0

export function check(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}\n    ${err?.message || err}`)
  }
}

export function failCount() {
  return failed
}

export function summary() {
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
  return failed
}

/** 假 api：收集宿主发出去的消息（与真实 sendTo 一样把通用元素转成 segment） */
export function makeApi(config) {
  const sent = []
  const api = {
    id: config.id || 'compat',
    config,
    log: (level, msg) => {
      if (level === 'error' || level === 'warn') console.log(`    [${level}] ${typeof msg === 'string' ? msg : msg?.[0]}`)
    },
    sendTo: async (target, msg) => {
      sent.push({ target, msg: toSegments(msg) })
      return true
    },
    toSegments,
    elementsToText: (els, o) => (o?.atFormat ? els.map(e => (e.type === 'text' ? e.text : o.atFormat(e.id))).join('') : ''),
    info: () => ({ name: 'JiuLi', version: 'test', uin: ['10000'] }),
  }
  return { api, sent }
}

/** 造一条 JiuLi 事件 */
export function makeEvent(text, extra = {}) {
  const isGroup = extra.group_id !== undefined
  return {
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    sub_type: isGroup ? 'normal' : 'friend',
    self_id: '10000',
    user_id: '20000',
    group_id: isGroup ? String(extra.group_id) : undefined,
    message_id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    message: [{ type: 'text', text }],
    msg: text,
    atBot: extra.atBot,
    hasAlias: extra.hasAlias,
    sender: { user_id: '20000', nickname: '小测', card: '小测', role: extra.role || 'member' },
    isMaster: extra.isMaster,
    ...extra,
  }
}

/** 派发并返回 { handled, sent } */
export function makeDispatcher(host, sent) {
  return async (text, extra = {}) => {
    sent.length = 0
    const handled = await host.dispatch(jiuLiToUniversal(makeEvent(text, extra)))
    return { handled, sent: [...sent] }
  }
}

export function textOf(msg) {
  return (msg || []).filter(i => i.type === 'text').map(i => i.text).join('')
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))
