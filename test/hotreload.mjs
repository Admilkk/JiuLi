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

  /** 卸载回调：写标记文件，供测试断言「卸载时确实调用了 onUnload」 */
  async onUnload() {
    const fs = await import('node:fs')
    fs.writeFileSync('test/.tmp-onunload', '${version}')
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
check(
  '卸载时调用插件 onUnload（释放端口/定时器用）',
  fs.existsSync('test/.tmp-onunload'),
  fs.existsSync('test/.tmp-onunload') ? `标记内容 ${fs.readFileSync('test/.tmp-onunload', 'utf8')}` : '未调用',
)

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
  /** 并行导入时「当前加载的插件」必须是它自己：记到别人名下会导致重载时清不掉旧路由 */
  const ownLayers = globalThis.Bot.pluginLayers?.get('hotreload-route')?.size ?? 0
  check('路由归属到插件自己名下', ownLayers >= 1, `pluginLayers[hotreload-route]=${ownLayers}`)

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

/**
 * 7. 目录型插件（index.js + lib/ + apps/）：改**嵌套模块**也要真的生效
 *
 * 回归的是「日志写着重载、跑的却还是旧代码」：原来的重载只给入口（index.js?时间戳）
 * 换 URL，入口里 `import './lib/inner.js'` 解析出的 URL 不带时间戳，命中 Node 的 ESM
 * 模块缓存 —— lib/ 里的新代码根本不会被求值，用户必须重启。
 * 这里只改 lib/inner.js、入口一个字不动，断言输出跟着变。
 */
{
  const dir = path.join(PLUGINS_DIR, 'hotreload-nested')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  const indexPath = path.join(dir, 'index.js')
  const innerPath = path.join(dir, 'lib', 'inner.js')
  fs.writeFileSync(
    indexPath,
    [
      "import { label } from './lib/inner.js'",
      "import { JiuLiPlugin } from 'jiuli'",
      '',
      'export default class NestedPlugin extends JiuLiPlugin {',
      '  constructor() {',
      "    super({ name: '嵌套模块测试', dsc: 'test', event: 'message', priority: -Infinity, rule: [{ reg: '^#嵌套测试$', fnc: 'hi' }] })",
      '  }',
      '  async hi() {',
      "    return this.reply('嵌套 ' + label())",
      '  }',
      '}',
      '',
    ].join('\n'),
  )
  const innerSource = v => `export function label() {\n  return '${v}'\n}\n`
  fs.writeFileSync(innerPath, innerSource('v1'))

  const ask = async () => {
    sent.length = 0
    emit({ type: 'message', group_id: '777000111', user_id: '10001', msg: '#嵌套测试' })
    await sleep(500)
    return json()
  }

  await sleep(4000)
  check('目录型插件加载', (await ask()).includes('嵌套 v1'), json().slice(0, 50))

  fs.writeFileSync(innerPath, innerSource('v2'))
  await sleep(4500)
  check('改 lib/ 里的嵌套模块 → 重载后真的生效', (await ask()).includes('嵌套 v2'), json().slice(0, 60))

  /** 入口自己改了同样要生效（这条在修复前就是通的，防止改坏） */
  fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').replace('嵌套 ', '入口也改了 '))
  await sleep(4500)
  check('改入口 index.js → 同样生效', (await ask()).includes('入口也改了 v2'), json().slice(0, 60))

  fs.rmSync(dir, { recursive: true, force: true })
  await sleep(3500)
}

/**
 * 8. 重载不能让插件在同优先级里「掉队」
 *
 * 回归的是「重载 miao-plugin 之后 #更新面板 被系统更新插件顶掉」：派发按 priority 升序、
 * 同优先级按加载顺序先匹配先赢，而重载是「删掉条目再 push 到末尾」—— 重载过的插件于是
 * 掉到同优先级队伍最后，指令归属就变了（生态插件大量用 -Infinity，互相重叠很常见）。
 */
{
  const mk = (key, tag) => {
    const dir = path.join(PLUGINS_DIR, key)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      [
        "import { JiuLiPlugin } from 'jiuli'",
        '',
        `export default class Prio${tag} extends JiuLiPlugin {`,
        '  constructor() {',
        `    super({ name: '抢指令${tag}', dsc: 'test', event: 'message', priority: -Infinity, rule: [{ reg: '^#抢指令$', fnc: 'hi' }] })`,
        '  }',
        '  async hi() {',
        `    return this.reply('来自 ${tag}')`,
        '  }',
        '}',
        '',
      ].join('\n'),
    )
  }
  mk('hotreload-prio-a', 'A')
  mk('hotreload-prio-b', 'B')
  await sleep(4500)

  const ask = async () => {
    sent.length = 0
    emit({ type: 'message', group_id: '777000111', user_id: '10001', msg: '#抢指令' })
    await sleep(500)
    return json()
  }
  const first = await ask()
  const winner = first.includes('来自 A') ? 'hotreload-prio-a' : first.includes('来自 B') ? 'hotreload-prio-b' : ''
  check('两个同优先级插件都加载并抢同一条指令', Boolean(winner), first.slice(0, 60))
  /** 失败时把同优先级那一段的真实顺序打出来 */
  const orderGroup = () =>
    loader.priority
      .filter(i => i.priority === -Infinity)
      .map(i => `${i.key}#${i.order}`)
      .join(' | ')

  if (winner) {
    const tag = winner.endsWith('-a') ? 'A' : 'B'
    const loserTag = tag === 'A' ? 'B' : 'A'
    const orderOf = key => loader.priority.find(i => i.key === key)?.order
    const orderBefore = orderOf(winner)

    /** 改内容（顺带验证重载真的换了代码）+ 重载：胜者必须还是它 */
    const winnerFile = path.join(PLUGINS_DIR, winner, 'index.js')
    fs.writeFileSync(winnerFile, fs.readFileSync(winnerFile, 'utf8').replace(`来自 ${tag}`, `来自 ${tag}改`))
    await sleep(4500)
    const after = await ask()
    check('重载后新代码生效', after.includes(`来自 ${tag}改`), after.slice(0, 60))
    check(
      `重载后仍是原来那个赢（${tag}，不是 ${loserTag}）`,
      !after.includes(`来自 ${loserTag}`),
      `${after.slice(0, 40)} ｜ 同优先级顺序：${orderGroup()}`,
    )
    check('重载前后 order 号不变', orderOf(winner) === orderBefore, `${orderBefore} → ${orderOf(winner)}`)
  }

  fs.rmSync(path.join(PLUGINS_DIR, 'hotreload-prio-a'), { recursive: true, force: true })
  fs.rmSync(path.join(PLUGINS_DIR, 'hotreload-prio-b'), { recursive: true, force: true })
  await sleep(3000)
}

