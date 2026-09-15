/**
 * 插件加载检查（不启动适配器 / HTTP 服务，也不会连接协议端）
 *
 * 用途：批量验证 plugins/ 下插件能否正常加载，收集报错与规则数
 * 用法：node test/load-check.mjs [--full]
 *   --full 使用真实 config/config/（默认用隔离目录，避免影响正在运行的实例）
 */
import fs from 'node:fs'

const full = process.argv.includes('--full')
if (!full) {
  const dir = 'test/.tmp-loadcheck/'
  process.env.JIULI_CONFIG_DIR = dir
  fs.mkdirSync(dir, { recursive: true })
  // 隔离目录只需要默认值，交给框架初始化
}

const { default: JiuLiBot } = await import('../lib/core/bot.js')
const { injectGlobals } = await import('../lib/core/globals.js')
const { ensureDirs } = await import('../lib/core/start.js')
const { redisInit } = await import('../lib/core/redis.js')

for (const dir of ['logs', 'data', 'temp']) fs.mkdirSync(dir, { recursive: true })
await ensureDirs()

const bot = new JiuLiBot()
await injectGlobals(bot)
await redisInit()

const loader = (await import('../lib/core/loader.js')).default

/** 插件加载错误走 console.error，这里截获用于统计（语法错误、缺依赖等） */
const errors = []
const origError = console.error
console.error = (...args) => {
  const line = args.map(String).join(' ')
  if (line.includes('插件加载错误')) errors.push(line.replace(/\u001b\[[0-9;]*m/g, ''))
  origError(...args)
}

const startAt = Date.now()
await loader.load()
console.error = origError

const rules = loader.priority.reduce((n, i) => n + (i.plugin.rule?.length || 0), 0)
const names = loader.priority.map(i => i.name || i.key)
console.log('\n=== 加载检查结果 ===')
console.log(`插件 ${loader.pluginCount} 个 · 规则 ${rules} 条 · 定时任务 ${loader.task.length} 个 · 用时 ${Date.now() - startAt}ms`)
console.log(`已加载：${names.slice(0, 40).join(' · ')}${names.length > 40 ? ` …（共 ${names.length}）` : ''}`)
const slow = Object.entries(loader.load_time)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([k, v]) => `${k} ${v}ms`)
console.log(`最慢：${slow.join(' · ')}`)
if (errors.length) {
  console.log(`\n❌ 加载失败的插件 ${errors.length} 个：`)
  for (const i of errors) console.log(`  ${i.slice(0, 160)}`)
}
if (!full) fs.rmSync('test/.tmp-loadcheck', { recursive: true, force: true })
process.exit(errors.length ? 1 : 0)
