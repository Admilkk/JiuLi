/**
 * 工具层（兼容云崽 util / Bot.* 的工具方法面）
 *
 * Bot 的 Proxy 会把未命中的属性回落到 util，因此这里的方法
 * 同时构成 Bot.fsStat / Bot.Buffer / Bot.String / Bot.sleep ... 的兼容实现
 */
import fs from 'node:fs/promises'
import timers from 'node:timers/promises'
import path from 'node:path'
import nodeUtil from 'node:util'
import { exec, execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { fileTypeFromBuffer } from 'file-type'
import { ulid } from 'ulid'
import cfg from './config/index.js'
import { logger } from './log.js'

class Util {
  makeLogID(id: any) {
    if (!id) return cfg.bot?.log_align || 'JiuLi'
    if (!cfg.bot?.log_align) return id
    if (typeof id !== 'string') id = this.String(id)
    const length = (cfg.bot.log_align.length - id.length) / 2
    if (length > 0) id = `${' '.repeat(Math.ceil(length))}${id}${' '.repeat(Math.floor(length))}`
    else if (length < 0) id = `${id.slice(0, cfg.bot.log_align.length - 1)}.`
    return id
  }

  isLogLevelEnabled(level: string) {
    let target: any
    switch (level) {
      case 'trace':
      case 'debug':
      case 'info':
        target = logger.logger.defaultLogger
        break
      case 'warn':
      case 'mark':
        target = logger.logger.commandLogger
        break
      case 'error':
      case 'fatal':
        target = logger.logger.errorLogger
        break
    }
    return target?.isLevelEnabled?.(level) ?? true
  }

  makeLog(level: string, msg: any, id?: any, force?: boolean) {
    if (!this.isLogLevelEnabled(level)) return
    const log: any[] = []
    if (id !== false) log.push(logger.blue(`[${force ? id : this.makeLogID(id)}]`))
    for (const i of Array.isArray(msg) ? msg : [msg]) log.push(this.Loging(i))
    ;(logger.logger as any)[level]?.(...log)
  }

  makeError(msg: string, ...obj: any[]) {
    return Object.assign(Error(msg), ...obj)
  }

  async fsStat(file: string, opts?: any) {
    try {
      return await fs.stat(file, opts)
    } catch (err) {
      this.makeLog('trace', ['获取', file, '状态错误', err])
      return false
    }
  }

  async mkdir(dir: string, opts?: any) {
    try {
      await fs.mkdir(dir, { recursive: true, ...opts })
      return true
    } catch (err) {
      this.makeLog('error', ['创建', dir, '错误', err])
      return false
    }
  }

  async rm(file: string, opts?: any) {
    try {
      await fs.rm(file, { force: true, recursive: true, ...opts })
      return true
    } catch (err) {
      this.makeLog('error', ['删除', file, '错误', err])
      return false
    }
  }

  async glob(pattern: string, opts: any = {}) {
    if (!opts.force && (await this.fsStat(pattern))) return [pattern]
    if (!(fs as any).glob) return []
    const array: string[] = []
    try {
      for await (const i of (fs as any).glob(pattern, opts)) array.push(i)
    } catch (err) {
      this.makeLog('error', ['匹配', pattern, '错误', err])
    }
    return array
  }

  async download(url: string, file?: string, opts?: any) {
    let buffer: any
    let target = file
    if (!target || ((await this.fsStat(target)) as any)?.isDirectory?.()) {
      const type = await this.fileType({ file: url }, opts)
      target = target ? path.join(target, type.name) : type.name
      buffer = type.buffer
    } else {
      await this.mkdir(path.dirname(target))
      buffer = await this.Buffer(url, opts)
    }
    await fs.writeFile(target as string, buffer)
    return { url, file: target, buffer }
  }

  /** 带磁盘持久化的 Map（插件数据存储） */
  makeMap(parent_map: any, parent_key: string, map: Map<any, any>) {
    const save = async () => {
      try {
        await parent_map.db.put(parent_key, { map_array: Array.from(map) })
      } catch (err) {
        this.makeLog('error', ['写入', parent_map.db.location, parent_key, '错误', map, err])
      }
    }

    const set = map.set.bind(map)
    Object.defineProperty(map, 'set', {
      value: async (key: any, value: any) => {
        if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) {
          set(key, value)
          await save()
        }
        return map
      },
    })
    const del = map.delete.bind(map)
    Object.defineProperty(map, 'delete', {
      value: async (key: any) => {
        if (!del(key)) return false
        await save()
        return true
      },
    })
    return map
  }

  async setMap(map: any, set: any, key: string, value: any) {
    try {
      if (value instanceof Map) {
        set(key, this.makeMap(map, key, value))
        await map.db.put(key, { map_array: Array.from(value) })
      } else if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) {
        set(key, value)
        await map.db.put(key, value)
      }
    } catch (err) {
      this.makeLog('error', ['写入', map.db.location, key, '错误', value, err])
    }
    return map
  }

  async delMap(map: any, del: any, key: string) {
    if (!del(key)) return false
    try {
      await map.db.del(key)
    } catch (err) {
      this.makeLog('error', ['删除', map.db.location, key, '错误', err])
    }
    return true
  }

  async importMap(dir: string, map: Map<any, any>) {
    for (const i of await fs.readdir(dir)) {
      const file = path.join(dir, i)
      try {
        await map.set(
          i,
          ((await this.fsStat(file)) as any)?.isDirectory?.()
            ? await this.importMap(file, new Map())
            : JSON.parse(await fs.readFile(file, 'utf8')),
        )
      } catch (err) {
        this.makeLog('error', ['读取', file, '错误', err])
      }
      await this.rm(file)
    }
    await this.rm(dir)
    return map
  }

  async getMap(dir: string) {
    const map: any = new Map()
    const db = new (await import('level')).Level(`${dir}-leveldb`, { valueEncoding: 'json' })
    try {
      await db.open()
      for await (let [key, value] of db.iterator() as any) {
        if (typeof value === 'object' && value.map_array)
          value = this.makeMap(map, key, new Map(value.map_array))
        map.set(key, value)
      }
    } catch (err) {
      this.makeLog('error', ['打开', dir, '数据库错误', err])
      return map
    }

    Object.defineProperty(map, 'db', { value: db })
    const set = map.set.bind(map)
    Object.defineProperty(map, 'set', { value: (key: any, value: any) => this.setMap(map, set, key, value) })
    const del = map.delete.bind(map)
    Object.defineProperty(map, 'delete', { value: (key: any) => this.delMap(map, del, key) })

    if (await this.fsStat(dir)) await this.importMap(dir, map)
    return map
  }

  StringOrNull(data: any) {
    if (typeof data === 'object' && typeof data.toString !== 'function') return '[object null]'
    return String(data)
  }

  StringOrBuffer(data: any, base64?: boolean) {
    const string = String(data)
    return string.includes('\ufffd') || string.includes('\u0000')
      ? base64
        ? `base64://${Buffer.from(data).toString('base64')}`
        : data
      : string
  }

  getCircularReplacer() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const _this_ = this
    const ancestors: any[] = []
    return function (this: any, _key: string, value: any) {
      switch (typeof value) {
        case 'function':
        case 'bigint':
          return String(value)
        case 'object':
          if (value === null) return null
          if (value instanceof Map || value instanceof Set) return Array.from(value)
          if (value instanceof Error) return value.stack
          if (value.type === 'Buffer' && Array.isArray(value.data))
            try {
              return _this_.StringOrBuffer(Buffer.from(value), true)
            } catch {}
          break
        default:
          return value
      }
      while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop()
      if (ancestors.includes(value)) return `[Circular ${_this_.StringOrNull(value)}]`
      ancestors.push(value)
      return value
    }
  }

  String(data: any, opts?: any) {
    switch (typeof data) {
      case 'string':
        return data
      case 'function':
        return String(data)
      case 'object':
        if (data instanceof Error) return data.stack
        if (Buffer.isBuffer(data)) return this.StringOrBuffer(data, true)
        if (data instanceof URL) return String(data)
    }

    try {
      return JSON.stringify(data, this.getCircularReplacer(), opts) || this.StringOrNull(data)
    } catch {
      return this.StringOrNull(data)
    }
  }

  Loging(data: any, opts: any = cfg.bot?.log_object) {
    if (typeof data === 'string') {
      /* 保持原样 */
    } else if (!opts) data = this.StringOrNull(data)
    else
      data = nodeUtil.inspect(data, {
        depth: 10,
        colors: true,
        showHidden: true,
        showProxy: true,
        getters: true,
        breakLength: 100,
        maxArrayLength: 100,
        maxStringLength: 1000,
        ...opts,
      })

    const length = opts?.length || cfg.bot?.log_length || 10000
    if (data.length > length)
      data = `${data.slice(0, length)}${logger.gray(`... ${data.length - length} more characters`)}`
    return data
  }

  /** 统一取 Buffer / base64:// / http(s) / file:// / 本地路径 */
  async Buffer(data: any, opts: any = {}): Promise<any> {
    if (!Buffer.isBuffer(data)) {
      data = this.String(data)
      if (data.startsWith('base64://')) {
        data = Buffer.from(data.replace('base64://', ''), 'base64')
      } else if (data.match(/^https?:\/\//)) {
        if (opts.http) return data
        data = Buffer.from(await (await fetch(data, opts)).arrayBuffer())
      } else {
        const file = data.replace(/^file:\/\//, '')
        if (await this.fsStat(file)) {
          if (opts.file) return `file://${path.resolve(file)}`
          const buffer = await fs.readFile(file)
          if (typeof opts.size === 'number' && buffer.length > opts.size) return `file://${path.resolve(file)}`
          return buffer
        }
      }
    }

    if (typeof opts.size === 'number' && data.length > opts.size) {
      const file = path.join('temp', ulid())
      await fs.writeFile(file, data)
      setTimeout(this.rm.bind(this, file, {}), 60000)
      data = `file://${path.resolve(file)}`
    }
    return data
  }

  async fileType(data: any, opts: any = {}) {
    const file: any = { name: data.name }
    try {
      if (Buffer.isBuffer(data.file)) {
        file.url = data.name || 'Buffer'
        file.buffer = data.file
      } else {
        file.url = this.String(data.file).replace(/^base64:\/\/.*/, 'base64://...')
        file.buffer = await this.Buffer(data.file, { ...opts, size: undefined })
      }
      if (Buffer.isBuffer(file.buffer)) {
        file.type = (await fileTypeFromBuffer(file.buffer)) || {}
        file.md5 = createHash('md5').update(file.buffer).digest('hex')
        file.name ??= `${Date.now().toString(36)}.${file.md5.slice(0, 8)}.${file.type.ext}`
        if (typeof opts.size === 'number' && file.buffer.length > opts.size)
          file.buffer = await this.Buffer(data.file, opts)
      }
    } catch (err) {
      this.makeLog('error', ['文件类型检测错误', file, err])
    }
    file.name ??= `${Date.now().toString(36)}-${path.basename(file.url)}`
    return file
  }

  async exec(cmd: string | string[], opts: any = {}) {
    const { promise, resolve } = Promise.withResolvers<any>()
    const name = logger.cyan(this.String(cmd))
    this.makeLog(opts.quiet ? 'debug' : 'mark', name, 'Command')
    opts.encoding ??= 'buffer'
    const start_time = Date.now()
    const callback = (error: any, stdout: any, stderr: any) => {
      const raw = { stdout, stderr }
      stdout = String(stdout).trim()
      stderr = String(stderr).trim()
      resolve({ error, stdout, stderr, raw })
      this.makeLog(
        opts.quiet ? 'debug' : 'mark',
        `${name} ${logger.green(`[完成${this.getTimeDiff(start_time)}]`)} ${stdout ? `\n${stdout}` : ''}${stderr ? logger.red(`\n${stderr}`) : ''}`,
        'Command',
      )
      if (error) this.makeLog(opts.quiet ? 'debug' : 'error', error, 'Command')
    }
    if (Array.isArray(cmd)) execFile(cmd.shift() as string, cmd, opts, callback)
    else exec(cmd, opts, callback)
    return promise
  }

  async cmdPath(cmd: string, opts: any = {}) {
    const ret = await this.exec(`${process.platform === 'win32' ? 'where' : 'command -v'} "${cmd}"`, {
      quiet: true,
      ...opts,
    })
    return ret.error ? false : ret.stdout
  }

  cmdStart(cmd: string, args: string[] = [], opts: any = {}) {
    if (process.platform === 'win32') {
      args = ['/c', 'start', '', cmd, ...args]
      cmd = 'cmd'
    }
    this.makeLog(opts.quiet ? 'debug' : 'mark', [logger.cyan(cmd), logger.green(args.join(' '))], 'CMDStart')
    return spawn(cmd, args, { stdio: 'inherit', detached: true, ...opts })
  }

  getTimeDiff(time1: number = (globalThis as any).Bot?.stat?.start_time * 1000, time2 = Date.now()) {
    let time = time2 - (time1 || Date.now())
    const ms = time % 1000
    time = Math.floor(time / 1000)
    const sec = time % 60
    time = Math.floor(time / 60)
    const min = time % 60
    time = Math.floor(time / 60)
    const hour = time % 24
    time = Math.floor(time / 24)

    let ret = ''
    if (time) ret += `${time}天`
    if (hour) ret += `${hour}时`
    if (min) ret += `${min}分`
    if (sec) ret += `${sec}秒`
    if (ms) ret += ms
    return ret || '0秒'
  }

  promiseEvent(event: any, resolve: string, reject?: string, timeout?: number) {
    const listener = Promise.withResolvers<any>() as any
    event.once(resolve, listener.resolve)
    if (reject) event.once(reject, listener.reject)
    if (timeout)
      listener.timeout = setTimeout(
        () => listener.reject(Object.assign(Error('等待事件超时'), { event, resolve, reject, timeout })),
        timeout,
      )
    return listener.promise.finally(() => {
      event.off(resolve, listener.resolve)
      if (reject) event.off(reject, listener.reject)
      if (timeout) clearTimeout(listener.timeout)
    })
  }

  sleepTimeout = Symbol('timeout')
  sleep(time?: number, promise?: Promise<any>): any {
    if (promise) return Promise.race([promise, this.sleep(time)])
    return timers.setTimeout(time ?? 0, this.sleepTimeout)
  }

  debounceTime = Symbol('debounceTime')
  debounce(func: (...args: any[]) => any, time = 5000) {
    const debounceTime = this.debounceTime
    let promise: any = false
    function ret(this: any, ...args: any[]): any {
      if (promise) {
        if (promise.start)
          return (async (): Promise<any> => {
            try {
              await promise.promise
            } finally {
              return ret.apply(Object.assign({ [debounceTime]: time }, this), args)
            }
          })()
        else clearTimeout(promise.timeout)
      } else {
        promise = Promise.withResolvers()
      }

      promise.timeout = setTimeout(async () => {
        try {
          promise.start = true
          promise.resolve(await func.apply(this, args))
        } catch (err) {
          promise.reject(err)
        } finally {
          promise = false
        }
      }, this?.[debounceTime] ?? 0)
      return promise.promise
    }
    return ret
  }
}

export default new Util()
