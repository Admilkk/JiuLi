/**
 * JiuLi 冒烟测试
 *
 * 覆盖：旧插件（rule / accept / 权限 / 转发消息）、原生 DSL / 类形态插件、
 *       定时任务注册、消息计数批量写回、渲染管线（puppeteer 失败可容忍）
 *
 * 用法：node test/smoke.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 旧插件夹具：从 test/fixtures/ 复制到 plugins/_test-fixtures/（临时目录，测试结束删除）
 * 复制是必须的 —— 旧插件用相对路径 import 框架（../../lib/...），只有放在 plugins/<目录>/ 下才成立
 */
const FIXTURE_DIR = 'plugins/_test-fixtures'
fs.rmSync(FIXTURE_DIR, { recursive: true, force: true })
fs.mkdirSync(FIXTURE_DIR, { recursive: true })
let fixtureCount = 0
for (const file of fs.readdirSync('test/fixtures')) {
  if (!file.endsWith('.js')) continue
  fs.copyFileSync(path.join('test/fixtures', file), path.join(FIXTURE_DIR, file))
  fixtureCount++
}

/** 测试配置（config/config 为运行时目录，已 gitignore） */
fs.mkdirSync('config/config', { recursive: true })
fs.writeFileSync(
  'config/config/other.yaml',
  ['master:', '  - "mock:10001"', 'masterQQ:', '  - "10001"', 'autoFriend: 1', 'autoGroup: 0', 'autoQuit: 0'].join('\n'),
)
fs.writeFileSync(
  'config/config/server.yaml',
  ['url: http://localhost:25360', 'port: 25360', 'redirect: https://gitee.com/fox-glaze/jiuli', 'auth:'].join('\n'),
)
fs.writeFileSync(
  'config/config/group.yaml',
  ['default:', '  groupCD: 0', '  singleCD: 0', '  onlyReplyAt: 0', '  botAlias:', '    - 玖璃'].join('\n'),
)

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
  await sleep(600)
  check(
    '内置 #状态（master + makeForwardArray）',
    json().includes('JiuLi v') && json().includes('运行时间') && json().includes('插件加载用时'),
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
await sleep(300)
check('内置 #版本', json().includes('AGPL-3.0'))

clear()
emit({ type: 'message', group_id: '888777666', user_id: '99999', msg: '#设置主人' })
await sleep(300)
check('内置 #设置主人（非主人获取验证码）', json().includes('请输入验证码'))

clear()
emit({ type: 'message', group_id: '888777666', user_id: '99999', msg: '000000' })
await sleep(300)
check('内置 #设置主人（错误验证码 + 上下文结束）', json().includes('验证码错误'))

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
check('权限校验（非主人被拒绝）', json().includes('暂无权限'))

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
check('渲染：原生 this.render（example-class）', json().includes('"type":"image"'), json().includes('渲染失败') ? '渲染后端不可用' : '')

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

/* ---------- 汇总 ---------- */
const pass = results.filter(r => r.ok).length
console.log(`\n=== 冒烟测试：${pass}/${results.length} 通过${skipped.length ? `，${skipped.length} 项跳过` : ''} ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)
/** 清理临时夹具目录 */
try {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true })
} catch {}
process.exit(pass === results.length ? 0 : 1)
