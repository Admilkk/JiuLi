/**
 * 插件重复实例化验证
 *
 * 一个类既作 default 又作具名导出是云崽插件的常见写法（如 system/restart.js），
 * 这只能实例化一次：否则它的 init() 会跑多遍，重复注册事件监听与定时任务
 * （典型表现：#重启 后「重启成功，用时 x」发两遍）。
 *
 * 用法：node test/plugin-dedup.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

process.env.JIULI_CONFIG_DIR = 'test/.tmp-dedup-cfg/'
const PLUGINS_DIR = '.tmp-plugins-dedup'
process.env.JIULI_PLUGINS_DIR = PLUGINS_DIR

for (const d of ['test/.tmp-dedup-cfg', PLUGINS_DIR]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync('test/.tmp-dedup-cfg', { recursive: true })
fs.mkdirSync(path.join(PLUGINS_DIR, 'example'), { recursive: true })

/** 只放内置插件 + 适配器，够走完加载 */
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

fs.writeFileSync(
  'test/.tmp-dedup-cfg/bot.yaml',
  'log_level: info\nplugin_load_timeout: 30\nfile_watch: false\n',
)
fs.writeFileSync('test/.tmp-dedup-cfg/other.yaml', 'master:\n  - "mock:10001"\n')

/** 夹具：Dup 同时作 default 与具名导出；Other 是另一个类，用来确认去重不是「整个文件只留一个类」 */
fs.writeFileSync(
  path.join(PLUGINS_DIR, 'example', '重复导出.js'),
  [
    "import { JiuLiPlugin } from 'jiuli'",
    'globalThis.__dedup ??= { init: 0 }',
    'class Dup extends JiuLiPlugin {',
    '  constructor() {',
    "    super({ name: '重复导出', dsc: '#重复导出', event: 'message', rule: [{ reg: '^#重复导出$', fnc: 'run' }] })",
    '  }',
    '  init() {',
    '    globalThis.__dedup.init++',
    "    this.task = [{ name: '重复任务', cron: '0 0 1 1 *', fnc: () => {} }]",
    "    Bot.once('online', function dedupOnline() {})",
    '  }',
    "  async run() { return this.reply('ok') }",
    '}',
    'class Other extends JiuLiPlugin {',
    '  constructor() {',
    "    super({ name: '另一个类', dsc: '#另一个', event: 'message', rule: [{ reg: '^#另一个$', fnc: 'run' }] })",
    '  }',
    "  async run() { return this.reply('ok') }",
    '}',
    'export default Dup',
    'export { Dup, Other }',
    '',
  ].join(String.fromCharCode(10)),
)

for (const dir of ['logs', 'data', 'temp']) fs.mkdirSync(dir, { recursive: true })
const { default: JiuLiBot } = await import('../lib/core/bot.js')
const { injectGlobals } = await import('../lib/core/globals.js')
const { ensureDirs } = await import('../lib/core/start.js')
const { redisInit } = await import('../lib/core/redis.js')
await ensureDirs()

const bot = new JiuLiBot()
await injectGlobals(bot)
await redisInit()

const loader = (await import('../lib/core/loader.js')).default
await loader.load()

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

const file = 'example/重复导出.js'
check('去重后只实例化两个类（Dup + Other）', loader.pluginCountMap.get(file) === 2, `实际 ${loader.pluginCountMap.get(file)}`)
check('重复导出的类 init() 只执行一次', globalThis.__dedup.init === 1, `实际 ${globalThis.__dedup.init} 次`)
check(
  '分发列表里只有一个「重复导出」',
  loader.priority.filter(i => i.name === '重复导出').length === 1,
  `实际 ${loader.priority.filter(i => i.name === '重复导出').length} 个`,
)
check('定时任务只注册一次', loader.taskMap.get(file)?.size === 1, `实际 ${loader.taskMap.get(file)?.size} 个`)
check(
  '重启插件只有一个实例',
  loader.priority.filter(i => i.name === '进程管理').length === 1,
  `实际 ${loader.priority.filter(i => i.name === '进程管理').length} 个`,
)

/** 端到端：上线通知只发一条（重复实例化的直接后果就是「重启成功，用时 x」发两遍） */
const mock = (bot.adapter || []).find(a => a.name === 'Mock')
if (!mock) {
  check('重启成功通知只发一次', false, '未找到 Mock 适配器')
} else {
  await mock.load()
  const sent = globalThis.__jiuli_mock_sent
  const redis = globalThis.redis
  const group = 'mock:20001'
  await redis.set('Yz:restart', JSON.stringify({ isExit: false, group_id: group, bot_id: 'mock', time: Date.now() }))

  sent.length = 0
  bot.emit('online', bot)
  await new Promise(r => setTimeout(r, 1000))
  const texts = JSON.stringify(sent)
  check('重启成功通知只发一次', sent.length === 1 && /重启成功/.test(texts), `实际 ${sent.length} 条 ${texts.slice(0, 60)}`)
}

const pass = results.filter(r => r.ok).length
console.log(`\n=== 插件去重验证：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
