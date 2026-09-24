/**
 * 生态兼容宿主（JiuLi v2）
 *
 * 一句话：让 JiuLi 除了云崽插件，还能跑 Koishi / GsCore(早苗) / AstrBot 的插件。
 *
 * 分工：
 *   bridge.js      —— 通用事件与消息模型（生态无关）
 *   本文件          —— 宿主注册表 + 生命周期 + 带超时的分发
 *   hosts/*.js     —— 每个生态一个宿主，只做「注册表映射 + 事件映射」
 *
 * 宿主契约（hosts/<id>.js 默认导出）：
 *   {
 *     id: 'koishi',
 *     name: 'Koishi',
 *     async start(api),   // 加载/启动该生态的插件；失败请 throw，由宿主管理器记录
 *     async stop(),       // 释放资源（定时器、子进程、监听器）
 *     async dispatch(u),  // u 为通用事件，返回 true 表示已处理（可拦截 JiuLi 自身规则）
 *     async send(target, elements),  // 可选：主动发消息
 *   }
 *
 * 为什么要超时：外来插件可能死循环或 await 一个永远不 resolve 的 Promise，
 * 没有超时就会把整条消息分发挂死（JiuLi 的 deal() 是 await 调用钩子的）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { jiuLiToUniversal, makeSender, toSegments, elementsToText } from './bridge.js'
import { compatRoot } from './paths.js'

/** 已注册宿主 id → host */
const hosts = new Map()
/** 启动诊断，供 #诊断 / 日志展示 */
const diagnostics = new Map()

export function log(level, msg, id = 'Compat') {
  const Bot = globalThis.Bot
  try {
    if (typeof Bot?.makeLog === 'function') return Bot.makeLog(level, msg, id)
  } catch {
    /* 启动早期 Bot 还没建好 */
  }
  const line = typeof msg === 'string' ? msg : Array.isArray(msg) ? msg.map(String).join(' ') : String(msg)
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(`[${id}]`, line)
}

export function registerHost(host) {
  if (!host?.id) throw new Error('兼容宿主必须有 id')
  hosts.set(host.id, host)
  return host
}

export function getHost(id) {
  return hosts.get(id)
}

export function listHosts() {
  return [...hosts.values()]
}

export function getDiagnostics() {
  return Object.fromEntries(diagnostics)
}

/** 配置（用户配置目录下的 compat.yaml）；缺文件时给一份安全默认值，保证兼容层不因配置缺失而失效 */
export function getConfig() {
  const fallback = { enabled: false, timeout_ms: 15000, intercept: true }
  try {
    const cfg = globalThis.cfg
    const all = cfg?.getAllCfg ? cfg.getAllCfg('compat') : undefined
    return { ...fallback, ...(all || {}) }
  } catch {
    return fallback
  }
}

/** 某个生态的配置：compat.yaml → ecosystems.<id> */
export function getEcoConfig(id) {
  const all = getConfig()
  return { enabled: false, ...(all.ecosystems?.[id] || {}) }
}

/* ==================== 主动发送 ==================== */

/**
 * 向指定会话发消息（供 Koishi 的 ctx.broadcast / GsCore 主动推送等使用）
 * @param target { selfId?, channelId, isGroup? }
 */
export async function sendTo(target = {}, msg) {
  const Bot = globalThis.Bot
  const segments = toSegments(msg)
  if (!segments.length) return false
  const selfId = target.selfId ? String(target.selfId) : String(Bot?.uin?.[0] ?? Bot?.uin ?? '')
  const bot = Bot?.bots?.[selfId] || (selfId && Bot?.[selfId])
  if (!bot) return false
  try {
    const contact = target.isGroup ? bot.pickGroup(String(target.channelId)) : bot.pickFriend(String(target.channelId))
    return await contact?.sendMsg(segments)
  } catch (err) {
    log('error', [`发送失败 ${target.isGroup ? '群' : '私聊'} ${target.channelId}`, err])
    return false
  }
}

/* ==================== 生命周期 ==================== */

/**
 * 宿主拿到的宿主级 API。刻意做得窄：宿主只能通过它发消息、记日志、读配置。
 * 直接访问 Bot / loader 的内部状态会让兼容层与内核耦合死，内核一改宿主就全崩。
 */
export function makeHostApi(id) {
  return {
    id,
    config: getEcoConfig(id),
    globalConfig: getConfig(),
    log: (level, msg) => log(level, msg, 'Compat'),
    sendTo,
    toSegments,
    elementsToText,
    /** 可选的渲染：需要图片的插件（帮助图、面板）走内核渲染，拿不到就返回 false */
    async render(tpl, data, opts) {
      try {
        const { default: renderService } = await import('../core/render/index.js')
        return await renderService.render(tpl, data, opts)
      } catch {
        return false
      }
    },
    /** 内核信息（版本、协议端），供插件展示 */
    info() {
      try {
        const cfg = globalThis.cfg
        return {
          name: cfg?.frameworkName || 'JiuLi',
          version: cfg?.package?.version || '0.0.0',
          uin: [...(globalThis.Bot?.uin || [])],
        }
      } catch {
        return { name: 'JiuLi', version: '0.0.0', uin: [] }
      }
    },
  }
}