/**
 * 9. 加载期挂的 Bot 监听要在重载时清掉
 *
 * 回归的是「每重载一次多留一份监听」：插件在**模块顶层** `Bot.on(...)` 时（生态插件常见写法，
 * 如 xiaofei 的 guild.message、yenai 的 message.group 点赞），旧那份监听留在 EventEmitter 上，
 * 一条消息被处理 N 次。运行期（指令里）动态挂的监听不算插件资源，重载后应当保留。
 */
{
  const dir = path.join(PLUGINS_DIR, 'hotreload-listener')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    [
      "import { JiuLiPlugin } from 'jiuli'",
      '',
      'globalThis.__fixtureHits = 0',
      'globalThis.__runtimeHits = 0',
      "Bot.on('message', () => { globalThis.__fixtureHits++ })",
      '',
      'export default class ListenerFixture extends JiuLiPlugin {',
      '  constructor() {',
      "    super({ name: '监听夹具', dsc: 'test', event: 'message', priority: -Infinity, rule: [",
      "      { reg: '^#夹具挂监听$', fnc: 'addRuntime' },",
      "      { reg: '^#夹具$', fnc: 'hi' },",
      '    ] })',
      '  }',
      '  async addRuntime() {',
      "    Bot.on('message.group', () => { globalThis.__runtimeHits++ })",
      "    return this.reply('已挂运行期监听')",
      '  }',
      '  async hi() {',
      "    return this.reply('夹具 OK')",
      '  }',
      '}',
      '',
    ].join('\n'),
  )
  await sleep(4500)

  const count = event => globalThis.Bot.listenerCount(event)
  const before = { message: count('message'), group: count('message.group') }
  check('加载期监听已挂上', before.message > 0, `message=${before.message}`)

  sent.length = 0
  emit({ type: 'message', group_id: '777000111', user_id: '10001', msg: '#夹具挂监听' })
  await sleep(600)
  check('指令里动态挂的监听生效', count('message.group') === before.group + 1, `message.group=${count('message.group')}`)

  for (let i = 0; i < 2; i++) {
    await loader.changePlugin('hotreload-listener')
    await sleep(400)
  }
  check('重载不会累积加载期监听', count('message') === before.message, `message ${before.message} → ${count('message')}`)
  check('运行期挂的监听不被误删', count('message.group') === before.group + 1, `message.group=${count('message.group')}`)

  globalThis.__fixtureHits = 0
  sent.length = 0
  emit({ type: 'message', group_id: '777000111', user_id: '10001', msg: '随便一句' })
  await sleep(600)
  check('一条消息只触发一次加载期监听', globalThis.__fixtureHits === 1, `命中 ${globalThis.__fixtureHits} 次`)

  fs.rmSync(dir, { recursive: true, force: true })
  await sleep(3000)
}

/* 汇总 */
fs.rmSync(DIR, { recursive: true, force: true })
const pass = results.filter(r => r.ok).length
console.log(`\n=== 热重载测试：${pass}/${results.length} 通过 ===`)
try { fs.rmSync('test/.tmp-config', { recursive: true, force: true }) } catch {}
try { fs.rmSync(PLUGINS_DIR, { recursive: true, force: true }) } catch {}
process.exit(pass === results.length ? 0 : 1)
