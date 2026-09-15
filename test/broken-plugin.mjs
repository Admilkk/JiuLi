/**
 * 坏插件 / 插件报错的处理验证
 *
 * 覆盖两类：
 *   A. 加载期：语法错误、import 不存在的本地文件、缺依赖包
 *      → 不能阻塞启动；报错要能看懂（哪个文件、什么原因、怎么修）；不刷屏 Node 堆栈
 *   B. 运行期：插件方法里抛异常
 *      → 只报一行原因 + 插件内出错位置；本次指令中断但不影响其他插件
 *
 * 另外验证：修好之后的 #重载 能重新加载（失败过的插件不会被当成"空文件"跳过）。
 * 用隔离插件目录 + Mock 适配器，不碰真实 plugins/，也不会连协议端。
 *
 * 用法：node test/broken-plugin.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

process.env.JIULI_CONFIG_DIR = 'test/.tmp-broken-cfg/'
const PLUGINS_DIR = '.tmp-plugins-broken'
process.env.JIULI_PLUGINS_DIR = PLUGINS_DIR

for (const d of ['test/.tmp-broken-cfg', PLUGINS_DIR]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync('test/.tmp-broken-cfg', { recursive: true })
fs.mkdirSync(path.join(PLUGINS_DIR, 'example'), { recursive: true })

/** 只放内置 + 适配器，够走完加载与一次分发 */
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
for (const dir of ['system', 'adapter'])
  if (fs.existsSync(path.join('plugins', dir))) copyTree(path.join('plugins', dir), path.join(PLUGINS_DIR, dir))
fs.mkdirSync(path.join(PLUGINS_DIR, 'node_modules'), { recursive: true })
try {
  fs.symlinkSync(path.resolve('.'), path.join(PLUGINS_DIR, 'node_modules', 'jiuli'), 'junction')
} catch {}

fs.writeFileSync(
  'test/.tmp-broken-cfg/bot.yaml',
  'log_level: info\nplugin_load_timeout: 8\nfile_watch: false\nlog_msg: true\n',
)
fs.writeFileSync('test/.tmp-broken-cfg/other.yaml', 'master:\n  - "mock:10001"\n')

/* ---------- 夹具插件 ---------- */
const BAD_SYNTAX = path.join(PLUGINS_DIR, 'example', '坏语法.js')
const BAD_IMPORT = path.join(PLUGINS_DIR, 'example', '坏引用.js')
const BAD_PKG = path.join(PLUGINS_DIR, 'example', '缺依赖.js')
const GOOD = path.join(PLUGINS_DIR, 'example', '好插件.js')
const BOOM = path.join(PLUGINS_DIR, 'example', '会报错.js')
const HUNG = path.join(PLUGINS_DIR, 'example', '卡死.js')

fs.writeFileSync(BAD_SYNTAX, 'import { JiuLiPlugin } from \'jiuli\'\nexport default class A extends JiuLiPlugin {\n') // 故意未闭合
fs.writeFileSync(BAD_IMPORT, 'import HL from \'../hl-plugin/model/HL.js\'\nexport default class B {}\n')
fs.writeFileSync(BAD_PKG, 'import axios from \'jiuli-测试用的不存在的包\'\nexport default class C {}\n')
fs.writeFileSync(
  GOOD,
  `import { JiuLiPlugin } from 'jiuli'
export default class Good extends JiuLiPlugin {
  constructor() {
    super({ name: '好插件', dsc: 'ok', rule: [{ reg: '^#好插件$', fnc: 'hi' }] })
  }
  async hi() { return this.reply('好插件可用') }
}
`,
)
fs.writeFileSync(
  BOOM,
  `import { JiuLiPlugin } from 'jiuli'
export default class Boom extends JiuLiPlugin {
  constructor() {
    super({ name: '会报错的插件', dsc: 'boom', rule: [{ reg: '^#报错$', fnc: 'boom' }] })
  }
  async boom() { throw new Error('这是插件自己的 bug') }
}
`,
)

