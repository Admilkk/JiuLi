/**
 * 重复日志折叠验证
 *
 * 插件刷同一条日志时（如 QQBot 适配器的「被动回复失败」），终端只留一条 + 折叠计数，
 * 但日志文件里必须仍然是完整的 —— 排查问题时不能丢信息。
 *
 * 用法：node test/log-dedupe.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

process.env.JIULI_CONFIG_DIR = 'test/.tmp-dedupe-cfg/'
fs.rmSync('test/.tmp-dedupe-cfg', { recursive: true, force: true })
fs.mkdirSync('test/.tmp-dedupe-cfg', { recursive: true })
fs.writeFileSync('test/.tmp-dedupe-cfg/bot.yaml', 'log_level: info\nlog_dedupe: 10\n')
fs.writeFileSync('test/.tmp-dedupe-cfg/other.yaml', 'master:\n  - "mock:10001"\n')

const logDir = 'test/.tmp-dedupe-logs'
fs.rmSync(logDir, { recursive: true, force: true })

const { logger, setLogDir } = await import('../lib/core/log.js')
await import('../lib/core/config/index.js')
setLogDir(logDir)

/** 捕获终端输出 */
const out = []
const origLog = console.log
const origError = console.error
console.log = (...a) => out.push(a.join(' '))
console.error = (...a) => out.push(a.join(' '))

const LINE = '被动回复失败(code(40034128))，正在尝试通过主动消息发送'
for (let i = 0; i < 4; i++) logger.warn(LINE)
/** 换一条日志会触发上一条的折叠汇总 */
logger.warn('另一条不同的日志')
await new Promise(r => setTimeout(r, 50))

console.log = origLog
console.error = origError

const count = (text, sub) => text.split(sub).length - 1
const consoleText = out.join('\n')
/** 日志文件名是**本地**日期：不能用 toISOString()（UTC，本地 00:00-08:00 会差一天） */
const localDay = () => {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const fileText = fs.readFileSync(path.join(logDir, `jiuli.${localDay()}.log`), 'utf8')

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

check('终端里的重复日志只留一条', count(consoleText, LINE) === 1, `实际 ${count(consoleText, LINE)} 条`)
check('给出折叠汇总并带上重复次数', /重复 4 次/.test(consoleText), consoleText.match(/↑.*/)?.[0] || '（没有汇总行）')
check('不同内容不受影响', consoleText.includes('另一条不同的日志'))
check('日志文件里 4 条都在（不丢信息）', count(fileText, LINE) === 4, `文件里 ${count(fileText, LINE)} 条`)

const pass = results.filter(r => r.ok).length
console.log(`\n=== 重复日志折叠验证：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
