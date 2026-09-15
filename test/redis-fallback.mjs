/**
 * Redis 不可用时的行为验证
 *
 * 线上遇到过两类问题：
 *   1) 本机没装 redis-server 时，日志却打出「已连接」（其实是内存降级），误导排查
 *   2) 运行中 Redis 挂掉 → 客户端反复重连并刷屏（插件自建连接更会疯狂 console.error）
 *
 * 这里用一个不存在的命令名（防止真的拉起 redis）指向一个没人监听的端口，验证：
 *   - 启动阶段：连不上 → 明确告知装法 → 按 redis_fallback 降级到内存实现
 *   - 不会谎报「已连接」
 *   - 降级后内存实现可正常读写
 *
 * 用法：node test/redis-fallback.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

process.env.JIULI_NO_AUTO_INSTALL = '1' // 测试环境不自动安装
const DIR = 'test/.tmp-redis/'
process.env.JIULI_CONFIG_DIR = DIR
fs.rmSync(DIR, { recursive: true, force: true })
fs.mkdirSync(DIR, { recursive: true })
fs.writeFileSync(path.join(DIR, 'bot.yaml'), 'log_level: info\n')
fs.writeFileSync(path.join(DIR, 'jiuli.yaml'), 'redis_fallback: true\n')
fs.writeFileSync(
  path.join(DIR, 'redis.yaml'),
  // 指向没人监听的端口，且给一个不存在的启动命令，避免测试机自己拉起 redis
  ['path: definitely-not-a-redis-binary', 'host: 127.0.0.1', 'port: 6399', 'db: 0', ''].join('\n'),
)
for (const d of ['logs', 'data', 'temp']) fs.mkdirSync(d, { recursive: true })

const lines = []
const origLog = console.log
const origError = console.error
const push = (args, orig) => {
  lines.push(args.map(String).join(' ').replace(/\u001b\[[0-9;]*m/g, ''))
  orig(...args)
}
console.log = (...a) => push(a, origLog)
console.error = (...a) => push(a, origError)

const { default: JiuLiBot } = await import('../lib/core/bot.js')
const { injectGlobals } = await import('../lib/core/globals.js')
const { ensureDirs } = await import('../lib/core/start.js')
const { redisInit } = await import('../lib/core/redis.js')
await ensureDirs()
const bot = new JiuLiBot()
await injectGlobals(bot)

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

const redis = await redisInit()
const logs = lines.join('\n')

check('连不上时不谎报「已连接」', !logs.includes('已连接'), lines.find(l => l.includes('Redis'))?.slice(0, 70) || '')
check(
  '明确告知装法或改用内存实现',
  logs.includes('apt install redis-server') && logs.includes('redis_fallback'),
  lines.find(l => l.includes('apt install'))?.trim().slice(0, 80) || '（无提示）',
)
check(
  '按 redis_fallback 降级到内存实现',
  logs.includes('使用内存降级实现'),
  lines.find(l => l.includes('降级'))?.trim().slice(0, 60) || '（未降级）',
)
check('降级后读写正常', (await redis.set('jiuli:test', 'ok')) === 'OK' && (await redis.get('jiuli:test')) === 'ok')

fs.rmSync(DIR, { recursive: true, force: true })
console.log = origLog
console.error = origError
const pass = results.filter(r => r.ok).length
console.log(`\n=== Redis 降级测试：${pass}/${results.length} 通过 ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)
process.exit(pass === results.length ? 0 : 1)