/** 顶层 await 永不结束：模拟「加载卡住」的插件 */
fs.writeFileSync(
  HUNG,
  `import { JiuLiPlugin } from 'jiuli'
await new Promise(() => {})
export default class Hung extends JiuLiPlugin {
  constructor() {
    super({ name: '卡死的插件', dsc: 'hung' })
  }
}
`,
)

/** 比超时更晚才就绪：验证「迟到就绪会自动补进分发」 */
const SLOW = path.join(PLUGINS_DIR, 'example', '慢插件.js')
fs.writeFileSync(
  SLOW,
  `import { JiuLiPlugin } from 'jiuli'
await new Promise(r => setTimeout(r, 12000))
export default class Slow extends JiuLiPlugin {
  constructor() {
    super({ name: '慢插件', dsc: 'slow', rule: [{ reg: '^#慢插件$', fnc: 'hi' }] })
  }
  async hi() { return this.reply('慢插件上线') }
}
`,
)

/* ---------- 运行环境 ---------- */
const lines = []
const origLog = console.log
const origError = console.error
const push = (args, orig) => {
  lines.push(args.map(String).join(' ').replace(/\u001b\[[0-9;]*m/g, ''))
  orig(...args)
}
console.log = (...a) => push(a, origLog)
console.error = (...a) => push(a, origError)

for (const dir of ['logs', 'data', 'temp']) fs.mkdirSync(dir, { recursive: true })
const { default: JiuLiBot } = await import('../lib/core/bot.js')
const { injectGlobals } = await import('../lib/core/globals.js')
const { ensureDirs } = await import('../lib/core/start.js')
const { redisInit } = await import('../lib/core/redis.js')
await ensureDirs()
const bot = new JiuLiBot()
await injectGlobals(bot)
await redisInit()

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

/* ---------- A. 加载期 ---------- */
const loader = (await import('../lib/core/loader.js')).default
const startAt = Date.now()
const loaded = await Promise.race([
  loader.load().then(() => 'ok'),
  new Promise(r => setTimeout(() => r('timeout'), 30000)),
])
check('坏插件不阻塞启动（30 秒内完成加载）', loaded === 'ok', loaded === 'timeout' ? '卡住了！' : `用时 ${Date.now() - startAt}ms`)
check('插件加载数量汇总照常输出', lines.some(l => /插件 \d+ 个 · 规则 \d+ 条/.test(l)))
check('好插件仍被加载', loader.priority.some(i => i.name === '好插件'))

const errLines = lines.filter(l => l.includes('插件加载错误'))
const syntaxErr = errLines.find(l => l.includes('坏语法.js'))
const importErr = errLines.find(l => l.includes('坏引用.js'))
const pkgErr = errLines.find(l => l.includes('缺依赖.js'))
check('语法错误 → 指明文件与原因', Boolean(syntaxErr) && /语法错误/.test(syntaxErr), syntaxErr?.slice(0, 100))
check(
  '缺本地文件 → 显示缺失路径与引入者',
  Boolean(importErr) && importErr.includes('HL.js') && importErr.includes('找不到文件'),
  importErr?.slice(0, 120),
)
check('缺依赖包 → 包名与安装命令', Boolean(pkgErr) && pkgErr.includes('缺少依赖包'), pkgErr?.slice(0, 110))
check(
  '缺依赖给出下一步（pnpm add / pnpm i）',
  lines.some(l => l.includes('pnpm add') || l.includes('pnpm i')),
  lines.find(l => l.includes('pnpm '))?.slice(0, 80) || '（无提示）',
)
check('加载期不再刷屏 Node 堆栈', !errLines.some(l => /at (ModuleLoader|ModuleJob|finalizeResolution)/.test(l)))

/* ---------- A2. 插件一直不就绪：不能默默卡住 ---------- */
check(
  '等待期间有进度输出（点名还没就绪的插件）',
  lines.some(l => l.includes('个插件就绪') && l.includes('卡死.js')),
  lines.find(l => l.includes('个插件就绪'))?.replace(/\s+/g, ' ').slice(0, 120) || '（没有任何进度输出）',
)
check(
  '超时后给出原因与后续做法',
  lines.some(l => l.includes('插件加载超时') && l.includes('卡死.js') && l.includes('#重载')),
  lines.find(l => l.includes('插件加载超时'))?.replace(/\s+/g, ' ').slice(0, 110) || '（没有超时提示）',
)
check('卡死插件不会拖住启动（超时后照常继续）', loaded === 'ok' && Date.now() - startAt < 30000)

/* ---------- A3. 迟到就绪（超时后才 import 完）自动补进分发 ---------- */
{
  let attached = false
  for (let i = 0; i < 40; i++) {
    if (loader.priority.some(i => i.name === '慢插件')) {
      attached = true
      break
    }
    await new Promise(r => setTimeout(r, 500))
  }
  check('超时后才就绪的插件会自动加入分发', attached, attached ? '' : '（一直没进来）')
  check(
    '迟到就绪有明确日志',
    lines.some(l => l.includes('迟到就绪')),
    lines.find(l => l.includes('迟到就绪'))?.replace(/\s+/g, ' ').slice(0, 90) || '（无日志）',
  )
}

/* ---------- B. 运行期 ---------- */
const mock = (bot.adapter || []).find(a => a.name === 'Mock')
const { listenerLoader } = await import('../lib/core/events.js')
for (const f of ['message.js', 'notice.js', 'request.js']) await listenerLoader.loadEvent(f)
await mock.load()
const emit = globalThis.__jiuli_mock_emit
const sent = globalThis.__jiuli_mock_sent
const sleep = ms => new Promise(r => setTimeout(r, ms))

lines.length = 0
sent.length = 0
emit({ type: 'message', group_id: '999000111', user_id: '10001', msg: '#报错' })
await sleep(800)
const boomLine = lines.find(l => l.includes('执行出错'))
check(
  '运行期报错 → 一行原因 + 插件内出错位置',
  Boolean(boomLine) && boomLine.includes('这是插件自己的 bug') && /会报错\.js:\d+:\d+/.test(boomLine),
  boomLine?.slice(0, 130) || '（没捕获到）',
)
check(
  '运行期报错说明「不影响其他插件」',
  lines.some(l => l.includes('其他插件') && l.includes('不受影响')),
  lines.find(l => l.includes('不受影响'))?.slice(0, 90),
)
check('运行期报错不刷屏堆栈', !lines.some(l => /at (ModuleLoader|ModuleScope|node:internal)/.test(l)))

lines.length = 0
sent.length = 0
emit({ type: 'message', group_id: '999000112', user_id: '10001', msg: '#好插件' })
await sleep(600)
check('一个插件报错后，其他插件照常响应', JSON.stringify(sent).includes('好插件可用'), JSON.stringify(sent).slice(0, 80))

/* ---------- C. 修好后能重新加载 ---------- */
fs.writeFileSync(
  BAD_IMPORT,
  `import { JiuLiPlugin } from 'jiuli'
export default class Fixed extends JiuLiPlugin {
  constructor() {
    super({ name: '修好的插件', dsc: 'fixed', rule: [{ reg: '^#修好了$', fnc: 'hi' }] })
  }
  async hi() { return this.reply('修好了') }
}
`,
)
await loader.changePlugin('example/坏引用.js').catch(() => {})
check(
  '修好后的插件 #重载 能加载（此前会被当成惰性文件跳过）',
  loader.priority.some(i => i.key === 'example/坏引用.js'),
  loader.priority.some(i => i.key === 'example/坏引用.js') ? '' : '未加载',
)

const pass = results.filter(r => r.ok).length
console.log(`\n=== 坏插件与报错处理测试：${pass}/${results.length} 通过 ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)

/**
 * 临时目录不在本进程内删除：Windows 上删除「刚加载过的模块目录」会让进程异常退出，
 * 而本测试开头会清一遍，留到下次运行清理即可。
 */
process.exit(pass === results.length ? 0 : 1)
