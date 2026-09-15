/**
 * 更新插件验证（在临时目录里建真的 git 仓库，不碰真实仓库）
 *
 * 用法：node test/update-check.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const TMP = path.join(os.tmpdir(), `jiuli-upd-${Date.now()}`)
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' })
    .toString()
    .trim()

/** 造一个「上游 → 克隆」的仓库对 */
const makeRepo = name => {
  const bare = path.join(TMP, `${name}.git`)
  fs.mkdirSync(bare, { recursive: true })
  git(bare, 'init', '--bare', '-q')
  const work = path.join(TMP, `${name}-work`)
  git(TMP, 'clone', '-q', bare, work)
  fs.writeFileSync(path.join(work, 'a.txt'), '1')
  git(work, 'add', '-A')
  git(work, 'commit', '-qm', 'initial')
  git(work, 'push', '-q', 'origin', 'HEAD')

  const clone = path.join(TMP, 'plugins', name)
  git(TMP, 'clone', '-q', bare, clone)
  return { work, clone }
}

/** 上游推一个新提交，模拟「有新版本」 */
const pushUpdate = (work, msg) => {
  fs.appendFileSync(path.join(work, 'a.txt'), 'x')
  git(work, 'add', '-A')
  git(work, 'commit', '-qm', msg)
  git(work, 'push', '-q', 'origin', 'HEAD')
}

const results = []
const check = (name, ok, extra) => {
  results.push(ok)
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

/* ---- 准备：临时工作目录 + 框架运行环境 ---- */
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true })
fs.mkdirSync(path.join(TMP, 'config'), { recursive: true })
fs.cpSync(path.join(ROOT, 'config/default_config'), path.join(TMP, 'config/default_config'), {
  recursive: true,
})
const icqq = makeRepo('Yunzai-ICQQ-Plugin')
const miao = makeRepo('miao-plugin')
fs.mkdirSync(path.join(TMP, 'plugins', 'example')) // 非 git 目录，用于跳过逻辑

process.chdir(TMP)
process.env.JIULI_CONFIG_DIR = path.join(TMP, 'cfg') + path.sep
fs.mkdirSync(path.join(TMP, 'cfg'), { recursive: true })

const { default: JiuLiBot } = await import(pathToFileURL(path.join(ROOT, 'lib/core/bot.js')).href)
const { injectGlobals } = await import(pathToFileURL(path.join(ROOT, 'lib/core/globals.js')).href)
const { ensureDirs } = await import(pathToFileURL(path.join(ROOT, 'lib/core/start.js')).href)
const { redisInit } = await import(pathToFileURL(path.join(ROOT, 'lib/core/redis.js')).href)
for (const dir of ['logs', 'data', 'temp']) fs.mkdirSync(dir, { recursive: true })
await ensureDirs()
const bot = new JiuLiBot()
await injectGlobals(bot)
await redisInit()

const { default: Update } = await import(
  pathToFileURL(path.join(ROOT, 'plugins/system/update.js')).href
)

/** 测试环境不真的重启进程，只记录调用次数 */
let restartCount = 0
Update.prototype.restart = function () {
  restartCount++
}

/** 构造假事件：收集回复 */
const makeEvent = (msg, isMaster = true) => {
  const sent = []
  return {
    e: {
      isMaster,
      msg,
      self_id: '10000',
      user_id: '10001',
      reply: async m => {
        sent.push(typeof m === 'string' ? m : JSON.stringify(m).slice(0, 120))
        return { message_id: '1' }
      },
    },
    sent,
  }
}
const run = async (msg, isMaster, fnc = 'update') => {
  const { e, sent } = makeEvent(msg, isMaster)
  const up = new Update(e)
  up.e = e
  await up[fnc]()
  return { sent, up }
}

/* ---- 1. 插件名解析 ---- */
const probe = new Update()
probe.e = makeEvent('#更新ICQQ').e
check('getPlugin("ICQQ") 宽松命中 Yunzai-ICQQ-Plugin', (await probe.getPlugin('ICQQ')) === 'Yunzai-ICQQ-Plugin')
check('getPlugin("miao-plugin") 精确命中', (await probe.getPlugin('miao-plugin')) === 'miao-plugin')
check('getPlugin("MIAO") 忽略大小写', (await probe.getPlugin('MIAO')) === 'miao-plugin')

const bad = makeEvent('#更新不存在的插件')
const badUp = new Update(bad.e)
badUp.e = bad.e
check('getPlugin 未找到时返回 false 且给出提示', (await badUp.getPlugin()) === false && bad.sent[0]?.includes('没有'))

