/**
 * 渲染后端加载器
 *
 * 扫描 renderers/<name>/ 目录加载渲染后端（用户可扩展）：
 *   renderers/<name>/index.js        export default (config) => renderer 对象
 *   renderers/<name>/config.yaml     用户配置（缺失时从 config_default.yaml 复制）
 *
 * renderer 对象要求：{ id, type, render(name, data) }
 * 渲染时按顺序尝试后端，返回第一个成功的结果（Buffer 或 Buffer[]）
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'yaml'
import { logger } from '../log.js'
import cfg from '../config/index.js'
import util from '../util.js'

/** 惰性获取 segment（由兼容层注入全局） */
async function getSegment() {
  const g = globalThis as any
  if (g.segment) return g.segment
  try {
    const spec = 'oicq'
    const mod: any = await import(spec)
    return mod.segment
  } catch {
    return undefined
  }
}

export class RendererLoader {
  renderers = new Map<string, any>()
  dir = 'renderers'
  script_renderers: any[] = []
  noscript_renderers: any[] = []
  loaded = false

  async load() {
    if (this.loaded) return this
    this.loaded = true
    if (!fs.existsSync(this.dir)) {
      logger.warn('[Renderer] 未找到 renderers 目录，渲染功能不可用')
      return this
    }

    const subFolders = fs.readdirSync(this.dir, { withFileTypes: true }).filter(d => d.isDirectory())
    for (const subFolder of subFolders) {
      const name = subFolder.name
      try {
        /** 绝对路径加载：renderers 位于项目根目录，不受本文件层级影响 */
        const rendererUrl = pathToFileURL(path.resolve(this.dir, name, 'index.js')).href
        const rendererFn = (await import(rendererUrl)).default
        const configFile = `${this.dir}/${name}/config.yaml`
        const configDefault = `${this.dir}/${name}/config_default.yaml`
        if (!fs.existsSync(configFile) && fs.existsSync(configDefault))
          fs.copyFileSync(configDefault, configFile)
        const rendererCfg = fs.existsSync(configFile) ? yaml.parse(fs.readFileSync(configFile, 'utf8')) : {}
        const renderer = rendererFn(rendererCfg)
        if (!renderer?.id || !renderer?.type || typeof renderer.render !== 'function') {
          logger.warn(`渲染后端 ${renderer?.id || name} 不可用`)
          continue
        }
        this.renderers.set(renderer.id, renderer)
        util.makeLog(
          'info',
          `渲染后端 ${logger.green(renderer.id)} 已就绪 · 类型 ${renderer.type} · 支持 script ${renderer.support_script ? '是' : '否'}${
            typeof renderer.info === 'string' ? ` · ${renderer.info}` : ''
          }`,
          'Render',
        )
      } catch (err) {
        util.makeLog('error', `渲染后端 ${name} 加载失败 · ${(err as any)?.message || err}`, 'Render')
      }
    }

    const renderers = [...this.renderers.values()]
    this.script_renderers = [
      ...renderers.filter(i => i.support_script),
      ...renderers.filter(i => !i.support_script),
    ]
    this.noscript_renderers = [
      ...renderers.filter(i => !i.support_script),
      ...renderers.filter(i => i.support_script),
    ]
    return this
  }

  getRenderer(name: string | undefined = cfg.renderer?.name) {
    return this.renderers.get(name as string) || this
  }

  async render(name: string, data: any): Promise<any> {
    if (!this.loaded) await this.load()
    const { default: Renderer } = await import('./Renderer.js')
    const html = Renderer.readTpl(data.tplFile)
    if (!html) return false
    for (const i of String(html).includes('</script>') ? this.script_renderers : this.noscript_renderers)
      try {
        const res = await i.render(name, data)
        if (res) return res
      } catch (err) {
        util.makeLog('error', `渲染后端 ${i.id} 渲染出错 · ${(err as any)?.message || err}`, 'Render')
      }
    return false
  }

  /** 渲染并包成 segment.image（兼容云崽 puppeteer.screenshot） */
  async screenshot(name: string, data: any) {
    const img = await this.render(name, data)
    if (!img) return img
    const segment = await getSegment()
    return segment ? segment.image(img) : img
  }

  /** 分片截图（兼容云崽 puppeteer.screenshots） */
  async screenshots(name: string, data: any) {
    data.multiPage = true
    const imgs = (await this.render(name, data)) || []
    const segment = await getSegment()
    const ret = []
    for (const img of Array.isArray(imgs) ? imgs : [imgs]) ret.push(img ? (segment ? segment.image(img) : img) : img)
    return ret.length > 0 ? ret : false
  }
}

export default new RendererLoader()
export { path }
