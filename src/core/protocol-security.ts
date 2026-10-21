const internalFields = [
  'isMaster',
  'isGroup',
  'isPrivate',
  'bot',
  'friend',
  'group',
  'member',
  'reply',
  'recall',
  'getReply',
  'runtime',
  'store',
  'msg',
  'img',
  'at',
  'atBot',
  'reply_id',
  'hasAlias',
  'only_reply_at',
  '__skipDeal',
  '__pluginHint',
]

/** 协议扩展字段仍保留，内核派生的权限、对象和回调必须由本地生成。 */
export function parseProtocolEvent(raw: string | Buffer) {
  const data = JSON.parse(String(raw))
  if (!data || typeof data !== 'object' || Array.isArray(data)) return
  for (const field of internalFields) delete data[field]
  return data
}

/** 禁止覆盖内核属性、stdin 身份或其他仍在线的协议连接。 */
export function canBindAccount(bot: any, adapter: any, id: unknown, ws: any): boolean {
  if (typeof id !== 'string' && typeof id !== 'number') return false
  if (typeof id === 'number' && !Number.isFinite(id)) return false
  if (!String(id) || id === 'stdin') return false
  const current = Object.hasOwn(bot.bots, String(id)) ? bot.bots[String(id)] : undefined
  if (!current) return !(String(id) in bot)
  return (
    bot[String(id)] === current &&
    current.adapter === adapter &&
    (current.ws === ws || current.ws?.readyState === 3)
  )
}

export function isAccountConnection(bot: any, adapter: any, id: unknown, ws: any): boolean {
  if (typeof id !== 'string' && typeof id !== 'number') return false
  const current = Object.hasOwn(bot.bots, String(id)) ? bot.bots[String(id)] : undefined
  return Boolean(current && current.adapter === adapter && current.ws === ws)
}

/** 协议包格式或异步处理失败只影响当前消息，不能升级成进程未捕获异常。 */
export function receiveProtocol(bot: any, adapter: any, raw: any, ...args: any[]) {
  const failed = (error: unknown) => bot.makeLog('error', ['处理协议数据失败', error], adapter.name)
  try {
    return Promise.resolve(adapter.message(raw, ...args)).catch(failed)
  } catch (error) {
    failed(error)
  }
}
