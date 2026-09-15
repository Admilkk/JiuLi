/**
 * 坏插件的处理验证
 *
 * 场景：plugins/ 里存在「语法错误」或「import 了不存在的本地文件/依赖」的插件时，
 *  1) 不能卡住启动（其余插件照常加载、引导流程照常走完）
 *  2) 报错要能看懂：指明文件、原因，并给出下一步（补依赖 / 装包 / 修语法）
 *  3) 热重载（改坏 → 改好）也不受影响
 *
 * 用隔离插件目录跑，不碰真实 plugins/。
 * 用法：node test/broken-plugin.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.JIULI_CONFIG_DIR = 'test/.tmp-broken-cfg/'
const PLUGINS_DIR = '.tmp-plugins-broken'
process.env.JIULI_PLUGINS_DIR = PLUGINS_DIR

for (const d of ['test/.tmp-broken-cfg', PLUGINS_DIR]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync('test/.tmp-broken-cfg', { recursive: true })
fs.mkdirSync(path.join(PLUGINS_DIR, 'example'), { recursive: true })

/** 只放内置 + 适配器，够走完加载流程即可 */
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
  'log_level: info\nplugin_load_timeout: 20\nfile_watch: false\nlog_msg: true\n',
)
fs.writeFileSync('test/.tmp-broken-cfg/other.yaml', 'master:\n  - "mock:10001"\n')

/* ---------- 坏插件：语法错误 / import 不存在的本地文件 / 缺依赖包 ---------- */
const BAD_SYNTAX = path.join(PLUGINS_DIR, 'example', '坏语法.js')
const BAD_IMPORT = path.join(PLUGINS_DIR, 'example', '坏引用.js')
const BAD_PKG = path.join(PLUGINS_DIR, 'example', '缺依赖.js')
const GOOD = path.join(PLUGINS_DIR, 'example', '好插件.js')

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

/* ---------- 捕获日志（错误走 console.error） ---------- */
const lines = []
const origLog = console.log
const origError = console.error
const push = (args, orig) => {
  const line = args.map(String).join(' ')
  lines.push(line.replace(/\u001b\[[0-9;]*m/g, ''))
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

/* ---------- 1. 启动不能被卡住 ---------- */
const loader = (await import('../lib/core/loader.js')).default
const startAt = Date.now()
const timeout = new Promise(r => setTimeout(() => r('timeout'), 30000))
const loaded = await Promise.race([loader.load().then(() => 'ok'), timeout])
const cost = Date.now() - startAt
console.log = origLog
console.error = origError

check('坏插件不阻塞启动（30 秒内完成加载）', loaded === 'ok', loaded === 'timeout' ? '卡住了！' : `用时 ${cost}ms`)
check('插件加载数量汇总照常输出', lines.some(l => /插件 \d+ 个 · 规则 \d+ 条/.test(l)))
check('好插件仍被加载', loader.priority.some(i => i.name === '好插件'))

/* ---------- 2. 报错内容要看得懂 ---------- */
const errLines = lines.filter(l => l.includes('插件加载错误'))
const syntaxErr = errLines.find(l => l.includes('坏语法.js'))
const importErr = errLines.find(l => l.includes('坏引用.js'))
check('语法错误的报错指明文件与原因', Boolean(syntaxErr) && /语法|SyntaxError|未闭合|Unexpected/.test(syntaxErr), syntaxErr?.slice(0, 110))
check(
  'import 不存在的本地文件 → 给出所在文件与缺失路径',
  Boolean(importErr) && importErr.includes('HL.js') && importErr.includes('找不到文件') && !importErr.includes('at ModuleLoader'),
  importErr?.slice(0, 140),
)
const pkgErr = lines.find(l => l.includes('缺依赖.js'))
check('缺依赖包 → 指明包名与安装命令', Boolean(pkgErr) && /缺少依赖包|没有装/.test(pkgErr + lines.join('\n')), pkgErr?.slice(0, 120))
check(
  '缺依赖时给出下一步（pnpm i / pnpm add）',
  lines.some(l => l.includes('pnpm add') || l.includes('pnpm i')),
  lines.find(l => l.includes('pnpm '))?.slice(0, 90) || '（无提示）',
)
check('不再刷屏原始 Node 堆栈', !errLines.some(l => /at (ModuleLoader|ModuleJob|finalizeResolution)/.test(l)))

/* ---------- 3. 修好之后能重新加载 ---------- */
fs.writeFileSync(
  BAD_IMPORT,
  `import { JiuLiPlugin } from 'jiuli'
export default class B extends JiuLiPlugin {
  constructor() {
    super({ name: '修好的插件', dsc: 'fixed', rule: [{ reg: '^#修好了$', fnc: 'hi' }] })
  }
  async hi() { return this.reply('修好了') }
}
`,
)
/** 修好后重新加载（#重载 走的就是 changePlugin，key 是相对 plugins/ 的路径） */
await loader.changePlugin('example/坏引用.js').catch(() => {})
check(
  '修好后的插件 #重载 能加载（此前会被当成惰性文件跳过）',
  loader.priority.some(i => i.key === 'example/坏引用.js'),
  loader.priority.some(i => i.key === 'example/坏引用.js') ? '' : '未加载',
)

const pass = results.filter(r => r.ok).length
console.log(`\n=== 坏插件处理测试：${pass}/${results.length} 通过 ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)

/**
 * 临时目录不在本进程内删除：Windows 上删除「刚加载过（含加载失败）的模块目录」会让
 * 进程异常退出（实测退出码 127），而本测试开头就会清一遍，留到下次运行清理即可。
 */
process.exit(pass === results.length ? 0 : 1)