/** 宿主模块候选路径：内置 hosts/<id>.js，以及用户在 <插件目录>/compat/hosts/ 下自己放的同名文件 */
function hostSpecifier(id) {
  const custom = path.join(compatRoot(), 'hosts', `${id}.js`)
  if (fs.existsSync(custom)) return pathToFileURL(custom).href
  return `./hosts/${id}.js`
}

let started = false
const startedHosts = []
let timeoutMs = 15000
let intercept = true

/**
 * 启动全部启用的生态宿主。
 * 单个生态失败不影响其它生态，也不影响 JiuLi 自身启动。
 */
export async function start(config = getConfig()) {
  timeoutMs = Number(config.timeout_ms) > 0 ? Number(config.timeout_ms) : 15000
  intercept = config.intercept !== false

  const wanted = Object.entries(config.ecosystems || {}).filter(([, v]) => v?.enabled)
  if (!config.enabled || !wanted.length) {
    log('info', '生态兼容已关闭（config/compat.yaml → compat.enabled）', 'Compat')
    return { started: [], skipped: Object.keys(config.ecosystems || {}) }
  }

  log('info', `开始加载生态兼容宿主：${wanted.map(([id]) => id).join(' · ')}`, 'Compat')

  for (const [id, ecoCfg] of wanted) {
    const startedAt = Date.now()
    try {
      const mod = await import(hostSpecifier(id))
      const host = mod.default || mod.host
      if (!host?.start) throw new Error('宿主缺少 start()')
      host.id ||= id
      host.name ||= id
      registerHost(host)
      await host.start(makeHostApi(id))
      startedHosts.push(host)
      diagnostics.set(id, { ok: true, ms: Date.now() - startedAt, plugins: host.pluginCount?.() ?? undefined })
      log('mark', `${host.name} 兼容宿主已就绪${host.describe ? ` · ${host.describe()}` : ''}`, 'Compat')
    } catch (err) {
      diagnostics.set(id, { ok: false, ms: Date.now() - startedAt, error: String(err?.message || err) })
      log('error', [
        `${ecoCfg?.name || id} 兼容宿主加载失败：${String(err?.message || err)}`,
        id === 'koishi'
          ? '        多半是依赖没装：cd plugins/compat && pnpm install（或 pnpm add koishi）'
          : '        Python 侧失败请看上面的 stderr 输出',
      ])
      log('debug', [`${id} 宿主失败详情`, err])
    }
  }

  started = true
  return { started: startedHosts.map(h => h.id), failed: [...diagnostics].filter(([, d]) => !d.ok).map(([id]) => id) }
}

/** 停止全部宿主（#重载 / 进程退出时调用） */
export async function stop() {
  for (const host of startedHosts.splice(0)) {
    try {
      await host.stop?.()
    } catch (err) {
      log('warn', [`${host.name} 宿主停止出错`, err])
    }
  }
  hosts.clear()
  diagnostics.clear()
  started = false
}

/**
 * 分发一条 JiuLi 事件给所有宿主。
 * @returns {Promise<boolean>} true = 已被外来插件处理，调用方应拦截 JiuLi 自身的规则匹配
 */
export async function dispatch(e) {
  if (!started || !hosts.size) return false

  const universal = jiuLiToUniversal(e)
  universal.reply = makeSender(e)
  universal.sendTo = (target, msg) => sendTo(target, msg)

  for (const host of hosts.values()) {
    if (host.enabled === false) continue
    const handled = await Promise.race([
      (async () => {
        try {
          return await host.dispatch(universal)
        } catch (err) {
          log('error', [
            `${host.name} 插件处理消息出错：${String(err?.message || err)}`,
            '        这条消息已交回 JiuLi 继续处理，其它插件不受影响',
          ])
          log('debug', [`${host.id} 分发失败详情`, err])
          return false
        }
      })(),
      new Promise(resolve =>
        /** 不能 unref：宿主没回消息时全靠它推进，unref 后事件循环空了进程会直接退出 */
        setTimeout(() => resolve('timeout'), timeoutMs),
      ),
    ])

    if (handled === 'timeout') {
      log('error', [
        `${host.name} 插件处理超时（${timeoutMs}ms），本条消息已交回 JiuLi`,
        '        该插件可能卡在 await 上；config/compat.yaml → timeout_ms 可调',
      ])
      continue
    }
    if (handled === true) return intercept
  }
  return false
}

/** 兼容层自身状态，供 #诊断 使用 */
export function status() {
  const list = [...hosts.values()].map(h => ({
    id: h.id,
    name: h.name,
    plugins: h.pluginCount?.() ?? undefined,
    detail: h.describe?.() ?? '',
    ...(diagnostics.get(h.id) || {}),
  }))
  /** 启动就失败的宿主不会进 hosts 表，但必须能看到失败原因，否则排查时是"什么都没有" */
  for (const [id, d] of diagnostics) if (!list.some(h => h.id === id)) list.push({ id, name: id, plugins: 0, ...d })
  return {
    enabled: started,
    timeoutMs,
    intercept,
    hosts: list,
  }
}

export const compat = { start, stop, dispatch, status, sendTo, log, listHosts, getDiagnostics }

export { jiuLiToUniversal, makeSender, toSegments, elementsToText }
export default compat
