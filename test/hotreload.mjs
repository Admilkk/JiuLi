/**
 * 热重载测试
 *
 * 验证：新增 js 文件 / 修改 js / 删除 js / 新建插件目录 都会被自动识别
 * 用法：node test/hotreload.mjs
 */
import fs from 'node:fs'


/** 测试用隔离配置目录：绝不碰真实的 config/config */
process.env.JIULI_CONFIG_DIR = 'test/.tmp-config/'

import path from 'node:path'

/**
 * 测试用隔离插件目录（只放内置/示例 + 夹具，避免生态插件抢指令，也让测试快很多）
 * 注意：必须位于项目根目录下一级，旧插件的 "../../lib/..." 相对路径才成立
 */
const PLUGINS_DIR = '.tmp-plugins'
process.env.JIULI_PLUGINS_DIR = PLUGINS_DIR
fs.rmSync(PLUGINS_DIR, { recursive: true, force: true })
fs.mkdirSync(PLUGINS_DIR, { recursive: true })
/** 复制目录但跳过 node_modules / 符号链接（plugins/example/node_modules/jiuli 指向项目根，直接复制会递归） */
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
for (const dir of ['system', 'adapter', 'demo', 'example']) {
  const from = path.join('plugins', dir)
  if (!fs.existsSync(from)) continue
  copyTree(from, path.join(PLUGINS_DIR, dir))
}
/** 让隔离目录里的插件也能 import 'jiuli'（指向项目根的链接） */
fs.mkdirSync(path.join(PLUGINS_DIR, 'node_modules'), { recursive: true })
try {
  fs.symlinkSync(path.resolve('.'), path.join(PLUGINS_DIR, 'node_modules', 'jiuli'), 'junction')
} catch {}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 测试配置（config/config 已 gitignore） */
fs.mkdirSync('test/.tmp-config', { recursive: true })
fs.writeFileSync('test/.tmp-config/bot.yaml', 'log_level: info\nplugin_load_timeout: 60\nfile_watch: true\nlog_msg: true\n')
fs.writeFileSync('test/.tmp-config/other.yaml', 'master:\n  - "mock:10001"\nautoFriend: 1\nautoGroup: 0\nautoQuit: 0\n')
fs.writeFileSync('test/.tmp-config/server.yaml', 'url: http://localhost:25370\nport: 25370\nredirect: https://x\nauth:\n')
fs.writeFileSync('test/.tmp-config/group.yaml', 'default:\n  groupCD: 0\n  singleCD: 0\n  onlyReplyAt: 0\n')

const FILE = '.tmp-plugins/example/hot-reload-test.js'
const DIR = path.join(PLUGINS_DIR, 'hotreload-newdir')
const pluginSource = version => `import { JiuLiPlugin } from 'jiuli'

export default class HotReloadTest extends JiuLiPlugin {
  constructor() {
    super({
      name: '热重载测试${version}',
      dsc: 'hot reload',
      event: 'message',
      priority: -Infinity,
      rule: [{ reg: '^#热重载测试$', fnc: 'hi' }],
    })
  }

  async hi() {
    return this.reply('热重载版本 ${version}')
  }
}
`

fs.rmSync(FILE, { force: true })
fs.rmSync(DIR, { recursive: true, force: true })

const { start } = await import('../lib/core/start.js')
const bot = await start()
if (bot.stat.online !== 2) await new Promise(r => bot.once('online', r))
const loader = (await import('../lib/plugins/loader.js')).default
const emit = globalThis.__jiuli_mock_emit
const sent = globalThis.__jiuli_mock_sent
await sleep(2500) // 等热重载 watcher 就绪

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}
const json = () => JSON.stringify(sent)
const send = () => emit({ type: 'message', group_id: '777000111', user_id: '10001', msg: '#热重载测试' })

/** 1. 新增文件 */
fs.writeFileSync(FILE, pluginSource('v1'))
await sleep(4000)
check('新增 js 文件 → 自动加载', loader.priority.some(i => i.key === 'example/hot-reload-test.js'))