/* ---- 2. #更新ICQQ（有新提交 → 更新成功 + 日志） ---- */
pushUpdate(icqq.work, 'feat: ICQQ 新功能')
const r1 = await run('#更新ICQQ')
check('#更新ICQQ 更新成功', r1.sent.some(m => m.includes('Yunzai-ICQQ-Plugin 更新成功')), r1.sent[0])
check('#更新ICQQ 附带提交日志', r1.sent.some(m => m.includes('ICQQ 新功能')), r1.sent[1]?.slice(0, 60))
check('更新后 isUp 置位', r1.up.isUp === true)

/* ---- 3. #静更新（静默：已是最新时完全不回复） ---- */
const r2 = await run('#静更新ICQQ')
check(
  '#静更新 已是最新且完全不回复',
  r2.sent.length === 0,
  r2.sent.length ? JSON.stringify(r2.sent) : '（无回复，符合预期）',
)

/* ---- 4. 非 master ---- */
const r3 = await run('#更新ICQQ', false)
check('非主人使用 #更新 被拒绝', r3.sent.length === 0 && r3.up.isUp === false)

/* ---- 5. #强制更新 ---- */
const r4 = await run('#强制更新ICQQ')
check('#强制更新 正常执行（无冲突时等同 pull）', r4.sent.some(m => m.includes('开始强制更新')), r4.sent[0])

/* ---- 6. #更新日志 ---- */
const r5 = await run('#更新日志ICQQ', true, 'updateLog')
check('#更新日志 返回可转发内容', r5.sent.length > 0 && r5.sent.some(m => m.includes('更新日志')), r5.sent[0]?.slice(0, 70))

/* ---- 7. #全部更新（跳过非 git 目录） ---- */
pushUpdate(miao.work, 'feat: miao 新功能')
const beforeRestart = restartCount
const r7 = await run('#全部静更新', true, 'updateAll')
check('#全部更新 覆盖插件', r7.sent.some(m => m.includes('miao-plugin 更新成功')), JSON.stringify(r7.sent).slice(0, 140))
check('#全部更新 跳过非 git 目录', !JSON.stringify(r7.sent).includes('example'))
check('#全部更新 有更新后触发重启', restartCount > beforeRestart)

/* ---- 8. 生态插件依赖的类接口（TRSS 同名方法，缺一个就会报 undefined） ---- */
const eco = new Update()
const need = ['update', 'updateAll', 'updateLog', 'getPlugin', 'runUpdate', 'getLog', 'restart', 'updatePackage']
const missing = need.filter(m => typeof eco[m] !== 'function')
check(
  '生态兼容方法齐全（getPlugin/runUpdate/getLog/restart…）',
  missing.length === 0,
  missing.length ? `缺：${missing.join(', ')}` : need.join(' · '),
)
check('生态兼容字段齐全（isUp / isPkgUp / quiet / typeName）', 'isUp' in eco && 'isPkgUp' in eco && 'quiet' in eco && 'typeName' in eco)

let ecoReply = 0
const ecoUpdate = new Update()
ecoUpdate.e = { isMaster: true, msg: '#更新miao-plugin', reply: async () => ecoReply++ }
check('生态用法：new Update() 后手工设 e 可用', (await ecoUpdate.getPlugin('miao-plugin')) === 'miao-plugin' && ecoReply === 0)

/* ---- 9. 规则路由：消息能否命中对应的处理函数（#更新ICQQ 的关键） ---- */
const rules = new Update().rule.map(r => ({
  fnc: r.fnc,
  reg: typeof r.reg === 'string' ? new RegExp(r.reg) : r.reg,
}))
const route = msg => rules.find(r => r.reg.test(msg))?.fnc || 'none'
const cases = [
  ['#更新', 'update'],
  ['#更新ICQQ', 'update'],
  ['#更新 miao-plugin', 'update'],
  ['#更新Yunzai-ICQQ-Plugin', 'update'],
  ['#静更新ICQQ', 'update'],
  ['#安静更新', 'update'],
  ['#强制更新ICQQ', 'update'],
  ['#静强制更新', 'update'],
  ['#全部更新', 'updateAll'],
  ['#全部静更新', 'updateAll'],
  ['#全部强制更新', 'updateAll'],
  ['#全部安静强制更新', 'updateAll'],
  ['#更新日志', 'updateLog'],
  ['#更新日志ICQQ', 'updateLog'],
  ['#重启更新', 'update'],
]
const wrong = cases.filter(([msg, fnc]) => route(msg) !== fnc)
check(
  `规则路由正确（${cases.length} 个消息样例）`,
  wrong.length === 0,
  wrong.length ? wrong.map(([m, f]) => `${m} → ${route(m)}（应 ${f}）`).join('; ') : cases.map(c => c[0]).join(' '),
)

/** 先离开临时目录：Windows 下删不掉进程当前所在的目录 */
process.chdir(ROOT)
try {
  fs.rmSync(TMP, { recursive: true, force: true })
} catch (err) {
  console.log(`（临时目录清理失败，可手动删除：${TMP}）`)
}
const pass = results.filter(Boolean).length
console.log(`\n=== 更新插件测试：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
