/**
 * 插件代码热重载：让「日志写着重载、跑的却还是旧代码」真正生效
 *
 * 原来的 changePlugin 只做一件事：`import('../../plugins/<key>/index.js?<时间戳>')`。
 * 入口带了时间戳，所以入口文件本身会重新求值；但入口里 `import './apps/x.js'`、
 * `import './lib/y.js'` 这类**嵌套说明符**解析出来的 URL 不带时间戳，直接命中 Node 的
 * ESM 模块缓存 —— 于是目录型插件（index.js + apps/ + lib/）改代码后日志里一行
 * 「插件修改 → 重载」，跑的还是旧模块，用户必须重启才生效。
 * 实测：给 lib/panel.js 里的标题加个标记，重载后指令输出里没有标记。
 *
 * 这里用 Node 的同步模块钩子（`module.registerHooks`，v22.15 / v23.5 起）在解析阶段
 * 给「plugins/ 下的文件」统一追加查询参数 `?jiuli_reload=<代数>`：
 * 每次重载把代数 +1，整张插件模块图就会以全新的 URL 重新求值（嵌套的也换）。
 * 而框架自身、根 node_modules、以及插件自带的 node_modules **不加**这个参数 ——
 * 那些是多个插件共享的依赖，重复求值等于把依赖实例也复制一份（有的包在顶层建连接、
 * 起定时器），既慢又容易出怪问题。
 *
 * 取不到 registerHooks（Node 偏老）时退化成原来的行为：只有入口会重新求值，
 * 并让 loader 打一行提示，别让用户以为改了代码就一定能生效。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as nodeModule from 'node:module'

/** 查询参数名。插件自己带 query 时不会冲突（用独立的键名） */
const STAMP = 'jiuli_reload'

/** 当前代数：重载前 +1，于是「解析出的插件文件 URL」全部换新 */
let generation = 0
/** plugins 目录的 file:// 前缀（带尾斜杠），只给这个前缀下的文件加参数 */
let prefix = ''
let registered = false

/** 同步模块钩子；Node < 22.15 上没有，此时退回老行为 */
const registerHooks: undefined | ((hooks: any) => void) = (nodeModule as any).registerHooks

/** 当前运行环境是否支持「整张模块图重载」 */
export function supportsModuleReload(): boolean {
  return typeof registerHooks === 'function'
}

/**
 * 注册解析钩子并记住插件目录前缀。幂等，重复调用只更新前缀。
 * @param pluginDir 插件目录（相对或绝对路径都可以）
 * @returns 是否支持整图重载（false 表示只能重载入口，调用方应记一行提示）
 */
export function enableModuleReload(pluginDir: string): boolean {
  prefix = pathToFileURL(path.resolve(pluginDir)).href.replace(/\/+$/, '') + '/'
  if (registered || typeof registerHooks !== 'function') return supportsModuleReload()
  registerHooks({
    resolve(specifier: string, context: any, nextResolve: (s: string, c: any) => any) {
      return stamp(nextResolve(specifier, context))
    },
  })
  registered = true
  return true
}

/**
 * 给插件目录下的模块 URL 打上当前代数。
 *
 * 判定顺序：先看协议与前缀（框架与依赖直接放过，成本最低），再看是不是插件自带的
 * node_modules，最后避免重复打标（同一个 URL 在模块图里被多次 import 时保持一致）。
 */
function stamp(result: any) {
  const url: string | undefined = result?.url
  if (!url || !url.startsWith(prefix) || url.includes('/node_modules/')) return result
  const parsed = new URL(url)
  if (parsed.searchParams.has(STAMP)) return result
  parsed.searchParams.set(STAMP, String(generation))
  return { ...result, url: parsed.href }
}

/**
 * 重载前调用：代数 +1。
 * 此后解析到的插件文件都是新 URL，等于把该插件的模块图整体换一份（旧图自然被回收）。
 */
export function bumpModuleGeneration(): void {
  generation++
}
