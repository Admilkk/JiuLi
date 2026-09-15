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
  /** getAllCfg 合并结果缓存（config/<name>.yaml 变更时失效） */
  mergedCache = new Map<string, any>()
  /** 群配置 4 层合并结果缓存（(bot_id,group_id) → 配置） */
  groupCache = new Map<string, any>()

  /** 用户配置目录（可用 JIULI_CONFIG_DIR 覆盖，测试/多实例时避免污染真实配置） */
  get userDir(): string {
    return process.env.JIULI_CONFIG_DIR || 'config/config/'
  }

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

  /** 初始化配置目录：default_config → 用户配置目录 */
  initCfg() {
    const dir = this.userDir
    const defDir = 'config/default_config/'
    try {
      const filesDef = fs.readdirSync(defDir).filter(f => f !== 'pm2.yaml')
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir)
        for (const i of filesDef)
          if (!files.includes(i)) fs.copyFileSync(`${defDir}${i}`, `${dir}${i}`)
      } else fs.cpSync(defDir, dir, { recursive: true })
      /** pm2 配置放在 config/ 下（供 pnpm start 使用） */
      const pm2File = 'config/pm2.yaml'
      if (!fs.existsSync(pm2File) && fs.existsSync(`${defDir}pm2.yaml`))
        fs.copyFileSync(`${defDir}pm2.yaml`, pm2File)
      /** pm2.yaml 若被误复制进用户配置目录则清理 */
      if (fs.existsSync(`${dir}pm2.yaml`)) fs.rmSync(`${dir}pm2.yaml`, { force: true })
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

  /** package.json（对外暴露 compat.framework_name / framework_version） */
  get package(): Record<string, any> {
    if (this._package) return this._package
    let pkg: Record<string, any> = {}
    try {
      pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    } catch (err) {
      safeLog(`[Config] 读取 package.json 失败：${err}`)
    }
    const name = this.frameworkName
    const version = this.frameworkVersion
    /** 对外名与真实包名不一致时，保留真实值并对外暴露框架标识 */
    if (name && name !== pkg.name)
      pkg = { ...pkg, real_name: pkg.name, real_version: pkg.version, name, version }
    return (this._package = pkg)
  }

  /**
   * 对外暴露的框架名（插件用它识别/显示框架）
   * - 默认固定为 `JiuLi`，**不可自定义**
   * - 只有开启「插件伪装模式」（config/jiuli.yaml → compat.spoof_yunzai: true）才对外展示 trss-yunzai，
   *   用于个别插件在 TRSS 专属分支下才正常的情况
   */
  get frameworkName(): string {
    return this.getCompat().spoof_yunzai === true ? 'trss-yunzai' : 'JiuLi'
  }

  /** 对外暴露的版本号（插件用它做功能门禁；沿用 3.1.3 可避免老插件判定"版本过低"） */
  get frameworkVersion(): string {
    const compat = this.getCompat()
    return String(compat.framework_version ?? compat.version ?? '3.1.3')
  }

  /** 兼容层配置 */
  getCompat() {
    return this.getAllCfg('jiuli').compat || {}
  }

  /** 性能相关配置 */
  getPerf() {
    return this.getAllCfg('jiuli').perf || {}
  }

  /** 群配置（4 层合并，结果缓存；群配置文件变更或群开关变动时失效） */
  getGroup(bot_id: string | number = '', group_id: string | number = ''): Record<string, any> {
    const key = `${bot_id}:${group_id}`
    const cached = this.groupCache.get(key)
    if (cached) return cached
    const config = this.getAllCfg('group')
    const merged = {
      ...config.default,
      ...config[`${bot_id}:default`],
      ...config[group_id],
      ...config[`${bot_id}:${group_id}`],
    }
    this.groupCache.set(key, merged)
    return merged
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

  /**
   * 默认 + 用户配置合并
   * 结果做缓存（消息分发热路径上会被频繁读取），配置文件变更时自动失效
   */
  getAllCfg(name: string): Record<string, any> {
    const cached = this.mergedCache.get(name)
    if (cached) return cached
    const merged = {
      ...this.getdefSet(name),
      ...this.getConfig(name),
    }
    this.mergedCache.set(name, merged)
    return merged
  }

  /** 让某个配置的缓存失效（供文件变更时调用） */
  invalidate(name: string) {
    this.mergedCache.delete(name)
    this.groupCache.clear()
  }

  /** 读取 yaml */
  getYaml(type: string, name: string): any {
    const key = `${type}.${name}`
    if (key in this.config) return this.config[key]
    const base = type === 'config' ? this.userDir : `config/${type}/`
    const file = path.join(base, `${name}.yaml`)
    /** 用户配置缺失时从默认配置重建（运行期间被误删也能自愈） */
    if (type === 'config' && !fs.existsSync(file)) {
      try {
        fs.mkdirSync(base, { recursive: true })
        const defFile = `config/default_config/${name}.yaml`
        if (fs.existsSync(defFile)) {
          fs.copyFileSync(defFile, file)
          safeLog(`[Config] 用户配置 ${file} 缺失，已从默认配置重建`)
        }
      } catch (err) {
        safeLog(`[Config] 重建 ${file} 失败：${err}`)
      }
    }
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
        this.invalidate(name)
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
