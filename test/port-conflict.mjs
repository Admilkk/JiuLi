/**
 * 端口被占用时只结束自己
 *
 * 回归的是 Gitee #IKJVCD：过去 serverEADDRINUSE 会给占用方发 `POST /exit` 请它退出，
 * 而对端在 pm2 模式下执行的是 `pnpm stop` → `pm2 delete JiuLi` + `pm2 save`，
 * 于是生产条目被删掉（且跨重启持久化）。现在端口冲突只报错退出，不再碰对端。
 *
 * 属于回归用例，随 pnpm test:all 一起跑；也可单独执行：node test/port-conflict.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

process.env.JIULI_CONFIG_DIR = 'test/.tmp-pc-cfg/'
const PLUGINS_DIR = '.tmp-plugins-port-conflict'
process.env.JIULI_PLUGINS_DIR = PLUGINS_DIR

for (const d of ['test/.tmp-pc-cfg', PLUGINS_DIR]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync('test/.tmp-pc-cfg', { recursive: true })
fs.mkdirSync(path.join(PLUGINS_DIR, 'node_modules'), { recursive: true })
try {
  fs.symlinkSync(path.resolve('.'), path.join(PLUGINS_DIR, 'node_modules', 'jiuli'), 'junction')
} catch {}

fs.writeFileSync('test/.tmp-pc-cfg/bot.yaml', 'log_level: info\nplugin_load_timeout: 30\nfile_watch: false\n')

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

/** 占住一个端口，并记录是否有 /exit 请求打进来 */
const exits = []
const holder = http.createServer((req, res) => {
  exits.push(req.url)
  res.end('holder')
})
await new Promise(r => holder.listen(0, '127.0.0.1', r))
const port = holder.address().port

const { default: cfg } = await import('../lib/core/config/index.js')
cfg.server.port = port

const { default: JiuLiBot } = await import('../lib/core/bot.js')
const bot = new JiuLiBot()

const logs = []
const origLog = console.log
const origErr = console.error
const origExit = process.exit
const capture = orig => (...a) => {
  logs.push(a.map(String).join(' ').replace(/\u001b\[[0-9;]*m/g, ''))
  orig(...a)
}
console.log = capture(origLog)
console.error = capture(origErr)

/** 截停 process.exit，避免测试进程被真退出；同时记录退出码 */
const EXIT = Symbol('exit')
let exitCode
process.exit = code => {
  exitCode = code
  throw EXIT
}

const err = Object.assign(new Error(`listen EADDRINUSE: address already in use 127.0.0.1:${port}`), { code: 'EADDRINUSE' })
try {
  await bot.serverEADDRINUSE(err)
} catch (e) {
  if (e !== EXIT) throw e
}
process.exit = origExit
console.log = origLog
console.error = origErr
await new Promise(r => setTimeout(r, 300))

const { RESTART_CODE } = await import('../lib/core/start.js')

check('端口冲突时本实例以重启码退出（守护进程可自动重拉）', exitCode === RESTART_CODE, `exitCode=${exitCode}（期望 ${RESTART_CODE}）`)
check(
  '不再请求占用方退出（没发 /exit）',
  exits.length === 0,
  exits.length ? `收到 ${exits.join(' · ')}` : '（对端 0 个请求）',
)
check(
  '提示端口被占用与处理方式',
  logs.some(l => l.includes(String(port)) && l.includes('已被占用')),
  logs.find(l => l.includes('已被占用'))?.slice(0, 110) || '（无提示）',
)
let exitCalled = 0
bot.exit = () => {
  exitCalled++
}

check(
  '没走实例 exit（pm2 模式下会连带 pm2 delete）',
  exitCalled === 0,
  exitCalled ? `bot.exit 被调用 ${exitCalled} 次` : '（未调用）',
)

holder.close()

const pass = results.filter(r => r.ok).length
console.log(`\n=== 端口冲突处理测试：${pass}/${results.length} 通过 ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)
process.exit(pass === results.length ? 0 : 1)
