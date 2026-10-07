/**
 * 群级等待上下文收尾要按对象身份清理
 *
 * 回归的是 TRSS 的 fix(plugin)「清理已完成的群级等待上下文」：
 * resolveContext() 原先只 finish 用户级 key，而 awaitContext(true) 存在群级 key 上，
 * 于是群级等待被解析后仍然留在 stateArr 里，继续拦截该群后续消息直到超时。
 *
 * 属于回归用例，随 pnpm test:all 一起跑；也可单独执行：node test/context-group.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

process.env.JIULI_CONFIG_DIR = 'test/.tmp-cg-cfg/'
const PLUGINS_DIR = '.tmp-plugins-context-group'
process.env.JIULI_PLUGINS_DIR = PLUGINS_DIR

for (const d of ['test/.tmp-cg-cfg', PLUGINS_DIR]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync('test/.tmp-cg-cfg', { recursive: true })

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

fs.writeFileSync('test/.tmp-cg-cfg/bot.yaml', 'log_level: info\nplugin_load_timeout: 30\nfile_watch: false\n')
fs.writeFileSync('test/.tmp-cg-cfg/other.yaml', 'master:\n  - "mock:10001"\n')

/** 群级等待：发起后由同群任意人回复来解析 */
const DIR = path.join(PLUGINS_DIR, 'ctx-wait')
fs.mkdirSync(DIR, { recursive: true })
fs.writeFileSync(
  path.join(DIR, 'index.js'),
  `import { JiuLiPlugin } from 'jiuli'
export default class CtxWait extends JiuLiPlugin {
  constructor() {
    super({
      name: '群级等待',
      dsc: 'ctx',
      event: 'message',
      priority: 1,
      rule: [
        { reg: '^#开始等待$', fnc: 'start' },
        { reg: '^#开始等待个人$', fnc: 'startUser' },
      ],
    })
  }
  async start() {
    await this.reply('等待中')
    const next = await this.awaitContext(true)
    if (next === false) return
    return this.reply('群级等待已结束')
  }
  async startUser() {
    await this.reply('个人等待中')
    const next = await this.awaitContext()
    if (next === false) return
    return this.reply('个人等待已结束')
  }
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
const { stateArr } = await import('../lib/core/plugin.js')
await ensureDirs()
const bot = new JiuLiBot()
await injectGlobals(bot)

const loader = (await import('../lib/core/loader.js')).default
await loader.load()

const mock = (bot.adapter || []).find(a => a.name === 'Mock')
const { listenerLoader } = await import('../lib/core/events.js')
for (const f of ['message.js', 'notice.js', 'request.js']) await listenerLoader.loadEvent(f)
await mock.load()
const emit = globalThis.__jiuli_mock_emit
const sent = globalThis.__jiuli_mock_sent
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ---------- 群级等待 ---------- */
sent.length = 0
emit({ type: 'message', group_id: '999000301', user_id: '10001', msg: '#开始等待' })
await sleep(500)
check('群级等待已建立', JSON.stringify(sent).includes('等待中'), JSON.stringify(sent).slice(0, 80))

sent.length = 0
emit({ type: 'message', group_id: '999000301', user_id: '10002', msg: '随便一句话' })
await sleep(500)
check('群级等待被解析', JSON.stringify(sent).includes('群级等待已结束'), JSON.stringify(sent).slice(0, 80))

const leftover = Object.entries(stateArr).filter(([k, v]) => k === '群级等待.mock.999000301' && Object.keys(v).length)
check('解析后 stateArr 不留残项', leftover.length === 0, leftover.map(([k]) => k).join(' · ') || '（已清空）')

sent.length = 0
/**
 * 用一条没有插件会应答的消息当探针：群级上下文若没被清理，
 * 它会把这条消息当成等待结果并回复「群级等待已结束」。
 */
emit({ type: 'message', group_id: '999000301', user_id: '10003', msg: '这是一条没人应答的探针消息' })
await sleep(600)
check(
  '该群上下文不再拦截其他消息',
  !JSON.stringify(sent).includes('群级等待已结束'),
  JSON.stringify(sent) || '（没有被上下文接手）',
)

/* ---------- 个人等待不受影响 ---------- */
sent.length = 0
emit({ type: 'message', message_type: 'private', user_id: '10004', msg: '#开始等待个人' })
await sleep(500)
sent.length = 0
emit({ type: 'message', message_type: 'private', user_id: '10004', msg: '内容' })
await sleep(500)
check('用户级等待照常解析并清理', JSON.stringify(sent).includes('个人等待已结束'), JSON.stringify(sent).slice(0, 80))
const leftoverUser = Object.entries(stateArr).filter(([k, v]) => k === '群级等待.mock.10004' && Object.keys(v).length)
check('用户级等待也不留残项', leftoverUser.length === 0, leftoverUser.map(([k]) => k).join(' · ') || '（已清空）')

const pass = results.filter(r => r.ok).length
console.log(`\n=== 群级等待上下文测试：${pass}/${results.length} 通过 ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)
process.exit(pass === results.length ? 0 : 1)
