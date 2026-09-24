/**
 * Python 生态兼容宿主（GsCore / AstrBot 共用）
 *
 * 为什么要 Python 边车：GsCore 与 AstrBot 的插件是**普通 Python 模块**，
 * 靠 import 时的副作用注册功能（没有任何清单文件），而且真实插件大量依赖 PIL、SQLModel、
 * msgspec、APScheduler 这些 Python 运行时。用 JS 重写插件 API 只能覆盖最表面的一层，
 * 一碰图像/数据库就碎。所以这里让插件的世界保持 Python：
 *
 *   JiuLi(Node) ──stdio JSON──> Python 子进程（真解释器 + API 仿制包）──> 插件
 *
 * Node 侧只做三件事：把 JiuLi 事件转成通用事件发下去、把插件要发的消息接回来、进程生命周期托管。
 */
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 探测可用的 Python 3：显式指定 > py -3（Windows）> python3 > python */
export async function detectPython(explicit) {
  const candidates = explicit
    ? [[explicit, []]]
    : process.platform === 'win32'
      ? [
          ['py', ['-3']],
          ['python', []],
          ['python3', []],
        ]
      : [
          ['python3', []],
          ['python', []],
        ]

  const tried = []
  for (const [cmd, base] of candidates) {
    try {
      const { stdout } = await execFileAsync(cmd, [...base, '-c', 'import sys;print(sys.version.split()[0])'], {
        timeout: 15000,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      const version = String(stdout).trim()
      if (Number(version.split('.')[0]) >= 3) return { cmd, base, version }
    } catch (err) {
      tried.push(`${cmd} ${base.join(' ')}`.trim())
    }
  }
  throw new Error(`找不到可用的 Python 3（试过：${tried.join(' / ')}）。装一个，或在 compat.yaml 里填 python 路径`)
}

/**
 * 建一个 Python 边车宿主
 * @param opts.id 生态 id（gscore / astrbot）
 * @param opts.name 展示名
 * @param opts.boot 引导脚本（相对 lib/compat/py/）
 * @param opts.pluginDir 插件目录
 * @param opts.readyTimeout 启动等待上限
 */
export function createPythonHost(opts) {
  const { id, name, boot, pluginDir } = opts
  const shimDir = path.resolve('lib/compat/py')
  const bootScript = path.resolve(shimDir, boot)

  return {
    id,
    name,
    proc: null,
    ready: false,
    plugins: [],
    seq: 0,
    pending: new Map(),
    /** 当前事件 id → dispatch 时的通用事件（插件回消息时要知道发去哪） */
    events: new Map(),
    _api: null,
    _rl: null,

    async start(api) {
      this._api = api
      const cfg = api.config || {}

      if (!fs.existsSync(bootScript)) throw new Error(`缺少引导脚本 ${bootScript}`)
      if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir, { recursive: true })

      const py = await detectPython(cfg.python || '')
      const env = {
        ...process.env,
        ...(cfg.env || {}),
        PYTHONPATH: [shimDir, pluginDir, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
        JIULI_PLUGIN_DIR: pluginDir,
      }

      api.log('info', `${name} 使用 ${py.cmd} ${py.base.join(' ')} (${py.version}) · 插件目录 ${pluginDir}`)

      const proc = spawn(py.cmd, [...py.base, '-u', bootScript], {
        env,
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.proc = proc

      proc.on('error', err => {
        api.log('error', [`${name} Python 进程启动失败`, err])
      })
      proc.on('exit', (code, signal) => {
        this.ready = false
        if (!this.stopping) api.log('error', `${name} Python 进程已退出（code=${code ?? signal}），该生态插件本次运行内不再可用`)
        for (const [, p] of this.pending) p.resolve(false)
        this.pending.clear()
        this.proc = null
      })

      /** stderr 是插件的 print / traceback，原样转到 JiuLi 日志 */
      readline.createInterface({ input: proc.stderr }).on('line', line => {
        if (line.trim()) api.log('warn', `[${name}] ${line}`)
      })

      const readyPromise = new Promise((resolve, reject) => {
        this._resolveReady = resolve
        this._rejectReady = reject
      })

      this._rl = readline.createInterface({ input: proc.stdout })
      this._rl.on('line', line => this._onLine(line))

      /** 插件 import 可能很慢（PIL/SQLModel 这些），给足时间；超时也要杀掉，免得留个僵尸进程 */
      const timer = setTimeout(() => {
        this._rejectReady?.(new Error(`${name} Python 侧 ${opts.readyTimeout || 60000}ms 内没有就绪`))
      }, opts.readyTimeout || 60000)

      try {
        await readyPromise
      } finally {
        clearTimeout(timer)
      }

      api.log(this.plugins.length ? 'mark' : 'info', this.describe())
    },

    _onLine(line) {
      line = line.trim()
      if (!line) return
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        this._api?.log('debug', `[${name}] 非协议输出：${line.slice(0, 200)}`)
        return
      }
      switch (msg.t) {
        case 'ready':
          this.plugins = msg.plugins || []
          this.ready = true
          this._resolveReady?.(true)
          break
        case 'log':
          this._api?.log(msg.level || 'info', `[${name}] ${msg.msg}`)
          break
        case 'result': {
          const p = this.pending.get(msg.id)
          if (p) {
            this.pending.delete(msg.id)
            p.resolve(!!msg.handled)
          }
          break
        }
        case 'send':
          void this._onSend(msg)
          break
        default:
          this._api?.log('debug', `[${name}] 未知协议消息：${line.slice(0, 200)}`)
      }
    },

    /** 插件要发消息：有 eventId 就是回复那条消息，否则按 target 主动发 */
    async _onSend(msg) {
      const api = this._api
      if (!api) return
      const elements = msg.elements || []
      if (!elements.length) return
      const u = msg.eventId != null ? this.events.get(msg.eventId) : null
      try {
        if (u?.reply) await u.reply(elements)
        else await api.sendTo(msg.target || {}, elements)
      } catch (err) {
        api.log('error', [`${name} 插件发送消息失败`, err])
      }
    },

    async dispatch(u) {
      if (!this.ready || !this.proc?.stdin?.writable) return false
      const id = ++this.seq
      this.events.set(id, u)
      const promise = new Promise(resolve => this.pending.set(id, { resolve }))
      /** raw 是活的 JiuLi 事件（含函数），绝不能进 JSON；reply/sendTo 同理 */
      const { raw, reply, sendTo, ...plain } = u
      try {
        this.proc.stdin.write(JSON.stringify({ t: 'event', id, event: plain }) + '\n')
      } catch (err) {
        this.pending.delete(id)
        this.events.delete(id)
        this._api?.log('error', [`${name} 事件写入失败`, err])
        return false
      }
      try {
        return await promise
      } finally {
        this.events.delete(id)
      }
    },

    async stop() {
      this.stopping = true
      this.ready = false
      const proc = this.proc
      if (!proc) return
      try {
        proc.stdin.write(JSON.stringify({ t: 'shutdown' }) + '\n')
      } catch {}
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          try {
            proc.kill()
          } catch {}
          resolve()
        }, 2000)
        proc.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      this._rl?.close?.()
      this.proc = null
      this.plugins = []
      this.events.clear()
      for (const [, p] of this.pending) p.resolve(false)
      this.pending.clear()
      this.stopping = false
    },

    pluginCount() {
      return this.plugins.length
    },

    describe() {
      return this.plugins.length
        ? `${name} 插件 ${this.plugins.length} 个 · ${this.plugins.slice(0, 8).join(' · ')}${this.plugins.length > 8 ? ' …' : ''}`
        : `${name} 已就绪，但插件目录里没有插件（${pluginDir}）`
    },
  }
}
