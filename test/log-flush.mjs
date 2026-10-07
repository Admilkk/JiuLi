/**
 * 退出前日志必须落盘
 *
 * process.exit 不会等 fs.WriteStream 的异步写：端口冲突这类「打一行就退出」的场景里，
 * 丢掉的恰好是死因那一行，而 `#日志` / `#错误日志` 正是读文件。
 * flushLog() 把还没落盘的行同步补齐，并把该文件切到同步追加（不混写，避免重复）。
 *
 * 属于回归用例，随 pnpm test:all 一起跑；也可单独执行：node test/log-flush.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const DIR = 'test/.tmp-logflush-logs'
fs.rmSync(DIR, { recursive: true, force: true })

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

const { writeLog, flushLog, setLogDir } = await import('../lib/core/log.js')
setLogDir(DIR)

const day = new Date()
const pad = n => String(n).padStart(2, '0')
const stamp = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
const mainLog = path.join(DIR, `jiuli.${stamp}.log`)
const errLog = path.join(DIR, 'error.log')

const read = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')

/* 先制造出「流已打开且写过一批」的状态 */
const origLog = console.log
const origErr = console.error
console.log = () => {}
console.error = () => {}
for (let i = 1; i <= 50; i++) writeLog('info', 'Probe', [`启动填充行 ${i}`])
writeLog('error', 'Server', ['监听端口 1721 错误 EADDRINUSE'])
writeLog('error', 'Server', ['端口 1721 已被占用，本次启动退出'])
flushLog()
console.log = origLog
console.error = origErr

const main = read(mainLog)
const err = read(errLog)

check('flush 后主日志里有最后一行', main.includes('端口 1721 已被占用，本次启动退出'), main.split('\n').length - 1 + ' 行')
check('flush 后 error.log 里有最后一行', err.includes('端口 1721 已被占用，本次启动退出'))
check('前面的行没被丢', main.includes('启动填充行 50'))

/** 同一行只应出现一次：混用流写 + 同步补写最容易在这里翻倍 */
const dup = main.split('\n').filter(l => l.includes('端口 1721 已被占用')).length
check('同一行不重复写（不混写）', dup === 1, `出现 ${dup} 次`)

/* flush 之后继续写，也必须落盘且顺序正确 */
console.log = () => {}
console.error = () => {}
writeLog('error', 'Server', ['flush 之后的行也要落盘'])
flushLog()
console.log = origLog
console.error = origErr

const after = read(mainLog)
check('flush 之后追加的行同样落盘', after.includes('flush 之后的行也要落盘'))
const idxFirst = after.indexOf('端口 1721 已被占用')
const idxAfter = after.indexOf('flush 之后的行也要落盘')
check('追加行在最后一行之后（顺序不乱）', idxFirst > -1 && idxAfter > idxFirst, `位置 ${idxFirst} → ${idxAfter}`)

/* 不丢行：51 行 info + 2 行 error 各写进主日志 */
const infoCount = read(mainLog).split('\n').filter(l => l.includes('启动填充行')).length
check('填充行一行不丢', infoCount === 50, `实际 ${infoCount}`)

const pass = results.filter(r => r.ok).length
console.log(`\n=== 日志落盘测试：${pass}/${results.length} 通过 ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)
process.exit(pass === results.length ? 0 : 1)
