/**
 * 启动流程
 */
import fs from 'node:fs'
import cfg from './config/index.js'
import { logger, setLog, setLogDir } from './log.js'
import util from './util.js'
import { redisInit } from './redis.js'
import { injectGlobals } from './globals.js'

/** Promise.withResolvers polyfill（Node < 22） */
if (!(Promise as any).withResolvers) {
  const { deprecate } = await import('node:util')
  ;(Promise as any).withResolvers = deprecate(() => {
    const r: any = {}
    r.promise = new Promise((resolve, reject) => {
      r.resolve = resolve
      r.reject = reject
    })
    return r
  }, '请更新 Node.js')
}

export const DIRS = ['temp', 'temp/html', 'data', 'data/db', 'logs', 'resources']

export async function ensureDirs() {
  for (const dir of DIRS)
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      util.makeLog('warn', `创建目录 ${dir} 失败：${err}`, 'Start')
    }
}

export async function initRedisOrFallback() {
  return redisInit()
}

export async function start() {
  const g = globalThis as any
  g.start_type ||= 'internal'

  // 默认只保留 10 帧调用栈，定位不到插件报错位置
  Error.stackTraceLimit = 50
  process.env.TZ ??= 'Asia/Shanghai'
  let realVersion = '0.0.0'
  try {
    realVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
  } catch {}
  const compat = cfg.getCompat()
  const frameworkName = cfg.frameworkName
  process.title = `JiuLi v${realVersion}`
  if (frameworkName && frameworkName !== 'jiuli' && frameworkName !== 'JiuLi')
    process.title += ` (对外标识 ${frameworkName})`

  for (const i of ['SIGHUP', 'SIGTERM'] as const)
    process.on(i, (_signal: string, code: number) => process.exit(code))

  setLogDir('logs')
  await ensureDirs()
  setLog()

  const { default: JiuLiBot } = await import('./bot.js')
  const bot = new JiuLiBot() as any
  await injectGlobals(bot)

  bot.makeLog('mark', '──────── 启动中 ────────', 'JiuLi')
  bot.makeLog(
    'mark',
    `v${realVersion} · 插件可见的框架标识 ${logger.cyan(`${frameworkName} v${cfg.frameworkVersion}`)}（config/config/jiuli.yaml → compat）`,
    'JiuLi',
  )

  // id 用短名，避免被日志对齐截断
  const fatalEvents: Array<[string, string]> = [
    ['uncaughtException', 'Crash'],
    ['unhandledRejection', 'Reject'],
  ]
  for (const [event, id] of fatalEvents)
    process.on(event, (e: any) => {
      try {
        /** 未捕获错误同样只给一行原因；堆栈里有插件代码就指出来，完整堆栈留给 debug */
        const frame = util.errorFrame(e)
        const msg = `${String(e?.message || e)}${frame ? `
        疑似来自 ${frame}` : ''}`
        bot.makeLog('error', msg, id)
        bot.makeLog('debug', [event, e], id)
      } catch (err) {
        console.error(event, e, err)
        process.exit()
      }
    })

  let stack: string | undefined
  const exit = process.exit.bind(process)
  process.exit = ((code?: number) => {
    stack = Error().stack
    return exit(code as any)
  }) as any
  process.on('exit', code => {
    try {
      bot.makeLog('mark', logger.magenta(`JiuLi 已停止运行，本次运行时长：${bot.getTimeDiff()} (${code})`), 'exit')
      bot.makeLog('trace', stack || Error().stack, 'exit')
    } catch {}
  })

  await bot.run()
  return bot
}

/** 子进程请求重启时的退出码（守护进程据此重新拉起） */
export const RESTART_CODE = 255

/**
 * 守护进程：在同一终端内拉起/重启主进程
 * 主进程以退出码 255 退出时立即重新拉起；正常退出或崩溃则结束守护。
 */
export async function supervise() {
  const { spawn } = await import('node:child_process')
  setLogDir('logs')
  setLog()

  const entry = process.argv[1]
  const args = process.argv.slice(2).filter(a => a !== 'daemon')
  let stopping = false
  let child: ReturnType<typeof spawn> | undefined
  /** SIGHUP 也要处理：SSH 断开时终端会发它，否则守护进程退出、子进程变孤儿继续占端口 */
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(sig, () => {
      stopping = true
      child?.kill('SIGTERM')
    })

  let restarts = 0
  while (!stopping) {
    child = spawn(process.execPath, [entry, ...args], {
      stdio: 'inherit',
      env: { ...process.env, app_type: 'internal', JIULI_CHILD: '1' },
    })
    const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(resolve =>
      child!.on('exit', (c, s) => resolve({ code: c, signal: s })),
    )

    if (stopping) {
      logger.mark('[Daemon] 收到退出信号，停止守护进程')
      break
    }
    if (code === RESTART_CODE) {
      restarts++
      logger.mark(`[Daemon] 主进程请求重启 · 第 ${restarts} 次重新拉起（同一终端，不开新窗口）`)
      await new Promise(r => setTimeout(r, 800))
      continue
    }
    logger.mark(
      `[Daemon] 主进程已退出（code=${code ?? signal}），不再重启。如需后台常驻请使用 pnpm start`,
    )
    break
  }
  process.exit(0)
}
