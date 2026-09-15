/**
 * 日志系统，兼容云崽 logger 形态
 * logger.logger.{defaultLogger,commandLogger,errorLogger} 各只放行自己的等级，并统一提供 isLevelEnabled。
 */
import { Chalk } from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

export const chalk = new Chalk({ level: 3 })

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

/** 流式追加写日志，按天分文件 */
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

/** 写文件前去除 ANSI 颜色码 */
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

/** 等级配色，只作用于终端（写文件前会 stripColor） */
const LEVEL_STYLE: Record<string, (str: string) => string> = {
  trace: chalk.gray,
  debug: chalk.gray,
  info: chalk.cyan,
  mark: chalk.magenta,
  warn: chalk.yellow,
  error: (str: string) => chalk.bold.red(str),
  fatal: (str: string) => chalk.bgRed.white(str),
}

/** 没有携带 id 的日志（插件直接调 logger.xxx、第三方库）统一挂框架名 */
const DEFAULT_ID = 'JiuLi'

/** 与 util.makeLogID 同一套对齐规则；此处自带实现，避免 util ←→ log 循环依赖 */
function alignId(id: string) {
  const align: string | undefined = (globalThis as any).cfg?.bot?.log_align
  if (!align) return id
  const length = (align.length - id.length) / 2
  if (length > 0) return `${' '.repeat(Math.ceil(length))}${id}${' '.repeat(Math.floor(length))}`
  if (length < 0) return `${id.slice(0, align.length - 1)}.`
  return id
}

function sizeOf(level: string): 'command' | 'error' | 'default' {
  if (level === 'mark' || level === 'warn') return 'command'
  if (level === 'error' || level === 'fatal') return 'error'
  return 'default'
}

function output(level: string, args: any[], id?: string | false, raw = false) {
  if (!isEnabled(level)) return
  const style = LEVEL_STYLE[level] || ((str: string) => str)
  /** id 为 false 表示这行不带来源列；raw 用于长 id（如 `10001 => 20002`），不做对齐 */
  const source = id ?? DEFAULT_ID
  const name = raw ? String(source) : alignId(String(source))
  const color = String(source) === DEFAULT_ID ? chalk.bold.green : chalk.blue
  const tag = id === false ? '' : `${color(`[${name}]`)} `
  const msg = `${timeStr()} ${style(level.toUpperCase().padEnd(5))} ${tag}${renderArgs(args)}`
  if (sizeOf(level) === 'error') console.error(msg)
  else console.log(msg)

  const line = `${stripColor(msg)}\n`
  const day = dateStr()
  fileWriter.write(path.join(logDir, `jiuli.${day}.log`), line)
  if (sizeOf(level) === 'error') fileWriter.write(path.join(logDir, 'error', `error.${day}.log`), line)
}

/** 带来源列的写入入口：框架内部（util.makeLog）用它把模块名放进日志左边那列 */
export function writeLog(level: string, id: string | false | undefined, args: any[], raw = false) {
  output(level, args, id, raw)
}

function isEnabled(level: string) {
  return LEVEL_RANK[level] >= LEVEL_RANK[logLevel]
}

/** 只放行本通道包含的等级 */
function createChannel(...levels: string[]): LoggerChannel {
  const channel: any = {}
  channel.isLevelEnabled = (level: string) => levels.includes(level) && isEnabled(level)
  for (const level of levels) {
    channel[level] = (...args: any[]) => output(level, args)
  }
  return channel as LoggerChannel
}

const defaultLogger = createChannel('trace', 'debug', 'info')
const commandLogger = createChannel('mark', 'warn')
const errorLogger = createChannel('error', 'fatal')

/** 全等级直通通道，logger.logger 同时挂载它和三个子通道 */
const anyLogger: LoggerChannel = (() => {
  const channel: any = {
    isLevelEnabled: (level: string) => isEnabled(level),
  }
  for (const level of ['trace', 'debug', 'info', 'mark', 'warn', 'error', 'fatal']) {
    channel[level] = (...args: any[]) => output(level, args)
  }
  return channel as LoggerChannel
})()

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

/** 按配置初始化日志等级 */
export function setLog(level?: LogLevel) {
  logger.setLevel(level || (globalThis as any).cfg?.bot?.log_level || 'info')
}
