/**
 * 逍遥插件 #更新抽卡记录 在 JiuLi 上的两个问题（复现 + 修复验证）
 *
 *   1. plugins/system/update.js 的规则 `^#(安?静)?(强制)?更新\s*(.*)$` 会命中 `#更新抽卡记录`，
 *      修复前它会自己回一句"plugins/ 下没有「抽卡记录」"（截胡插件指令）。
 *      现在只把提示挂在 e.__pluginHint 上，等所有插件都不接手时由框架补发。
 *   2. 逍遥插件只认云崽 v3 的 `data/MysCookie/<qq>.yaml`（JiuLi 的 ck 在 data/db/data.db），
 *      读不到就没有 uid → 报 `uid:undefined,authkey获取失败：登录状态失效，请重新登录`。
 *      框架侧改成：分发前初始化 `e.user`/`e.runtime.user`（对齐云崽 `await Runtime.init(e)`），
 *      逍遥自带的兜底分支就能从 DB 拿到 uid / ck；剩下的 stoken 需要逍遥自己绑定（插件文档要求）。
 *
 * 属于诊断脚本，不在 pnpm test:all 里；需要 plugins/xiaoyao-cvs-plugin 存在。
 * 用法：node test/xiaoyao-priority.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.JIULI_CONFIG_DIR = 'test/.tmp-xy-cfg/'
const PLUGINS_DIR = '.tmp-plugins-xy'
process.env.JIULI_PLUGINS_DIR = PLUGINS_DIR

for (const d of ['test/.tmp-xy-cfg', PLUGINS_DIR, 'test/.tmp-xy-logs'])
  fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync('test/.tmp-xy-cfg', { recursive: true })

const FAKE_QQ = '999000111'
const FAKE_LTUID = '999000222'
const FAKE_UID = '100000000'
const XIAOYAO_YAML = path.join('plugins', 'xiaoyao-cvs-plugin', 'data', 'yaml', `${FAKE_QQ}.yaml`)

if (!fs.existsSync(path.join('plugins', 'xiaoyao-cvs-plugin', 'index.js'))) {
  console.log('缺少 plugins/xiaoyao-cvs-plugin，先 clone：')
  console.log('  git clone https://github.com/Ctrlcvs/xiaoyao-cvs-plugin.git ./plugins/xiaoyao-cvs-plugin/')
  process.exit(1)
}

const copyTree = (from, to) => {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') continue
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dest)
    else fs.copyFileSync(src, dest)
  }
}
for (const dir of ['system', 'adapter'])
  if (fs.existsSync(path.join('plugins', dir))) copyTree(path.join('plugins', dir), path.join(PLUGINS_DIR, dir))
copyTree(path.join('plugins', 'xiaoyao-cvs-plugin'), path.join(PLUGINS_DIR, 'xiaoyao-cvs-plugin'))
fs.mkdirSync(path.join(PLUGINS_DIR, 'node_modules'), { recursive: true })
try {
  fs.symlinkSync(path.resolve('.'), path.join(PLUGINS_DIR, 'node_modules', 'jiuli'), 'junction')
} catch {}

fs.writeFileSync('test/.tmp-xy-cfg/bot.yaml', 'log_level: info\nplugin_load_timeout: 60\nfile_watch: false\n')
fs.writeFileSync('test/.tmp-xy-cfg/other.yaml', 'master:\n  - "mock:10001"\n  - "mock:999000111"\n')
fs.writeFileSync('test/.tmp-xy-cfg/group.yaml', 'default:\n  groupCD: 0\n  singleCD: 0\n  onlyReplyAt: 0\n')
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

/** 拦掉真实 git/pnpm：本脚本只关心谁抢到了指令 */
const execCalls = []
Bot.exec = async (cmd, opts = {}) => {
  execCalls.push({ cmd, cwd: opts.cwd })
  return { stdout: 'Already up to date.\n', stderr: '', error: null }
}

const loader = (await import('../lib/core/loader.js')).default
await loader.load()
const { listenerLoader } = await import('../lib/core/events.js')
await listenerLoader.loadEvent('message.js')
const mock = (bot.adapter || []).find(a => a.name === 'Mock')
await mock.load()
const emit = globalThis.__jiuli_mock_emit
const sent = () =>
  (globalThis.__jiuli_mock_sent || []).map(i => (typeof i.msg === 'string' ? i.msg : JSON.stringify(i.msg)))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const reset = () => ((globalThis.__jiuli_mock_sent || []).length = 0)
const logDir = 'test/.tmp-xy-logs'
setLogDir(logDir)

