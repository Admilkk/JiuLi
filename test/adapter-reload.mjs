/**
 * 适配器补载幂等
 *
 * 适配器由适配器插件在模块顶层 push 到 Bot.adapter。若那个文件因别的插件超时被牵连，
 * 补拉只会 import 它、不会跑 adapter.load()；loadEvents() 又只在启动时调一次。
 * 现在 ListenerLoader.loadAdapters() 可重复调用，且已加载过的不再 load()。
 *
 * 属于回归用例，随 pnpm test:all 一起跑；也可单独执行：node test/adapter-reload.mjs
 */
import fs from 'node:fs'

process.env.JIULI_CONFIG_DIR = 'test/.tmp-ar-cfg/'
const PLUGINS_DIR = '.tmp-plugins-adapter-reload'
process.env.JIULI_PLUGINS_DIR = PLUGINS_DIR

for (const d of ['test/.tmp-ar-cfg', PLUGINS_DIR]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync('test/.tmp-ar-cfg', { recursive: true })
fs.mkdirSync(PLUGINS_DIR, { recursive: true })

fs.writeFileSync('test/.tmp-ar-cfg/bot.yaml', 'log_level: info\nplugin_load_timeout: 30\nfile_watch: false\n')

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

const { default: JiuLiBot } = await import('../lib/core/bot.js')
const { injectGlobals } = await import('../lib/core/globals.js')
const { ensureDirs } = await import('../lib/core/start.js')
await ensureDirs()
const bot = new JiuLiBot()
await injectGlobals(bot)

const { listenerLoader } = await import('../lib/core/events.js')

let loads = 0
const late = {
  id: 'Late',
  name: '补拉适配器',
  path: 'LateProbe',
  load() {
    loads++
    return Promise.resolve()
  },
}

/* 模拟「补拉回来的适配器插件在模块顶层 push」 */
bot.adapter.push(late)
await listenerLoader.loadAdapters()
check('补拉后能加载新出现的适配器', loads === 1, `load 次数=${loads}`)

await listenerLoader.loadAdapters()
check('重复调用不会重复 load（幂等）', loads === 1, `load 次数=${loads}`)

/* 完整 load() 也不该把已加载的再跑一遍 */
await listenerLoader.load()
check('load() 之后仍不重复', loads === 1, `load 次数=${loads}`)

/* load 抛错的适配器也不该被反复重试 */
let bad = 0
const broken = {
  id: 'Bad',
  name: '坏适配器',
  path: 'BadProbe',
  load() {
    bad++
    return Promise.reject(new Error('测试用的加载失败'))
  },
}
bot.adapter.push(broken)
await listenerLoader.loadAdapters()
await listenerLoader.loadAdapters()
check('load 失败的适配器不会反复重试', bad === 1, `load 次数=${bad}`)

const pass = results.filter(r => r.ok).length
console.log(`\n=== 适配器补载测试：${pass}/${results.length} 通过 ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)
process.exit(pass === results.length ? 0 : 1)
