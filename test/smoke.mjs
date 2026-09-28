/**
 * JiuLi 冒烟测试
 *
 * 覆盖：旧插件（rule / accept / 权限 / 转发消息）、原生 DSL / 类形态插件、
 *       定时任务注册、消息计数批量写回、渲染管线（puppeteer 失败可容忍）
 *
 * 用法：node test/smoke.mjs
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

/**
 * 旧插件夹具：从 test/fixtures/ 复制到 plugins/_test-fixtures/（临时目录，测试结束删除）
 * 复制是必须的 —— 旧插件用相对路径 import 框架（../../lib/...），只有放在 plugins/<目录>/ 下才成立
 */
const FIXTURE_DIR = path.join(PLUGINS_DIR, '_test-fixtures')
fs.rmSync(FIXTURE_DIR, { recursive: true, force: true })
fs.mkdirSync(FIXTURE_DIR, { recursive: true })
let fixtureCount = 0
for (const file of fs.readdirSync('test/fixtures')) {
  if (!file.endsWith('.js')) continue
  fs.copyFileSync(path.join('test/fixtures', file), path.join(FIXTURE_DIR, file))
  fixtureCount++
}
/** 原生钩子测试插件（beforeMessage 拦截 / afterMessage 统计） */
fs.writeFileSync(
  path.join(FIXTURE_DIR, 'hook-test.js'),
  `import { JiuLiPlugin } from 'jiuli'
const state = { before: 0, after: 0 }
globalThis.__hookState = state
export class HookBefore extends JiuLiPlugin {
  constructor() {
    super({ name: '钩子测试', dsc: 'test', event: 'message', priority: -Infinity })
  }
  async beforeMessage(e) {
    state.before++
    if (e.msg === '#钩子拦截') return false
  }
}
export class HookAfter extends JiuLiPlugin {
  constructor() {
    super({ name: '钩子测试2', dsc: 'test', event: 'message', priority: -Infinity })
  }
  async afterMessage() {
    state.after++
  }
}
`,
)

/** 模拟"插件内部自己判断主人、非主人静默 return false"的第三方插件写法 */
fs.writeFileSync(
  path.join(FIXTURE_DIR, 'silent-deny.js'),
  `export class silentDeny extends plugin {
  constructor() {
    super({ name: '静默拒绝测试', dsc: 'test', event: 'message', rule: [{ reg: '^#静默拒绝$', fnc: 'deny' }] })
  }
  async deny() {
    if (!this.e.isMaster) return false
    return this.reply('主人你好')
  }
}
`,
)


/** 测试配置（config/config 为运行时目录，已 gitignore） */
fs.mkdirSync('test/.tmp-config', { recursive: true })
fs.writeFileSync(
  'test/.tmp-config/other.yaml',
  ['master:', '  - "mock:10001"', 'masterQQ:', '  - "10001"', 'autoFriend: 1', 'autoGroup: 0', 'autoQuit: 0'].join('\n'),
)
fs.writeFileSync(
  'test/.tmp-config/server.yaml',
  ['url: http://localhost:25360', 'port: 25360', 'redirect: https://gitee.com/fox-glaze/jiuli', 'auth:'].join('\n'),
)
fs.writeFileSync(
  'test/.tmp-config/group.yaml',
  ['default:', '  groupCD: 0', '  singleCD: 0', '  onlyReplyAt: 0', '  botAlias:', '    - 玖璃'].join('\n'),
)
/**
 * 默认配置已经把 no_handler_tip 改成 false（不再主动提示无响应），
 * 但下面 12b 要验证的正是这个提示机制，所以测试里显式打开它。
 */
fs.writeFileSync('test/.tmp-config/bot.yaml', 'no_handler_tip: true\n')

const { start } = await import('../lib/core/start.js')
const bot = await start()
if (bot.stat.online !== 2) await new Promise(r => bot.once('online', r))
await sleep(500)

const emit = globalThis.__jiuli_mock_emit
const sent = globalThis.__jiuli_mock_sent
const results = []
const skipped = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}
/** 旧插件夹具缺失时跳过对应用例（夹具来自 TRSS-Yunzai，见 test/fixtures/README.md） */
const legacy = fixtureCount > 0
const skip = name => {
  skipped.push(name)
  console.log(`⏭️  ${name} — 跳过（未找到 test/fixtures 夹具）`)
}
const clear = () => (sent.length = 0)
const json = () => JSON.stringify(sent)

const loader = (await import('../lib/plugins/loader.js')).default

/* ---------- 1. 旧插件：rule + reply ---------- */
if (legacy) {
  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '喵一个' })
  await sleep(300)
  check('旧插件 rule + reply（喵一个）', json().includes('喵?'))
} else skip('旧插件 rule + reply（喵一个）')

