/**
 * #安装插件 验证
 *
 * 只覆盖不联网的路径：可安装列表、未知插件、已存在（含 git 地址解析）、权限。
 * 真正的 git clone 要联网，不作为自动化用例。
 *
 * 用法：node test/install-plugin.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

process.env.JIULI_CONFIG_DIR = 'test/.tmp-install-cfg/'
const PLUGINS_DIR = '.tmp-plugins-install'
process.env.JIULI_PLUGINS_DIR = PLUGINS_DIR

for (const d of ['test/.tmp-install-cfg', PLUGINS_DIR]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync('test/.tmp-install-cfg', { recursive: true })

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
  'test/.tmp-install-cfg/bot.yaml',
  'log_level: info\nplugin_load_timeout: 30\nfile_watch: false\nlog_msg: true\n',
)
fs.writeFileSync('test/.tmp-install-cfg/other.yaml', 'master:\n  - "mock:10001"\n')
fs.writeFileSync('test/.tmp-install-cfg/group.yaml', 'default:\n  groupCD: 0\n  singleCD: 0\n  onlyReplyAt: 0\n')

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

const { listenerLoader } = await import('../lib/core/events.js')
await listenerLoader.loadEvent('message.js')

const mock = (bot.adapter || []).find(a => a.name === 'Mock')
if (!mock) {
  console.log('未找到 Mock 适配器，无法测试')
  process.exit(1)
}
await mock.load()
const emit = globalThis.__jiuli_mock_emit
const sent = globalThis.__jiuli_mock_sent
const sleep = ms => new Promise(r => setTimeout(r, ms))

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

let seq = 0
async function send(msg, user_id = '10001') {
  const group_id = `mock:7${String(++seq).padStart(3, '0')}`
  sent.length = 0
  emit({ type: 'message', group_id, user_id, msg })
  for (let i = 0; i < 20 && !sent.length; i++) await sleep(250)
  return sent.map(i => (Array.isArray(i.msg) ? i.msg.join('') : i.msg)).join('\n')
}

check('插件已加载', loader.priority.some(i => i.name === '安装插件'), '分发列表里没有「安装插件」')

const list = await send('#安装插件')
check('#安装插件 给出可安装列表', /可安装插件/.test(list), list.slice(0, 60).replace(/\n/g, ' '))

const unknown = await send('#安装插件 不存在的插件名')
check('未知插件给出提示而不是静默', /没有「不存在的插件名」/.test(unknown), unknown.slice(0, 60).replace(/\n/g, ' '))

/** 地址解析出的目录名已存在（隔离目录里有 system）→ 不能再去 clone */
const exists = await send('#安装插件 https://gitee.com/example/system.git')
check('git 地址解析出目录名并识别已安装', /「system」已存在/.test(exists), exists.slice(0, 60).replace(/\n/g, ' '))

const notMaster = await send('#安装插件', '10002')
check('非主人不可用', /没有权限/.test(notMaster), notMaster.slice(0, 40).replace(/\n/g, ' '))

const pass = results.filter(r => r.ok).length
console.log(`\n=== #安装插件 验证：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
