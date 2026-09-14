/**
 * 日志系统
 *
 * 兼容云崽的 logger 形态：
 * - logger.<level>(...args)  带 [log_align] 前缀
 * - logger.mark / trace / debug / info / warn / error / fatal
 * - logger.red / green / blue / yellow / cyan / magenta / gray ... 颜色函数（chalk）
 * - logger.logger.{defaultLogger,commandLogger,errorLogger}
 *   · defaultLogger: trace/debug/info
 *   · commandLogger: mark/warn
 *   · errorLogger:   error/fatal
 *   · 每个 logger 对象带 isLevelEnabled(level) 与全部等级方法
 */
import { Chalk } from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

export type LogLevel = 'trace' | 'debug' | 'info' | 'mark' | 'warn' | 'error' | 'fatal' | 'off'

const LEVEL_RANK: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  mark: 3,
  warn: 4,
  error: 5,
  fatal: 6,
  off: 7,
}

export interface LoggerChannel {
  isLevelEnabled(level: string): boolean
  trace(...args: any[]): void
  debug(...args: any[]): void
  info(...args: any[]): void
  mark(...args: any[]): void
  warn(...args: any[]): void
  error(...args: any[]): void
  fatal(...args: any[]): void
}

let logLevel: LogLevel = 'info'
let logDir = 'logs'
let writeFile = true

/** 文件写入（非阻塞：按天分文件 + 流式追加） */
class FileWriter {
  streams = new Map<string, fs.WriteStream>()

  write(file: string, line: string) {
    if (!writeFile) return
    try {
      let stream = this.streams.get(file)
      if (!stream) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        stream = fs.createWriteStream(file, { flags: 'a' })
        stream.on('error', () => {})
        this.streams.set(file, stream)
      }
      stream.write(line)
    } catch {
      /* 日志写入失败不影响运行 */
    }
  }

  close() {
    for (const stream of this.streams.values()) stream.end()
    this.streams.clear()
  }
}

const fileWriter = new FileWriter()

function dateStr() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function timeStr() {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** 去掉 ANSI 颜色码（写文件用） */
function stripColor(str: string) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;]*m/g, '')
}

function renderArgs(args: any[]): string {
  const parts: string[] = []
  for (const arg of args) {
    if (typeof arg === 'string') parts.push(arg)
    else if (arg instanceof Error) parts.push(arg.stack || String(arg))
    else {
      try {
        parts.push(
          // 动态引用，避免与 util 循环依赖
          (globalThis as any).Bot?.Loging?.(arg) ?? JSON.stringify(arg),
        )
      } catch {
        parts.push(String(arg))
      }
    }
  }
  return parts.join(' ')
}

function output(level: string, size: 'command' | 'error' | 'default', args: any[]) {
  if (!isEnabled(level)) return
  const msg = `${timeStr()} ${level.toUpperCase().padEnd(5)} ${renderArgs(args)}`
  if (size === 'error') console.error(msg)
  else console.log(msg)

  const line = `${stripColor(msg)}\n`
  const day = dateStr()
  fileWriter.write(path.join(logDir, `jiuli.${day}.log`), line)
  if (size === 'error') fileWriter.write(path.join(logDir, 'error', `error.${day}.log`), line)
}

function isEnabled(level: string) {
  return LEVEL_RANK[level] >= LEVEL_RANK[logLevel]
}

/** 通道：只放行属于本通道的等级，并做等级过滤 */
function createChannel(...levels: string[]): LoggerChannel {
  const channel: any = {}
  channel.isLevelEnabled = (level: string) => levels.includes(level) && isEnabled(level)
  for (const level of levels) {
    channel[level] = (...args: any[]) => {
      const size = level === 'mark' || level === 'warn' ? 'command' : level === 'error' || level === 'fatal' ? 'error' : 'default'
      output(level, size as any, args)
    }
  }
  return channel as LoggerChannel
}

const defaultLogger = createChannel('trace', 'debug', 'info')
const commandLogger = createChannel('mark', 'warn')
const errorLogger = createChannel('error', 'fatal')

/** 全等级通道（logger.logger.<level> 直通） */
const anyLogger: LoggerChannel = (() => {
  const channel: any = {
    isLevelEnabled: (level: string) => isEnabled(level),
  }
  for (const level of ['trace', 'debug', 'info', 'mark', 'warn', 'error', 'fatal']) {
    channel[level] = (...args: any[]) => {
      const size = level === 'mark' || level === 'warn' ? 'command' : level === 'error' || level === 'fatal' ? 'error' : 'default'
      output(level, size as any, args)
    }
  }
  return channel as LoggerChannel
})()

export const chalk = new Chalk({ level: 3 })
type LevelMethod = (...args: any[]) => void

type Logger = typeof chalk & {
  trace: LevelMethod
  debug: LevelMethod
  info: LevelMethod
  mark: LevelMethod
  warn: LevelMethod
  error: LevelMethod
  fatal: LevelMethod
  logger: {
    defaultLogger: LoggerChannel
    commandLogger: LoggerChannel
    errorLogger: LoggerChannel
  } & LoggerChannel
  setLevel(level: LogLevel): void
  getLevel(): LogLevel
  setWriteFile(enable: boolean): void
}

export const logger = chalk as unknown as Logger

logger.logger = Object.assign(anyLogger, {
  defaultLogger,
  commandLogger,
  errorLogger,
})

/** 带 [log_align] 前缀的等级方法 */
const levels: LogLevel[] = ['trace', 'debug', 'info', 'mark', 'warn', 'error', 'fatal']
for (const level of levels) {
  ;(logger as any)[level] = (...args: any[]) => (anyLogger as any)[level](...args)
}

logger.setLevel = (level: LogLevel) => {
  logLevel = level in LEVEL_RANK ? level : 'info'
}
logger.getLevel = () => logLevel
logger.setWriteFile = (enable: boolean) => {
  writeFile = enable
  if (!enable) fileWriter.close()
}
export function setLogDir(dir: string) {
  logDir = dir
}

/** 按配置初始化日志等级（TRSS 在 init 阶段调用） */
export function setLog(level?: LogLevel) {
  logger.setLevel(level || (globalThis as any).cfg?.bot?.log_level || 'info')
}
