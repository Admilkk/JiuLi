/**
 * 配置中心（兼容云崽 config 形态）
 *
 * - config/default_config/*.yaml  默认配置（随仓库提供）
 * - config/config/*.yaml          用户配置（首次启动自动复制）
 * - cfg 为 Proxy：未定义属性回落为 getAllCfg(prop)
 *   · cfg.bot / cfg.other / cfg.group / cfg.server / cfg.redis / cfg.renderer / cfg.db / cfg.jiuli
 * - 兼容 API：getGroup / getOther / getConfig / getdefSet / getYaml / getAllCfg
 *   master / masterQQ / uin / qq / package
 */
import YAML from 'yaml'
import fs from 'node:fs'
import path from 'node:path'
import chokidar from 'chokidar'
import EventEmitter from 'node:events'
import { logger } from '../log.js'

/** 配置文件读取错误时安全记录（Bot 可能尚未创建） */
function safeLog(msg: any) {
  try {
    logger.warn(msg)
  } catch {
    /* ignore */
  }
}

/** file_watch=false 时使用的空 watcher */
class NullWatcher extends EventEmitter {
  on() {
    return this
  }
  addListener() {
    return this
  }
  start() {}
  close() {}
  ref() {
    return this
  }
  unref() {
    return this
  }
}

class Cfg {
  config: Record<string, any> = {}
  watcher: Record<string, any> = {}
  _package?: Record<string, any>

  constructor() {
    this.initCfg()
    return new Proxy(this, {
      get: (target: any, prop: string | symbol) => {
        if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON' || prop === 'inspect') {
          return Reflect.get(target, prop)
        }
        const value = target[prop]
        if (value !== undefined) return value
        return target.getAllCfg(String(prop))
      },
    })
  }

  /** 初始化配置目录：default_config → config */
  initCfg() {
    const dir = 'config/config/'
    const defDir = 'config/default_config/'
    try {
      const filesDef = fs.readdirSync(defDir)
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir)
        for (const i of filesDef)
          if (!files.includes(i)) fs.copyFileSync(`${defDir}${i}`, `${dir}${i}`)
      } else fs.cpSync(defDir, dir, { recursive: true })
    } catch (err) {
      safeLog(`[Config] 初始化配置目录失败：${err}`)
    }

    if (this.getAllCfg('bot').file_watch === false) {
      const watcher = new NullWatcher() as any
      fs.watch = (() => watcher) as any
      chokidar.watch = (() => watcher) as any
      ;(chokidar as any).FSWatcher = NullWatcher
      for (const i in this.watcher) {
        this.watcher[i]?.close?.()
        delete this.watcher[i]
      }
      this.watch = () => {}
      safeLog('[Config] file_watch=false，已关闭文件监听')
    }
  }

  /** 主人账号 [bot_id, user_id][] */
  get master(): Record<string, string[]> {
    const other = this.getAllCfg('other')
    if (other.masters) return other.masters
    let master = other.master || []
    if (!Array.isArray(master)) master = [master]

    const masters: Record<string, string[]> = {}
    for (let i of master) {
      i = String(i).split(':')
      const bot_id = i.shift() as string
      const user_id = i.join(':')
      if (Array.isArray(masters[bot_id])) masters[bot_id].push(user_id)
      else masters[bot_id] = [user_id]
    }
    return (this.config['config.other'].masters = masters)
  }

  /** 主人 QQ */
  get masterQQ(): Array<number | string> {
    const other = this.getAllCfg('other')
    if (other.masterQQs) return other.masterQQs
    let masterQQ = other.masterQQ || []
    if (!Array.isArray(masterQQ)) masterQQ = [masterQQ]
    return (this.config['config.other'].masterQQs = masterQQ.map((i: any) => Number(i) || i))
  }

  /** 机器人账号 */
  get uin(): string[] {
    return Object.keys(this.master)
  }
  get qq(): string[] {
    return this.uin
  }

  /** package.json（compat.spoof_yunzai 时伪装框架名） */
  get package(): Record<string, any> {
    if (this._package) return this._package
    let pkg: Record<string, any> = {}
    try {
      pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    } catch (err) {
      safeLog(`[Config] 读取 package.json 失败：${err}`)
    }
    const compat = this.getCompat()
    if (compat.spoof_yunzai) {
      pkg = { ...pkg, real_name: pkg.name, name: compat.name || 'trss-yunzai', version: compat.version || pkg.version }
    }
    return (this._package = pkg)
  }

  /** 兼容层配置 */
  getCompat() {
    return this.getAllCfg('jiuli').compat || {}
  }

  /** 性能相关配置 */
  getPerf() {
    return this.getAllCfg('jiuli').perf || {}
  }

  /** 群配置（4 层合并） */
  getGroup(bot_id: string | number = '', group_id: string | number = ''): Record<string, any> {
    const config = this.getAllCfg('group')
    return {
      ...config.default,
      ...config[`${bot_id}:default`],
      ...config[group_id],
      ...config[`${bot_id}:${group_id}`],
    }
  }

  /** other 配置 */
  getOther(): Record<string, any> {
    return this.getAllCfg('other')
  }

  /** 默认配置 */
  getdefSet(name: string) {
    return this.getYaml('default_config', name)
  }

  /** 用户配置 */
  getConfig(name: string) {
    return this.getYaml('config', name)
  }

  /** 默认 + 用户配置合并 */
  getAllCfg(name: string): Record<string, any> {
    return {
      ...this.getdefSet(name),
      ...this.getConfig(name),
    }
  }

  /** 读取 yaml */
  getYaml(type: string, name: string): any {
    const key = `${type}.${name}`
    if (key in this.config) return this.config[key]
    const file = path.join('config', type, `${name}.yaml`)
    try {
      this.config[key] = YAML.parse(fs.readFileSync(file, 'utf8'))
    } catch (err: any) {
      if (err?.code !== 'ENOENT') safeLog(`[Config] 读取配置文件 ${file} 错误：${err}`)
      return (this.config[key] = undefined)
    }
    this.watch(file, name, type)
    return this.config[key]
  }

  /** 监听配置文件变化 */
  watch(file: string, name: string, type = 'default_config') {
    const key = `${type}.${name}`
    if (this.watcher[key]) return
    const watcher = chokidar.watch(file)
    let timer: NodeJS.Timeout | undefined
    watcher.on('change', () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        delete this.config[key]
        // package.json 相关内容可能随配置变化
        if (name === 'jiuli') this._package = undefined
        if (typeof (globalThis as any).Bot !== 'object') return
        logger.mark(`[修改配置文件][${type}][${name}]`)
        const hook = `change_${name}`
        if (hook in this) (this as any)[hook]()
      }, 5000)
    })
    this.watcher[key] = watcher
  }

  async change_bot() {
    const { setLog } = await import('../log.js')
    setLog(this.getAllCfg('bot').log_level)
  }
}

const cfg = new Cfg() as Cfg & Record<string, any>
export default cfg
