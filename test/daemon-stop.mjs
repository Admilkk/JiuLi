/**
 * 守护进程「收到终止信号」验证
 *
 * 场景：SSH 断开时终端会发 SIGHUP。期望守护进程结束子进程后自行退出，
 * 不留孤儿进程（否则端口被占、却没人管）。
 *
 * Windows 无法真的投递 SIGHUP，这里用 process.emit 触发同一套处理逻辑
 * （信号投递本身是平台行为，处理逻辑才是这里要保证的）。
 *
 * 用法：node test/daemon-stop.mjs
 */
import fs from 'node:fs'

/** 隔离配置目录：绝不碰真实 config/config */
process.env.JIULI_CONFIG_DIR = 'test/.tmp-config/'

const CHILD = 'test/.tmp-daemon-child.mjs'
const LOG = 'test/.tmp-daemon.log'
const PID = 'test/.tmp-daemon.pid'
const RESULT = 'test/.tmp-daemon-result'

for (const f of [LOG, PID, RESULT]) fs.rmSync(f, { force: true })

/** 常驻子进程：起来后写 pid，然后等守护进程来结束它 */
fs.writeFileSync(
  CHILD,
  `import fs from 'node:fs'
fs.appendFileSync('${LOG}', 'gen\\n')
fs.writeFileSync('${PID}', String(process.pid))
setInterval(() => {}, 1000)
`,
)

process.argv[1] = CHILD
const { supervise } = await import('../lib/core/start.js')

/** 断言放在 supervise() 之前注册：它内部会 process.exit，之后的行不会执行 */
let childPid = 0
process.on('exit', () => {
  const gens = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').length : 0
  let alive = true
  try {
    process.kill(childPid, 0)
  } catch {
    alive = false
  }
  const ok = childPid > 0 && gens === 1 && !alive
  console.log(
    `[守护停止验证] 启动代次 ${gens}（期望 1）· 子进程仍存活 ${alive}（期望 false）→ ${ok ? '✅ 已随信号退出且无孤儿' : '❌ 未按预期退出'}`,
  )
  fs.writeFileSync(RESULT, ok ? 'ok' : `bad:${gens}:${alive}`)
  for (const f of [CHILD, LOG, PID]) {
    try {
      fs.rmSync(f, { force: true })
    } catch {}
  }
})

/** 先拉起守护进程（它才会 spawn 子进程），再等子进程写出的 pid */
const supervising = supervise()

for (let i = 0; i < 100; i++) {
  if (fs.existsSync(PID)) {
    childPid = Number(fs.readFileSync(PID, 'utf8'))
    break
  }
  await new Promise(r => setTimeout(r, 100))
}
console.log(`[守护停止验证] 子进程 pid ${childPid}`)

/** 模拟终端关闭（SSH 断开）发出的信号 */
process.emit('SIGHUP')
await supervising
