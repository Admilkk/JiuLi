/**
 * 生态闸门验证：plugins/genshin 加载失败时，框架绝不能主动 import 它的模块
 *
 * 背景（真实事故）：genshin 的 model/gsCfg.js（import `#miao.models`）、
 * model/db/BaseModel.js（顶层 `Data.createDir(...)`，import `#miao`）与 miao 的模块图互相纠缠，
 * 且链上有顶层 await。插件加载失败时这些模块会停在 errored / 半求值状态，
 * 框架若再去 `import` 就会复用坏模块：
 *   - 轻：`Cannot access 'Data' before initialization`（TDZ），正在加载的插件整体失败
 *   - 重：V8 Fatal `Check failed: module->status() == kLinked …`，进程直接死
 * 所以 `Runtime.ecosystem()` 必须先过 `ecosystemReady` 闸门（由 loader 在 genshin 导入成功后标记）。
 *
 * 用法：node test/ecosystem-gate.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

process.env.JIULI_CONFIG_DIR = 'test/.tmp-gate-cfg/'
const PLUGINS_DIR = '.tmp-plugins-gate'
process.env.JIULI_PLUGINS_DIR = PLUGINS_DIR

for (const d of ['test/.tmp-gate-cfg', PLUGINS_DIR, 'test/.tmp-gate-logs'])
  fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync('test/.tmp-gate-cfg', { recursive: true })

/** system（含云崽ck兼容）+ adapter 照常，genshin 用「导入即抛错」的坏插件代替 */
const copyTree = (from, to) => {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') continue
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dest)
    else fs.copyFileSync(src, dest)
  }
}
for (const dir of ['system', 'adapter'])
  if (fs.existsSync(path.join('plugins', dir))) copyTree(path.join('plugins', dir), path.join(PLUGINS_DIR, dir))
fs.mkdirSync(path.join(PLUGINS_DIR, 'genshin'), { recursive: true })
fs.writeFileSync(
  path.join(PLUGINS_DIR, 'genshin', 'index.js'),
  "throw new Error('测试用：genshin 插件导入失败')\n",
)
fs.mkdirSync(path.join(PLUGINS_DIR, 'example'), { recursive: true })
fs.writeFileSync(
  path.join(PLUGINS_DIR, 'example', '探针.js'),
  [
    "import { JiuLiPlugin } from 'jiuli'",
    'globalThis.__gateProbe = 0',
    'export default class Probe extends JiuLiPlugin {',
    "  constructor() { super({ name: '探针', event: 'message', priority: 50, rule: [{ reg: '^#闸门探针$', fnc: 'probe' }] }) }",
    "  async probe() { globalThis.__gateProbe++; return this.reply('探针在') }",
    '}',
    '',
  ].join('\n'),
)
fs.mkdirSync(path.join(PLUGINS_DIR, 'node_modules'), { recursive: true })
try {
  fs.symlinkSync(path.resolve('.'), path.join(PLUGINS_DIR, 'node_modules', 'jiuli'), 'junction')
} catch {}

fs.writeFileSync('test/.tmp-gate-cfg/bot.yaml', 'log_level: info\nplugin_load_timeout: 30\nfile_watch: false\n')
fs.writeFileSync('test/.tmp-gate-cfg/other.yaml', 'master:\n  - "mock:10001"\n')
fs.writeFileSync('test/.tmp-gate-cfg/group.yaml', 'default:\n  groupCD: 0\n  singleCD: 0\n  onlyReplyAt: 0\n')
for (const dir of ['logs', 'data', 'temp']) fs.mkdirSync(dir, { recursive: true })

const { default: JiuLiBot } = await import('../lib/core/bot.js')
const { injectGlobals } = await import('../lib/core/globals.js')
const { ensureDirs } = await import('../lib/core/start.js')
const { redisInit } = await import('../lib/core/redis.js')
const { setLogDir } = await import('../lib/core/log.js')
const { default: Runtime } = await import('../lib/core/runtime.js')
await ensureDirs()

const results = []
const check = (name, ok, extra) => {
  results.push(ok)
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

check('导入前闸门是关闭的', Runtime.ecosystemReady === false)
check(
  '闸门关闭时 ecosystem() 不返回任何模型（框架不会自己去 import）',
  (await Runtime.ecosystem()).NoteUser === undefined,
)

const bot = new JiuLiBot()
await injectGlobals(bot)
await redisInit()
const loader = (await import('../lib/core/loader.js')).default
await loader.load()
const { listenerLoader } = await import('../lib/core/events.js')
await listenerLoader.loadEvent('message.js')
const mock = (bot.adapter || []).find(a => a.name === 'Mock')
await mock.load()
setLogDir('test/.tmp-gate-logs')

const emit = globalThis.__jiuli_mock_emit
const sent = () => (globalThis.__jiuli_mock_sent || []).map(i => (typeof i.msg === 'string' ? i.msg : ''))
const sleep = ms => new Promise(r => setTimeout(r, ms))

check('genshin 导入失败后闸门仍然关闭', Runtime.ecosystemReady === false)
check(
  '闸门关闭时 ecosystem() 依旧不给模型（坏模块图一次都没被碰过）',
  (await Runtime.ecosystem()).NoteUser === undefined,
)

emit({ type: 'message', group_id: 'mock:88001', user_id: '10001', msg: '#闸门探针' })
await sleep(1500)
check('消息分发照常工作（进程活着）', globalThis.__gateProbe === 1 && sent().some(m => m.includes('探针在')))

;(globalThis.__jiuli_mock_sent || []).length = 0
emit({ type: 'message', group_id: 'mock:88001', user_id: '10001', msg: '#同步ck' })
await sleep(2000)
check(
  '云崽ck兼容层不依赖生态模块（照常应答，不报错）',
  sent().some(m => m.includes('已同步')),
  sent().join(' | ') || '（无回复）',
)

const pass = results.filter(Boolean).length
console.log(`\n=== 生态闸门验证：${pass}/${results.length} 通过 ===`)
for (const dir of ['test/.tmp-gate-cfg', PLUGINS_DIR, 'test/.tmp-gate-logs'])
  fs.rmSync(dir, { recursive: true, force: true })
process.exit(pass === results.length ? 0 : 1)
