/**
 * 启动流程
 */
import fs from 'node:fs'
import cfg from './config/index.js'
import { logger, setLog, setLogDir } from './log.js'
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
      logger.warn(`[Start] 创建目录 ${dir} 失败：${err}` as any)
    }
}

export async function initRedisOrFallback() {
  return redisInit()
}

export async function start() {
  const g = globalThis as any
  g.start_type ||= 'internal'
  /** 时区与标题 */
  process.env.TZ ??= 'Asia/Shanghai'
  let realVersion = '0.0.0'
  try {
    realVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
  } catch {}
  const compat = cfg.getCompat()
  process.title = compat.spoof_yunzai
    ? `JiuLi v${realVersion} (compat TRSS-Yunzai v${compat.version || ''})`
    : `JiuLi v${realVersion}`

  for (const i of ['SIGHUP', 'SIGTERM'] as const)
    process.on(i, (_signal: string, code: number) => process.exit(code))

  setLogDir('logs')
  await ensureDirs()
  setLog()

  const { default: JiuLiBot } = await import('./bot.js')
  const bot = new JiuLiBot() as any
  await injectGlobals(bot)

  logger.mark('──────── JiuLi ────────')
  logger.mark(logger.yellow(`JiuLi v${realVersion} 启动中…`))
  if (compat.spoof_yunzai) logger.info(logger.cyan(`兼容模式 · 对外标识 TRSS-Yunzai v${compat.version || ''}`))

  /** 捕获未处理的错误 */
  for (const i of ['uncaughtException', 'unhandledRejection'] as const)
    process.on(i, (e: any) => {
      try {
        bot.makeLog('error', e, i)
      } catch (err) {
        console.error(i, e, err)
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
 * 守护进程：在同一个终端内拉起/重启主进程（internal 模式默认走这里）
 *
 * - 主进程调用 `#重启` 时以退出码 255 退出 → 守护进程立即在同一终端重新拉起（不开新窗口）
 * - 主进程正常退出（`#停止`）或崩溃 → 守护进程结束，不会无限重启
 */
export async function supervise() {
  const { spawn } = await import('node:child_process')
  setLogDir('logs')
  setLog()

  const entry = process.argv[1]
  const args = process.argv.slice(2).filter(a => a !== 'daemon')
  let stopping = false
  process.once('SIGINT', () => (stopping = true))
  process.once('SIGTERM', () => (stopping = true))

  let restarts = 0
  while (!stopping) {
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: 'inherit',
      env: { ...process.env, app_type: 'internal', JIULI_CHILD: '1' },
    })
    const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(resolve =>
      child.on('exit', (c, s) => resolve({ code: c, signal: s })),
    )

    if (stopping) {
      logger.mark('[守护] 收到退出信号，停止守护进程', 'Daemon')
      break
    }
    if (code === RESTART_CODE) {
      restarts++
      logger.mark(`[守护] 主进程请求重启 · 第 ${restarts} 次重新拉起（同一终端，不开新窗口）`, 'Daemon')
      await new Promise(r => setTimeout(r, 800))
      continue
    }
    logger.mark(
      `[守护] 主进程已退出（code=${code ?? signal}），不再重启。如需后台常驻请使用 pnpm start`,
      'Daemon',
    )
    break
  }
  process.exit(0)
}
