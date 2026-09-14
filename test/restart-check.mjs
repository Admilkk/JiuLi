/**
 * 重启契约验证
 *
 * `#重启` 的行为：刷新统计 → 关闭 HTTP 服务 → 以退出码 255 退出
 * （守护进程收到 255 后会在同一终端重新拉起，不开新窗口）
 *
 * 用法：node test/restart-check.mjs（期望脚本自身以 255 结束）
 */
import fs from 'node:fs'

/** 测试用隔离配置目录：绝不碰真实的 config/config */
process.env.JIULI_CONFIG_DIR = 'test/.tmp-config/'


fs.mkdirSync('test/.tmp-config', { recursive: true })
fs.writeFileSync('test/.tmp-config/bot.yaml', 'log_level: info\nplugin_load_timeout: 60\nfile_watch: false\n')
fs.writeFileSync('test/.tmp-config/other.yaml', 'master:\n  - "mock:10001"\n')
fs.writeFileSync('test/.tmp-config/server.yaml', 'url: http://localhost:25380\nport: 25380\nredirect: https://x\nauth:\n')
fs.writeFileSync('test/.tmp-config/group.yaml', 'default:\n  groupCD: 0\n  singleCD: 0\n  onlyReplyAt: 0\n')

const { start, RESTART_CODE } = await import('../lib/core/start.js')
const bot = await start()
if (bot.stat.online !== 2) await new Promise(r => bot.once('online', r))
console.log(`[重启验证] 进程已上线 · pid ${process.pid} · ${bot.url}`)

let serverClosed = false
const origClose = bot.server.close.bind(bot.server)
bot.server.close = (...args) => {
  serverClosed = true
  return origClose(...args)
}

process.on('exit', code => {
  const ok = code === RESTART_CODE && serverClosed
  console.log(
    `[重启验证] 退出码 ${code}（期望 ${RESTART_CODE}）· 服务已关闭 ${serverClosed} → ${ok ? '✅ 契约正确' : '❌ 契约不符'}`,
  )
  process.exitCode = ok ? 0 : 1
  /** process.exit 已在栈上，这里用同步写文件保证结果可见 */
  fs.writeFileSync('test/.restart-result', ok ? 'ok' : `bad:${code}:${serverClosed}`)
})

console.log('[重启验证] 触发 #重启 …')
setTimeout(() => bot.restart(), 500)