/* ---------- 2. 旧插件：accept + notice 事件 ---------- */
if (legacy) {
  clear()
  emit({ type: 'notice', notice_type: 'group', sub_type: 'increase', group_id: '888777666', user_id: '20002' })
  await sleep(300)
  check('旧插件 accept + notice（欢迎新人）', json().includes('欢迎'), json().slice(0, 80))
} else skip('旧插件 accept + notice（欢迎新人）')

/* ---------- 3. 内置 #状态（master + 转发消息 + load_time） ---------- */
if (legacy) {
  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#状态' })
  await sleep(1400) // 该用例要跑 redis 统计，留足时间避免抢跑
  check(
    '内置 #状态（master：运行信息 + 收发统计）',
    json().includes('JiuLi v') && json().includes('运行时间') && json().includes('消息 总计'),
    json().slice(0, 100),
  )
} else skip('内置 #状态（master + makeForwardArray）')

/* ---------- 4. JiuLi 内置插件 ---------- */
clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#帮助' })
await sleep(300)
check('内置 #帮助', json().includes('JiuLi 指令说明'))

clear()
emit({ type: 'message', group_id: '888777666', user_id: '99999', msg: '#状态' })
await sleep(400)
check('内置 #状态（非主人视图：仅消息统计）', json().includes('消息统计'))

clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#版本' })
await sleep(900)
check('内置 #版本', json().includes('AGPL-3.0'))

/** 很多云崽插件用框架 package.json 的版本号判断 V2/V3（例如 version[0] > 2 才算 V3，
 *  否则走旧分支、读不到 Bot.logger 之类的 V3 能力）。这里守住版本号不被改回 0.x */
{
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  const { default: cfg } = await import('../lib/core/config/index.js')
  check('框架版本号满足插件 V3 门禁（首段 > 2）', Number(pkg.version.split('.')[0]) > 2, pkg.version)
  check('插件看到的版本号同样是 V3（cfg.package）', Number(String(cfg.package.version).split('.')[0]) > 2, String(cfg.package.version))
}

clear()
emit({ type: 'message', group_id: '888777666', user_id: '99999', msg: '#设置主人' })
await sleep(300)
check('内置 #设置主人（非主人获取验证码）', json().includes('请输入验证码'))

clear()
emit({ type: 'message', group_id: '888777666', user_id: '99999', msg: '000000' })
await sleep(300)
check('内置 #设置主人（错误验证码 + 上下文结束）', json().includes('验证码错误'))

/* ---------- 4a2. 设置主人：正确验证码 → 写入配置（端到端） ---------- */
{
  /** 验证码只打在日志里，临时截获 console.log 取出 */
  await sleep(1200) // 等过 1 秒消息去重窗口（与上面的 #设置主人 文本相同）
  const logs = []
  const origLog = console.log
  console.log = (...args) => {
    logs.push(args.map(String).join(' '))
    origLog(...args)
  }
  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '99998', msg: '#设置主人' })
  await sleep(500)
  console.log = origLog

  /** 日志里带 ANSI 颜色码，先剥掉再取验证码 */
  const cleanLogs = logs.join(String.fromCharCode(10)).replace(/\u001b\[[0-9;]*m/g, '')
  const matched = cleanLogs.match(/设置主人验证码\s+([0-9A-Z]+)/)
  check('设置主人：验证码已打印到日志', Boolean(matched), matched ? `验证码 ${matched[1]}` : '未捕获到验证码')

  if (matched) {
    clear()
    emit({ type: 'message', group_id: '888777666', user_id: '99998', msg: matched[1] })
    await sleep(700)
    const cfgText = fs.readFileSync('test/.tmp-config/other.yaml', 'utf8')
    check(
      '设置主人：正确验证码 → 完成并写入配置',
      json().includes('设置主人完成') && cfgText.includes('99998'),
      json().slice(0, 60),
    )
  }
}

