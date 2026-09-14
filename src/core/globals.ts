/**
 * 全局变量注入（兼容层核心）
 *
 * 云崽插件的顶层代码就依赖这些全局，必须在任何插件 import 之前完成注入：
 * Bot / logger / redis / segment / Renderer / plugin / start_type
 */
import { logger } from './log.js'
import plugin from './plugin.js'
import segment, { extendSegment } from './segment.js'
import Renderer from './render/Renderer.js'

export async function injectGlobals(bot: any) {
  const g = globalThis as any
  g.Bot = bot
  g.logger = logger
  g.plugin = plugin
  g.segment = segment
  g.Renderer = Renderer
  if (!g.start_type) g.start_type = 'internal'
  await extendSegment()
  return g
}

export function injectRedis(redis: any) {
  ;(globalThis as any).redis = redis
  return redis
}
