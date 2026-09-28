/**
 * 规则调用参数 + 云崽日志文件兼容验证
 *
 * 1. 云崽只把 e 传给规则方法；带捕获组的规则不能无条件多传一个参数，
 *    否则 `fnc(e, isYesterday = false)` 这类插件的开关会被顶成真值（水群统计曾因此只查昨日）。
 *    只有方法自己声明了第二个参数时才给捕获结果。
 * 2. 插件会直接读云崽的日志文件名（logs/command.<日期>.log、logs/error.log），
 *    框架必须同步写这两个文件。
 *
 * 用法：node test/rule-args.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

process.env.JIULI_CONFIG_DIR = 'test/.tmp-ra-cfg/'
const PLUGINS_DIR = '.tmp-plugins-ra'
process.env.JIULI_PLUGINS_DIR = PLUGINS_DIR

for (const d of ['test/.tmp-ra-cfg', PLUGINS_DIR, 'test/.tmp-ra-logs']) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync('test/.tmp-ra-cfg', { recursive: true })
fs.mkdirSync(path.join(PLUGINS_DIR, 'example'), { recursive: true })

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
for (const dir of ['system', 'adapter', 'demo'])
  if (fs.existsSync(path.join('plugins', dir))) copyTree(path.join('plugins', dir), path.join(PLUGINS_DIR, dir))
fs.mkdirSync(path.join(PLUGINS_DIR, 'node_modules'), { recursive: true })
try {
  fs.symlinkSync(path.resolve('.'), path.join(PLUGINS_DIR, 'node_modules', 'jiuli'), 'junction')
} catch {}

fs.writeFileSync('test/.tmp-ra-cfg/bot.yaml', 'log_level: info\nplugin_load_timeout: 30\nfile_watch: false\n')
fs.writeFileSync('test/.tmp-ra-cfg/other.yaml', 'master:\n  - "mock:10001"\n')
fs.writeFileSync('test/.tmp-ra-cfg/group.yaml', 'default:\n  groupCD: 0\n  singleCD: 0\n  onlyReplyAt: 0\n')

fs.writeFileSync(
  path.join(PLUGINS_DIR, 'example', '规则参数.js'),
  [
    "import { JiuLiPlugin } from 'jiuli'",
    'globalThis.__ruleArgs = {}',
    'class RuleArgs extends JiuLiPlugin {',
    '  constructor() {',
    '    super({',
    "      name: '规则参数',",
    "      dsc: '#参数A #参数B #参数C',",
    "      event: 'message',",
    '      rule: [',
    "        { reg: '^#参数A([0-9])?$', fnc: 'withDefault' },",
    "        { reg: '^#参数B([0-9])?$', fnc: 'withMatch' },",
    "        { reg: '^#参数C$', fnc: 'boom' },",
    '      ],',
    '    })',
    '  }',
    '  /** 第二个参数是开关，云崽不会传捕获结果进来 */',
    '  async withDefault(e, isYesterday = false) {',
    '    globalThis.__ruleArgs.defaultArg = isYesterday',
    "    return this.reply('A')",
    '  }',
    '  /** 自己声明了第二个参数 → 拿得到捕获结果 */',
    '  async withMatch(e, match) {',
    '    globalThis.__ruleArgs.matchArg = match?.[1]',
    "    return this.reply('B')",
    '  }',
    '  async boom() {',
    "    throw new Error('规则参数测试用的报错')",
    '  }',
    '}',
    'export default RuleArgs',
    '',
  ].join(String.fromCharCode(10)),
)

for (const dir of ['logs', 'data', 'temp']) fs.mkdirSync(dir, { recursive: true })
const { default: JiuLiBot } = await import('../lib/core/bot.js')
const { injectGlobals } = await import('../lib/core/globals.js')
const { ensureDirs } = await import('../lib/core/start.js')
const { redisInit } = await import('../lib/core/redis.js')
const { setLogDir } = await import('../lib/core/log.js')
await ensureDirs()

const bot = new JiuLiBot()
await injectGlobals(bot)
await redisInit()

const loader = (await import('../lib/core/loader.js')).default
await loader.load()

const { listenerLoader } = await import('../lib/core/events.js')
await listenerLoader.loadEvent('message.js')

const mock = (bot.adapter || []).find(a => a.name === 'Mock')
await mock.load()
const emit = globalThis.__jiuli_mock_emit
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 日志写到隔离目录，断言不受真实 logs/ 影响 */
const logDir = 'test/.tmp-ra-logs'
setLogDir(logDir)

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

const send = async (msg, user_id = '10001') => {
  emit({ type: 'message', group_id: 'mock:88001', user_id, msg })
  await sleep(600)
}

await send('#参数A')
check(
  '带捕获组的规则不把捕获结果当第二个参数（默认值不被顶掉）',
  globalThis.__ruleArgs.defaultArg === false || globalThis.__ruleArgs.defaultArg === undefined,
  `实际 ${JSON.stringify(globalThis.__ruleArgs.defaultArg)}`,
)

await send('#参数A7')
check(
  '命中捕获组时仍然只传 e',
  globalThis.__ruleArgs.defaultArg === false || globalThis.__ruleArgs.defaultArg === undefined,
  `实际 ${JSON.stringify(globalThis.__ruleArgs.defaultArg)}`,
)

await send('#参数B7')
check('方法自己声明了第二个参数时才收到捕获结果', globalThis.__ruleArgs.matchArg === '7', `实际 ${JSON.stringify(globalThis.__ruleArgs.matchArg)}`)

await send('#参数C')
await sleep(500)

/** 日志文件名是**本地**日期：不能用 toISOString()（UTC，本地 00:00-08:00 会差一天） */
const localDay = () => {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const day = localDay()
const commandFile = path.join(logDir, `command.${day}.log`)
const errorFile = path.join(logDir, 'error.log')
const fullFile = path.join(logDir, `jiuli.${day}.log`)
check('写出云崽同名的 logs/command.<日期>.log', fs.existsSync(commandFile), commandFile)
check(
  'command 日志里有指令级记录（命中 / 完成）',
  fs.existsSync(commandFile) && /中 ▶ 规则参数|完成 规则参数/.test(fs.readFileSync(commandFile, 'utf8')),
)
check('写出云崽同名的 logs/error.log', fs.existsSync(errorFile), errorFile)
check('error 日志里有报错内容', fs.existsSync(errorFile) && /规则参数测试用的报错/.test(fs.readFileSync(errorFile, 'utf8')))
check('完整日志 jiuli.<日期>.log 不受影响', fs.existsSync(fullFile), fullFile)

const pass = results.filter(r => r.ok).length
console.log(`\n=== 规则参数 / 日志文件兼容验证：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
