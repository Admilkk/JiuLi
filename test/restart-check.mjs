/**
 * 重启契约验证
 *
 * `#重启` 的行为：刷新统计 → 关闭 HTTP 服务 → 以退出码 255 退出
 * （守护进程收到 255 后会在同一终端重新拉起，不开新窗口）
 *
 * 用法：node test/restart-check.mjs（期望脚本自身以 255 结束）
 */
import fs from 'node:fs'
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