const send = async (msg, user_id = '10001', wait = 8000) => {
  reset()
  emit({ type: 'message', group_id: 'mock:88001', user_id, msg })
  await sleep(wait)
  const day = new Date().toISOString().slice(0, 10)
  const file = path.join(logDir, `command.${day}.log`)
  const hit = fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(l => /中 ▶/.test(l))
        .slice(-3)
        .map(l => l.replace(/\u001b\[[0-9;]*m/g, '').replace(/^\d\d:\d\d:\d\d INFO\s+\[  Plugin \] /, ''))
    : []
  return { replies: sent(), hit }
}

console.log('======== 1. #更新xxx 前缀的插件指令不再被本体截胡 ========')
let r = await send('#更新抽卡记录')
console.log('  命中链路：')
for (const h of r.hit) console.log('    ·', h.slice(0, 150))
console.log('  回复：')
for (const m of r.replies) console.log('    ▶', String(m).slice(0, 200).replace(/\n/g, ' | '))
console.log('  被拦下的 git 命令：', JSON.stringify(execCalls))
console.log(
  '  → 期望：本体更新插件返回 false 让位（不再回"没有这个插件"），只剩逍遥自己的回复',
)

console.log('\n======== 2. 没插件接手时，本体提示仍然要出现（只是延后） ========')
r = await send('#更新不存在的插件', '10001', 2000)
console.log('  回复：')
for (const m of r.replies) console.log('    ▶', String(m).slice(0, 200).replace(/\n/g, ' | '))
console.log('  → 期望：出现「plugins/ 下没有「不存在的插件」」（框架在所有插件都没接手后补发）')

console.log('\n======== 3. 只有 DB 里的 ck（没有 data/MysCookie 文件）时还能不能拿到 uid ========')
console.log('  data/MysCookie 存在?', fs.existsSync(path.join('data', 'MysCookie')), '（JiuLi 的 ck 在 data/db/data.db）')
const gsPath = p => pathToFileURL(path.resolve('plugins/genshin', p)).href
const { default: MysUser } = await import(gsPath('model/mys/MysUser.js'))
const { default: NoteUser } = await import(gsPath('model/mys/NoteUser.js'))
const { MysUserDB, UserDB } = await import(gsPath('model/db/index.js'))
const { default: gsCfg } = await import(
  pathToFileURL(path.resolve(PLUGINS_DIR, 'xiaoyao-cvs-plugin/model/gsCfg.js')).href
)

/** 造一个"已经绑定过 ck"的用户，模拟服务器上 DB 里已有的 ck */
const mys = await MysUser.create(FAKE_LTUID)
const FAKE_CK = `ltoken=fake_ltoken;ltuid=${FAKE_LTUID};cookie_token=fake_cookie_token;account_id=${FAKE_LTUID};`
mys.setCkData({ ck: FAKE_CK, uids: { gs: [FAKE_UID] }, device: 'fake-device', type: 'mys' })
await mys.save()
const noteUser = await NoteUser.create(FAKE_QQ)
await noteUser.addMysUser(mys)
noteUser.setMainUid(FAKE_UID, 'gs', false)
await noteUser.save()
console.log('  逍遥的 getBingCookie =', JSON.stringify(await gsCfg.getBingCookie(FAKE_QQ)), '（文件路径读不到，符合预期）')

r = await send('#更新抽卡记录', FAKE_QQ)
console.log('  回复：')
for (const m of r.replies) console.log('    ▶', String(m).slice(0, 200).replace(/\n/g, ' | '))
console.log('  → 期望：uid 变成真实的 ' + FAKE_UID + '（走 e.user 兜底），不再 undefined')

console.log('\n======== 4. 逍遥侧绑定 stoken 后，authkey 请求就能带上 cookie ========')
const { default: MihoyoApi } = await import(
  pathToFileURL(path.resolve(PLUGINS_DIR, 'xiaoyao-cvs-plugin/model/mys/mihoyoApi.js')).href
)
const probe = { user_id: FAKE_QQ, uid: FAKE_UID, region: 'cn_gf01', cookie: FAKE_CK }
console.log('  未绑定 stoken：mihoyoApi.cookies =', new MihoyoApi({ ...probe }).cookies)
fs.mkdirSync(path.dirname(XIAOYAO_YAML), { recursive: true })
fs.writeFileSync(
  XIAOYAO_YAML,
  [
    `'${FAKE_UID}':`,
    `  stuid: '${FAKE_LTUID}'`,
    "  stoken: 'fake_stoken'",
    "  ltoken: 'fake_ltoken'",
    `  uid: '${FAKE_UID}'`,
    `  userId: '${FAKE_QQ}'`,
    '  is_sign: true',
    '',
  ].join('\n'),
)
console.log('  绑定 stoken 后：mihoyoApi.cookies =', new MihoyoApi({ ...probe }).cookies)
console.log('  → 期望：绑定后有值（真实 stoken 时 genAuthKey 就能换到 authkey，与 TRSS 一致）')

console.log('\n======== 5. 非主人账号发也不会被「没有权限哦」拦住 ========')
r = await send('#更新抽卡记录', '10002', 3000)
console.log('  回复：')
for (const m of r.replies) console.log('    ▶', String(m).slice(0, 200).replace(/\n/g, ' | '))
console.log(
  '  → 期望：没有"没有权限哦"，逍遥照常接手（本体规则不再带 permission，靠 update() 内部让位）',
)

console.log('\n======== 6. 云崽 ck 兼容层：粘贴 ck 时捕获 login_ticket 并导出文件 ========')
const COMPAT_STORE = path.join('data', 'plugins', 'system', 'mys-ck.json')
const COMPAT_FILE = path.join('data', 'MysCookie', `${FAKE_QQ}.yaml`)
const FAKE_TICKET = 'fake_login_ticket_from_cookie'
fs.rmSync(path.join('data', 'MysCookie'), { recursive: true, force: true })
fs.rmSync(COMPAT_STORE, { force: true })
r = await send(
  `ltoken=abc;ltuid=${FAKE_LTUID};cookie_token=def;account_id=${FAKE_LTUID};login_ticket=${FAKE_TICKET};`,
  FAKE_QQ,
  3000,
)
console.log('  导出文件存在?', fs.existsSync(COMPAT_FILE))
if (fs.existsSync(COMPAT_FILE))
  for (const line of fs.readFileSync(COMPAT_FILE, 'utf8').trim().split('\n'))
    console.log('    ' + line)
console.log('  逍遥读到 =', JSON.stringify(await gsCfg.getBingCookie(FAKE_QQ)))
console.log('  → 期望：文件里有真实 uid/ck 与捕获到的 login_ticket，逍遥 getBingCookie 能直接拿到')

console.log('\n======== 7. 文件被删后按需重建 + #同步ck ========')
fs.rmSync(COMPAT_FILE, { force: true })
r = await send('#我的ck', FAKE_QQ, 1500)
console.log('  再发任意消息后文件恢复?', fs.existsSync(COMPAT_FILE))
r = await send('#同步ck', FAKE_QQ, 2000)
console.log('  #同步ck 回复：', r.replies.join(' | ') || '（无）')

console.log('\n======== 8. ck 删除后清理导出文件（不会复活） ========')
const mysDb2 = await MysUserDB.find(FAKE_LTUID)
if (mysDb2) await mysDb2.destroy()
/** 清掉进程内实例缓存，否则 NoteUser 还拿着已删除的 mysUsers */
noteUser._delCache?.()
mys._delCache?.()
r = await send('#同步ck', FAKE_QQ, 2000)
console.log('  #同步ck 回复：', r.replies.join(' | ') || '（无）')
console.log('  导出文件已清理?', !fs.existsSync(COMPAT_FILE))

console.log('\n======== 9. 下次启动 genshin 迁移导入我们的文件，不能污染 DB ========')
const { default: GsUser } = await import(gsPath('model/user.js'))
/** 重新造回假 ck 并导出文件 */
const mys2 = await MysUser.create(FAKE_LTUID)
mys2.setCkData({ ck: FAKE_CK, uids: { gs: [FAKE_UID] }, device: 'fake-device', type: 'mys' })
await mys2.save()
const noteUser2 = await NoteUser.create(FAKE_QQ)
await noteUser2.addMysUser(mys2)
noteUser2.setMainUid(FAKE_UID, 'gs', false)
await noteUser2.save()
r = await send('#同步ck', FAKE_QQ, 2000)
const beforeRows = (await MysUserDB.findAll()).length
const before = await MysUserDB.find(FAKE_LTUID)
console.log('  迁移前：ck 一致?', before?.ck === FAKE_CK, '· uids =', JSON.stringify(before?.uids))
console.log('  迁移前：MysUsers 行数 =', beforeRows)
await new GsUser().loadOldDataV3()
const afterRows = (await MysUserDB.findAll()).length
const after = await MysUserDB.find(FAKE_LTUID)
console.log('  迁移后：ck 一致?', after?.ck === FAKE_CK, '· uids =', JSON.stringify(after?.uids))
console.log('  迁移后：MysUsers 行数 =', afterRows, '（应与迁移前一致，没有多出 undefined 之类的垃圾行）')
console.log('  文件被迁移消费?', !fs.existsSync(COMPAT_FILE), '（genshin 是"导入即删"，插件会在 online/下条消息重建）')

/** 清理：假数据不留在仓库/DB 里 */
fs.rmSync(XIAOYAO_YAML, { force: true })
fs.rmSync(COMPAT_FILE, { force: true })
fs.rmSync(COMPAT_STORE, { force: true })
fs.rmSync(path.join('data', 'MysCookie'), { recursive: true, force: true })
const mysDb = await MysUserDB.find(FAKE_LTUID)
if (mysDb) await mysDb.destroy()
const userDb = await UserDB.find(FAKE_QQ, 'qq')
if (userDb) await userDb.destroy()
process.exit(0)