sent.length = 0
send()
await sleep(400)
check('新增文件的指令可用', json().includes('热重载版本 v1'), json().slice(0, 60))

/** 2. 修改文件 */
fs.writeFileSync(FILE, pluginSource('v2'))
await sleep(4500)
sent.length = 0
send()
await sleep(400)
check('修改 js → 自动重载（版本生效）', json().includes('热重载版本 v2'), json().slice(0, 60))

/** 3. 新建插件目录（index.js 形式） */
fs.mkdirSync(DIR, { recursive: true })
fs.writeFileSync(
  path.join(DIR, 'index.js'),
  `import { JiuLiPlugin } from 'jiuli'

export default class NewDirPlugin extends JiuLiPlugin {
  constructor() {
    super({ name: '新目录插件', dsc: 'test', event: 'message', priority: -Infinity, rule: [{ reg: '^#新目录插件$', fnc: 'hi' }] })
  }
  async hi() {
    return this.reply('来自新目录插件')
  }
}
`,
)
await sleep(4000)
check('新建插件目录 → 自动加载', loader.priority.some(i => i.key === 'hotreload-newdir'))

sent.length = 0
emit({ type: 'message', group_id: '777000111', user_id: '10001', msg: '#新目录插件' })
await sleep(400)
check('新目录插件的指令可用', json().includes('来自新目录插件'), json().slice(0, 60))

/** 4. 手动重载指令 */
sent.length = 0
emit({ type: 'message', group_id: '777000111', user_id: '10001', msg: '#重载 hot-reload-test' })
await sleep(4000)
check('内置 #重载 指令', json().includes('处理完成'), json().replace(/\\"/g, '"').slice(0, 90))

/** 5. 删除文件 */
fs.rmSync(FILE, { force: true })
await sleep(4000)
check('删除 js → 自动卸载', !loader.priority.some(i => i.key === 'example/hot-reload-test.js'))

sent.length = 0
send()
await sleep(400)
check('卸载后不再响应（无匹配插件）', !json().includes('热重载版本'), json().slice(0, 40))


/** 6. 重载时清理插件注册的 express 路由（避免重复注册） */
{
  const dir = path.join(PLUGINS_DIR, 'hotreload-route')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `import { JiuLiPlugin } from 'jiuli'
const app = Bot.express
app.get('/hotreload-route-test', (req, res) => res.end('ok'))

export default class RoutePlugin extends JiuLiPlugin {
  constructor() {
    super({ name: '路由测试', dsc: 'test', event: 'message', priority: -Infinity, rule: [{ reg: '^#路由测试$', fnc: 'hi' }] })
  }
  async hi() {
    return this.reply('路由测试 OK')
  }
}
`,
  )

  const countRoute = () => {
    const router = globalThis.Bot.express?.router || globalThis.Bot.express?._router
    return (router?.stack || []).filter(l => l.route?.path === '/hotreload-route-test').length
  }

  await sleep(4000)
  check('插件注册的 express 路由已生效', countRoute() === 1, `路由层数 ${countRoute()}`)

  sent.length = 0
  emit({ type: 'message', group_id: '777000111', user_id: '10001', msg: '#重载 hotreload-route' })
  await sleep(5000)
  check('重载后路由不重复注册（清理旧层）', countRoute() === 1, `重载后路由层数 ${countRoute()}`)

  sent.length = 0
  emit({ type: 'message', group_id: '777000111', user_id: '10001', msg: '#路由测试' })
  await sleep(500)
  check('重载后指令仍可用', json().includes('路由测试 OK'), json().slice(0, 50))

  fs.rmSync(dir, { recursive: true, force: true })
  await sleep(3500)
}

/* 汇总 */
fs.rmSync(DIR, { recursive: true, force: true })
const pass = results.filter(r => r.ok).length
console.log(`\n=== 热重载测试：${pass}/${results.length} 通过 ===`)
try { fs.rmSync('test/.tmp-config', { recursive: true, force: true }) } catch {}
try { fs.rmSync(PLUGINS_DIR, { recursive: true, force: true }) } catch {}
process.exit(pass === results.length ? 0 : 1)
