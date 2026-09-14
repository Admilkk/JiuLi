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

  logger.mark('----^_^----')
  logger.mark(logger.yellow(`JiuLi v${realVersion} 启动中...`))
  if (compat.spoof_yunzai) logger.info(logger.cyan('兼容模式：TRSS-Yunzai 生态插件可直接使用'))

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
