/**
 * 模板渲染器（art-template）
 *
 * 兼容云崽行为：
 * - 读取 html 模板 → 渲染 → 写入 temp/html/<name>/<saveId>.html
 * - 模板文件变更自动失效缓存
 * - 渲染产物落盘是必要的：模板中的相对资源路径依赖 html 文件位置
 */
import template from 'art-template'
import chokidar from 'chokidar'
import path from 'node:path'
import fs from 'node:fs'
import util from '../util.js'

export default class Renderer {
  id: string
  type: string
  render: (...args: any[]) => any
  support_script: boolean
  dealTpl: typeof Renderer.dealTpl

  constructor(data: any) {
    /** 渲染器ID */
    this.id = data.id || 'renderer'
    /** 渲染器类型 */
    this.type = data.type || 'image'
    /** 渲染器入口 */
    this.render = (this as any)[data.render || 'render'] as any
    /** 支持 <script> */
    this.support_script = data.support_script ?? true
    this.dealTpl = Renderer.dealTpl.bind(Renderer)
  }

  static dir = './temp/html'
  static html: Record<string, string> = {}
  static watcher: Record<string, any> = {}

  /** 递归创建文件夹 */
  static createDir(dirname: string): boolean {
    if (fs.existsSync(dirname)) return true
    if (this.createDir(path.dirname(dirname))) {
      fs.mkdirSync(dirname)
      return true
    }
    return false
  }

  /** 读取 html 模板（带缓存 + 热更新） */
  static readTpl(tplFile: string): string | false {
    if (!this.html[tplFile]) {
      try {
        this.html[tplFile] = fs.readFileSync(tplFile, 'utf8')
      } catch {
        util.makeLog('error', `模板文件不存在或无法读取 · ${tplFile}`, 'Render')
        return false
      }
      this.watch(tplFile)
    }
    return this.html[tplFile]
  }

  /** 渲染模板并落盘 */
  static dealTpl(name: string, data: any): string | false {
    const html = this.readTpl(data.tplFile)
    if (!html) return false

    data.resPath = './resources/'
    const tmpHtml = template.render(html, data)
    this.createDir(`./temp/html/${name}`)
    const savePath = `./temp/html/${name}/${data.saveId ?? name}.html`
    fs.writeFileSync(savePath, tmpHtml)

    util.makeLog('debug', `模板已渲染 · ${data.tplFile} → ${savePath}`, 'Render')
    return savePath
  }

  /** 监听模板变化 */
  static watch(tplFile: string) {
    if (this.watcher[tplFile]) return
    const watcher = chokidar.watch(tplFile)
    watcher.on('change', () => {
      delete this.html[tplFile]
      util.makeLog('info', `模板已更新（缓存失效）· ${tplFile}`, 'Render')
    })
    this.watcher[tplFile] = watcher
  }
}