/* ---------- 4a3. 新增/删除主人（@ 或 QQ 号） ---------- */
{
  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#新增主人 23456789' })
  await sleep(500)
  let cfgText = fs.readFileSync('test/.tmp-config/other.yaml', 'utf8')
  check(
    '#新增主人（写 QQ 号）',
    json().includes('[23456789] 已被设置为主人') && cfgText.includes('23456789'),
    json().slice(0, 60),
  )

  clear()
  emit({
    type: 'message',
    group_id: '888777666',
    user_id: '10001',
    msg: '#新增主人',
    message: [{ type: 'at', qq: '34567890' }, { type: 'text', text: ' #新增主人' }],
  })
  await sleep(500)
  cfgText = fs.readFileSync('test/.tmp-config/other.yaml', 'utf8')
  check('#新增主人（@ 用户）', json().includes('[34567890] 已被设置为主人') && cfgText.includes('34567890'), json().slice(0, 60))

  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#设置主人 45678901' })
  await sleep(500)
  cfgText = fs.readFileSync('test/.tmp-config/other.yaml', 'utf8')
  check(
    '#设置主人（带 QQ 号，与新增同一规则）',
    json().includes('[45678901] 已被设置为主人') && cfgText.includes('45678901'),
    json().slice(0, 60),
  )

  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#删除主人 23456789' })
  await sleep(500)
  cfgText = fs.readFileSync('test/.tmp-config/other.yaml', 'utf8')
  check('#删除主人', json().includes('[23456789] 已被移除主人') && !cfgText.includes('23456789'), json().slice(0, 60))

  /** 不带目标：主人提示已是主人，非主人回到验证码流程（与 #设置主人 一致） */
  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#新增主人' })
  await sleep(400)
  check('#新增主人（主人、不带目标）→ 已是主人', json().includes('已经为主人'), json().slice(0, 40))

  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '99996', msg: '#新增主人' })
  await sleep(400)
  check('#新增主人（非主人）→ 走验证码流程', json().includes('请输入验证码'), json().slice(0, 40))

  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '99999', msg: '#删除主人 10001' })
  await sleep(400)
  check('#删除主人（非主人发起）被拒绝', !json().includes('已被移除主人'), json().slice(0, 60))

  /** 还原测试用主人配置 */
  fs.writeFileSync(
    'test/.tmp-config/other.yaml',
    ['master:', '  - "mock:10001"', ''].join(String.fromCharCode(10)),
  )
}

/* ---------- 4b. 旧插件上下文会话（主动复读.js） ---------- */
if (legacy) {
  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#复读' })
  await sleep(300)
  const asked = json().includes('请发送要复读的内容')
  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '复读这段内容' })
  await sleep(300)
  check('旧插件 setContext / finish（主动复读）', asked && json().includes('复读这段内容'), json().slice(0, 80))
} else skip('旧插件 setContext / finish（主动复读）')

/* ---------- 5. 词条（上下文会话 + 关键词触发） ---------- */
clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#添加 冒烟词条' })
await sleep(300)
check('内置 #添加（进入上下文）', json().includes('请发送添加内容'))

clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '这是词条内容' })
await sleep(200)
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#结束添加' })
await sleep(300)
check('内置词条添加完成', json().includes('添加成功：冒烟词条'))

clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '冒烟词条' })
await sleep(300)
check('词条关键词触发', json().includes('这是词条内容'))

clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#删除 冒烟词条' })
await sleep(300)
check('内置 #删除', json().includes('删除成功：冒烟词条'))

/* ---------- 6. #撤回（master） ---------- */
globalThis.__jiuli_mock_recall.length = 0
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#撤回' })
await sleep(300)
check('内置 #撤回', globalThis.__jiuli_mock_recall.length > 0, `${globalThis.__jiuli_mock_recall.length} 条撤回`)

/* ---------- 7. 原生 DSL 插件 ---------- */
clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#玖璃你好' })
await sleep(300)
check('JiuLi 原生 DSL 插件（正则捕获）', json().includes('原生 DSL'))
check('DSL 正则捕获组', json().includes('玖璃'))

/* ---------- 8. 原生类插件 ---------- */
clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#例子你好' })
await sleep(300)
check('JiuLi 原生类插件', json().includes('原生类形态'))

/* ---------- 9. 权限校验（非主人） ---------- */
clear()
emit({ type: 'message', group_id: '888777666', user_id: '99999', msg: '#玖璃性能' })
await sleep(300)
check('权限校验（非主人被拒绝）', json().includes('只有主人才可以使用'))

/* ---------- 10. 定时任务注册 ---------- */
check('定时任务注册', loader.task.length >= 2, `${loader.task.length} 个任务`)

/* ---------- 11. 计数批量写回 Redis ---------- */
await sleep(1400)
const redis = globalThis.redis
const GID = '999888777'
clear()
emit({ type: 'message', group_id: GID, user_id: '10001', msg: '喵一个' })
await sleep(1600)
let countKeys = []
try {
  countKeys = await redis.keys(`Yz:count:*:group:${GID}:total`)
} catch {}
check('消息计数批量写回 Redis', countKeys.length > 0, countKeys.slice(0, 2).join(', '))

/* ---------- 12. 渲染管线（puppeteer + 本机 Chromium/Edge） ---------- */
const imgCount = () => sent.filter(i => JSON.stringify(i.msg).includes('"type":"image"')).length

clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#例子渲染' })
await sleep(20000)
check('渲染：原生 this.render（demo-class）', json().includes('"type":"image"'), json().includes('渲染失败') ? '渲染后端不可用' : '')

clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#渲染测试' })
await sleep(4000)
check('渲染：卡片模板（循环 / 渐变 / 中文排版）', imgCount() > 0)

clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#渲染列表' })
await sleep(4000)
check('渲染：表格与模板循环', imgCount() > 0)

clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#渲染图片' })
await sleep(4000)
check('渲染：本地图片资源（SVG + pluResPath）', imgCount() > 0)

clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#渲染长图' })
await sleep(12000)
check('渲染：长图自动分页（puppeteer.screenshots）', imgCount() >= 2, `${imgCount()} 张`)

clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#渲染状态' })
await sleep(600)
check('渲染：后端状态（#渲染状态）', json().includes('渲染后端'))

/* ---------- 11b. 原生钩子 beforeMessage / afterMessage ---------- */
{
  const st = globalThis.__hookState || { before: 0, after: 0 }
  st.before = 0
  st.after = 0
  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '喵一个' })
  await sleep(500)
  check('原生钩子被调用（before/after）', st.before > 0 && st.after > 0, `before=${st.before} after=${st.after}`)

  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#钩子拦截' })
  await sleep(500)
  check('beforeMessage 返回 false 可拦截分发', json() === '[]', json().slice(0, 40))
}

/* ---------- 12b. 权限与"无响应"提示 ---------- */
clear()
emit({ type: 'message', group_id: '888777666', user_id: '99999', msg: '#诊断' })
await sleep(400)
check('权限拒绝文案', json().includes('只有主人才可以使用'), json().slice(0, 60))

clear()
emit({ type: 'message', group_id: '888777666', user_id: '99999', msg: '#静默拒绝' })
await sleep(400)
check('插件静默 return false 时的无响应提示', json().includes('主人专属指令'), json().slice(0, 80))

clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#静默拒绝' })
await sleep(400)
check('主人使用时不误报提示', json().includes('主人你好') && !json().includes('主人专属指令'))

/* ---------- 13. #诊断 ---------- */
clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#诊断' })
await sleep(600)
const diag = json()
check(
  '内置 #诊断（适配器/在线账号/最近收发）',
  diag.includes('适配器') && diag.includes('在线账号') && diag.includes('最近收到'),
  diag.slice(0, 80),
)
check('内置 #诊断 显示系统命令自检（ffmpeg）', diag.includes('【系统命令】') && diag.includes('ffmpeg'))

/* ---------- 13a. Mock 适配器头像（插件渲染时会用到） ---------- */
const mockBot = bot.bots?.mock || bot['mock']
check(
  'Mock 机器人有头像（data URI）',
  typeof mockBot?.avatar === 'string' && mockBot.avatar.startsWith('data:image/'),
  `${String(mockBot?.avatar).slice(0, 30)}… · ${Math.round(String(mockBot?.avatar || '').length / 1024)}KB`,
)
check('Mock 联系人可取头像', typeof mockBot?.getAvatarUrl === 'function' && mockBot.getAvatarUrl().startsWith('data:image/'))

/* ---------- 4a3. 运行中配置文件被删 → #设置主人 自愈重建 ---------- */
{
  await sleep(1200)
  fs.rmSync('test/.tmp-config/other.yaml', { force: true }) // 模拟运行中被误删
  const logs = []
  const origLog = console.log
  console.log = (...args) => {
    logs.push(args.map(String).join(' '))
    origLog(...args)
  }
  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '99997', msg: '#设置主人' })
  await sleep(800)
  console.log = origLog

  const clean = logs.join(String.fromCharCode(10)).replace(/\[[0-9;]*m/g, '')
  const m = clean.match(/设置主人验证码\s+([0-9A-Z]+)/)
  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '99997', msg: m ? m[1] : '000000' })
  await sleep(700)
  check(
    '配置文件被删后 #设置主人 自愈重建',
    json().includes('设置主人完成') && fs.existsSync('test/.tmp-config/other.yaml'),
    json().slice(0, 60),
  )
  /** 还原测试用主人配置（放在最后执行，避免影响其它用例） */
  fs.writeFileSync(
    'test/.tmp-config/other.yaml',
    ['master:', '  - "mock:10001"', ''].join(String.fromCharCode(10)),
  )
}

/* ---------- 汇总 ---------- */
const pass = results.filter(r => r.ok).length
console.log(`\n=== 冒烟测试：${pass}/${results.length} 通过${skipped.length ? `，${skipped.length} 项跳过` : ''} ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)
/** 清理临时夹具目录 */
try {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true })
} catch {}
try { fs.rmSync('test/.tmp-config', { recursive: true, force: true }) } catch {}
try { fs.rmSync(PLUGINS_DIR, { recursive: true, force: true }) } catch {}
process.exit(pass === results.length ? 0 : 1)
