/**
 * JiuLi 冒烟测试
 *
 * 覆盖：旧插件（rule / accept / 权限 / 转发消息）、原生 DSL / 类形态插件、
 *       定时任务注册、消息计数批量写回、渲染管线（puppeteer 失败可容忍）
 *
 * 用法：node test/smoke.mjs
 */
import fs from 'node:fs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

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
/** 旧插件夹具缺失时跳过对应用例（夹具来自 TRSS-Yunzai 插件目录，不入库） */
const legacy = fs.existsSync('plugins/_legacy/喵一个.js')
const skip = name => {
  skipped.push(name)
  console.log(`⏭️  ${name} — 跳过（未找到 plugins/_legacy 夹具）`)
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

/* ---------- 3. 旧插件：master 权限 + 转发消息 + load_time ---------- */
if (legacy) {
  clear()
  emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#状态' })
  await sleep(500)
  check('旧插件 #状态（master + makeForwardArray）', json().includes('运行时间'), json().slice(0, 100))
} else skip('旧插件 #状态（master + makeForwardArray）')

/* ---------- 4. 原生 DSL 插件 ---------- */
clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#玖璃你好' })
await sleep(300)
check('JiuLi 原生 DSL 插件（正则捕获）', json().includes('原生 DSL'))
check('DSL 正则捕获组', json().includes('玖璃'))

/* ---------- 5. 原生类插件 ---------- */
clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#例子你好' })
await sleep(300)
check('JiuLi 原生类插件', json().includes('原生类形态'))

/* ---------- 6. 权限校验（非主人） ---------- */
clear()
emit({ type: 'message', group_id: '888777666', user_id: '99999', msg: '#玖璃性能' })
await sleep(300)
check('权限校验（非主人被拒绝）', json().includes('暂无权限'))

/* ---------- 7. 定时任务注册 ---------- */
check('定时任务注册', loader.task.length >= 2, `${loader.task.length} 个任务`)

/* ---------- 8. 计数批量写回 Redis ---------- */
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

/* ---------- 9. 渲染管线（puppeteer + 本机 Edge，失败可容忍） ---------- */
clear()
emit({ type: 'message', group_id: '888777666', user_id: '10001', msg: '#例子渲染' })
await sleep(15000)
check(
  '渲染管线（puppeteer）',
  json().includes('base64://') || json().includes('"type":"image"'),
  json().includes('渲染失败') ? '渲染后端不可用（已优雅降级）' : json().slice(0, 60),
)

/* ---------- 汇总 ---------- */
const pass = results.filter(r => r.ok).length
console.log(`\n=== 冒烟测试：${pass}/${results.length} 通过${skipped.length ? `，${skipped.length} 项跳过` : ''} ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)
if (skipped.length) console.log('   提示：将 TRSS-Yunzai 的部分插件复制到 plugins/_legacy/ 可运行完整兼容性用例')
process.exit(pass === results.length ? 0 : 1)
