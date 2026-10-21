import { isIP } from 'node:net'

const hidden = '[REDACTED]'

export function isLoopbackAddress(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const family = isIP(value)
  if (family === 4) return value.startsWith('127.')
  if (family !== 6) return false
  const address = new URL(`http://[${value}]/`).hostname.slice(1, -1)
  return address === '::1' || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(address)
}

function isSecret(key: string, auth: Record<string, unknown>) {
  return (
    /authorization|cookie|password|passwd|secret|token|api[_-]?key|^x-jiuli-control$/i.test(key) ||
    Object.keys(auth).some(name => name.toLowerCase() === key.toLowerCase())
  )
}

/** 只用于日志，不修改实际请求中的 URL 或凭据。 */
export function redactUrl(value: unknown, auth: Record<string, unknown> = {}): string {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value, 'http://localhost')
    if (url.username) url.username = hidden
    if (url.password) url.password = hidden
    for (const key of url.searchParams.keys())
      if (isSecret(key, auth || {})) url.searchParams.set(key, hidden)
    return /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? url.toString() : `${url.pathname}${url.search}`
  } catch {
    return '[invalid URL]'
  }
}

/** 日志保留结构，隐藏凭据；不遍历整个大包或修改调用方的对象。 */
export function redactLog(value: unknown, auth: Record<string, unknown> = {}): any {
  auth ||= {}
  const secrets = Object.values(auth).filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  )
  const seen = new WeakSet<object>()
  const walk = (item: any, depth: number): any => {
    if (Buffer.isBuffer(item)) {
      if (item.length > 16384) return `[Buffer ${item.length} bytes]`
      try {
        return walk(JSON.parse(item.toString()), depth)
      } catch {
        return `[Buffer ${item.length} bytes]`
      }
    }
    if (typeof item === 'string') {
      if (item.length > 16384 && /^\s*[\[{]/.test(item)) return `[JSON ${item.length} characters]`
      if (item.length <= 16384 && /^\s*[\[{]/.test(item)) {
        try {
          return walk(JSON.parse(item), depth)
        } catch {}
      }
      const text = /^(?:https?|wss?):\/\//i.test(item) ? redactUrl(item, auth) : item
      return secrets.reduce((text, secret) => text.split(secret).join(hidden), text)
    }
    if (!item || typeof item !== 'object') return item
    if (depth >= 8) return '[Object]'
    if (seen.has(item)) return '[Circular]'
    seen.add(item)
    if (Array.isArray(item)) return item.slice(0, 100).map(entry => walk(entry, depth + 1))
    return Object.fromEntries(
      Object.entries(item)
        .slice(0, 100)
        .map(([key, entry]) => [key, isSecret(key, auth) ? hidden : walk(entry, depth + 1)]),
    )
  }
  return walk(value, 0)
}
