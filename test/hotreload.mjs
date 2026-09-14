/**
 * 热重载测试
 *
 * 验证：新增 js 文件 / 修改 js / 删除 js / 新建插件目录 都会被自动识别
 * 用法：node test/hotreload.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 测试配置（config/config 已 gitignore） */
fs.mkdirSync('config/config', { recursive: true })
fs.writeFileSync('config/config/bot.yaml', 'log_level: info\nplugin_load_timeout: 60\nfile_watch: true\nlog_msg: true\n')
fs.writeFileSync('config/config/other.yaml', 'master:\n  - "mock:10001"\nautoFriend: 1\nautoGroup: 0\nautoQuit: 0\n')
fs.writeFileSync('config/config/server.yaml', 'url: http://localhost:25370\nport: 25370\nredirect: https://x\nauth:\n')
fs.writeFileSync('config/config/group.yaml', 'default:\n  groupCD: 0\n  singleCD: 0\n  onlyReplyAt: 0\n')

const FILE = 'plugins/example/hot-reload-test.js'
const DIR = 'plugins/hotreload-newdir'
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
check('内置 #重载 指令', json().includes('重载完成'), json().replace(/\\"/g, '"').slice(0, 90))

/** 5. 删除文件 */
fs.rmSync(FILE, { force: true })
await sleep(4000)
check('删除 js → 自动卸载', !loader.priority.some(i => i.key === 'example/hot-reload-test.js'))

sent.length = 0
send()
await sleep(400)
check('卸载后不再响应（无匹配插件）', !json().includes('热重载版本'), json().slice(0, 40))

/* 汇总 */
fs.rmSync(DIR, { recursive: true, force: true })
const pass = results.filter(r => r.ok).length
console.log(`\n=== 热重载测试：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
