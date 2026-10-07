/**
 * 内置帮助不抢用户的 #帮助
 *
 * 回归的是 Gitee #IKJVCC：`plugins/system/help.js` 用 `priority: -Infinity` 占住 `#帮助`，
 * 用户插件无论 priority 调多小都抢不过（不存在比 -Infinity 更小的值）。
 * 现在内置帮助是普通优先级（4000，刻意避开默认值 5000），用户插件能接管；框架说明改走 `#玖璃帮助`。
 *
 * 属于回归用例，随 pnpm test:all 一起跑；也可单独执行：node test/help-priority.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

process.env.JIULI_CONFIG_DIR = 'test/.tmp-hp-cfg/'
const PLUGINS_DIR = '.tmp-plugins-help-priority'
process.env.JIULI_PLUGINS_DIR = PLUGINS_DIR

for (const d of ['test/.tmp-hp-cfg', PLUGINS_DIR]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync('test/.tmp-hp-cfg', { recursive: true })

const copyTree = (from, to) => {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.isSymbolicLink()) continue
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dest)
    else fs.copyFileSync(src, dest)
  }
}
for (const dir of ['system', 'other', 'adapter'])
  if (fs.existsSync(path.join('plugins', dir))) copyTree(path.join('plugins', dir), path.join(PLUGINS_DIR, dir))
fs.mkdirSync(path.join(PLUGINS_DIR, 'node_modules'), { recursive: true })
try {
  fs.symlinkSync(path.resolve('.'), path.join(PLUGINS_DIR, 'node_modules', 'jiuli'), 'junction')
} catch {}

fs.writeFileSync('test/.tmp-hp-cfg/bot.yaml', 'log_level: info\nplugin_load_timeout: 30\nfile_watch: false\n')
fs.writeFileSync('test/.tmp-hp-cfg/other.yaml', 'master:\n  - "mock:10001"\n')

/** 用户的菜单插件：priority 1，抢常见的 #帮助 */
const USER_DIR = path.join(PLUGINS_DIR, 'user-menu')
fs.mkdirSync(USER_DIR, { recursive: true })
fs.writeFileSync(
  path.join(USER_DIR, 'index.js'),
  `import { JiuLiPlugin } from 'jiuli'
export default class UserMenu extends JiuLiPlugin {
  constructor() {
    super({ name: '用户菜单', dsc: 'menu', event: 'message', priority: 1, rule: [{ reg: '^#帮助$', fnc: 'menu' }] })
  }
  async menu() { return this.reply('用户自己的菜单') }
}
`,
)

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

const loader = (await import('../lib/core/loader.js')).default
await loader.load()
check(
  '用户插件与内置帮助都已加载',
  loader.priority.some(i => i.key === 'user-menu') && loader.priority.some(i => i.key === 'system/help.js'),
  loader.priority.map(i => i.key).join(' · '),
)
const mock = (bot.adapter || []).find(a => a.name === 'Mock')
const { listenerLoader } = await import('../lib/core/events.js')
for (const f of ['message.js', 'notice.js', 'request.js']) await listenerLoader.loadEvent(f)
await mock.load()
const emit = globalThis.__jiuli_mock_emit
const sent = globalThis.__jiuli_mock_sent
const sleep = ms => new Promise(r => setTimeout(r, ms))

sent.length = 0
emit({ type: 'message', group_id: '999000201', user_id: '10001', msg: '#帮助' })
await sleep(600)
check('用户插件接管 #帮助（内置帮助不再截胡）', JSON.stringify(sent).includes('用户自己的菜单'), JSON.stringify(sent).slice(0, 90))

sent.length = 0
try {
  emit({ type: 'message', group_id: '999000202', user_id: '10001', msg: '#玖璃帮助' })
} catch (err) {
  console.log('emit 抛错：', err)
}
await sleep(600)
check('框架内置说明仍可通过 #玖璃帮助 取到', JSON.stringify(sent).includes('JiuLi 指令说明'), JSON.stringify(sent).slice(0, 90))

const pass = results.filter(r => r.ok).length
console.log(`\n=== 内置帮助优先级测试：${pass}/${results.length} 通过 ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)
process.exit(pass === results.length ? 0 : 1)
