/**
 * 守护进程（同终端重启）验证
 *
 * 用 supervise() 拉起一个子脚本：第一代请求重启（exit 255），第二代正常退出。
 * 期望：守护进程重新拉起一次，且不退出到 shell 之外（无新窗口）。
 *
 * 用法：node test/supervisor-check.mjs
 */
import fs from 'node:fs'

/** 测试用隔离配置目录：绝不碰真实的 config/config */
process.env.JIULI_CONFIG_DIR = 'test/.tmp-config/'


const CHILD = 'test/.tmp-supervisor-child.mjs'
const LOG = 'test/.tmp-supervisor.log'

fs.rmSync(LOG, { force: true })
fs.writeFileSync(
  CHILD,
  `import fs from 'node:fs'
const lines = fs.existsSync('${LOG}') ? fs.readFileSync('${LOG}', 'utf8').trim().split('\\n').length : 0
fs.appendFileSync('${LOG}', \`gen \${lines + 1} pid \${process.pid}\\n\`)
if (lines === 0) {
  console.log('[子进程] 第 1 代：请求重启（exit 255）')
  process.exit(255)
}
console.log('[子进程] 第 2 代：正常退出')
process.exit(0)
`,
)

/** 让 supervise() 以子脚本作为入口 */
process.argv[1] = CHILD
const { supervise } = await import('../lib/core/start.js')

/** supervise() 内部会 process.exit(0)，用事件钩子做断言 */
process.on('exit', () => {
  const lines = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n') : []
  const ok = lines.length === 2
  console.log(`[守护验证] 子进程启动次数 ${lines.length}（期望 2）→ ${ok ? '✅ 重启成功' : '❌ 未按预期重启'}`)
  for (const line of lines) console.log(`   ${line}`)
  fs.writeFileSync('test/.supervisor-result', ok ? 'ok' : `bad:${lines.length}`)
  fs.rmSync(CHILD, { force: true })
  fs.rmSync(LOG, { force: true })
})

await supervise()
