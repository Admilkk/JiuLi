/** 复现 hl-icqq-web 加载报错，拿完整调用栈 */
import express from 'express'
globalThis.logger = (await import('../lib/core/log.js')).logger
globalThis.plugin = (await import('../lib/core/plugin.js')).default
globalThis.segment = (await import('../lib/core/segment.js')).default
const app = Object.assign(express(), { skip_auth: [], quiet: [] })
globalThis.Bot = new Proxy(
  { express: app, adapter: [], uin: [], bots: {}, wsf: {}, stat: { start_time: Date.now() / 1000 }, server: {} },
  { get: (t, p) => (p in t ? t[p] : () => ({})) },
)
globalThis.cfg = (await import('../lib/core/config/index.js')).default
globalThis.redis = { get: async () => null, set: async () => 'OK', keys: async () => [] }
try {
  await import('../plugins/hl-icqq-web/index.js')
  console.log('✅ 加载成功')
} catch (err) {
  console.log('❌ 加载失败：', err.message)
  console.log(err.stack.split('\n').filter(l => !l.includes('node_modules/.pnpm')).slice(0, 8).join('\n'))
}
process.exit(0)
