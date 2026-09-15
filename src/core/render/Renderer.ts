/**
 * 模板渲染器（art-template，兼容云崽）
 * 渲染产物必须落盘 temp/html/：模板内的相对资源路径依赖 html 文件位置。
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
    this.id = data.id || 'renderer'
    this.type = data.type || 'image'
    this.render = (this as any)[data.render || 'render'] as any
    this.support_script = data.support_script ?? true
    this.dealTpl = Renderer.dealTpl.bind(Renderer)
  }

  static dir = './temp/html'
  static html: Record<string, string> = {}
  static watcher: Record<string, any> = {}

  static createDir(dirname: string): boolean {
    if (fs.existsSync(dirname)) return true
    if (this.createDir(path.dirname(dirname))) {
      fs.mkdirSync(dirname)
      return true
    }
    return false
  }

  /** 读取模板，首次读取后写入静态缓存并监听变更 */
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

  static dealTpl(name: string, data: any): string | false {
    const html = this.readTpl(data.tplFile)
    if (!html) return false

    // 模板内通过 resPath 引用静态资源
    data.resPath = './resources/'
    const tmpHtml = template.render(html, data)
    this.createDir(`./temp/html/${name}`)
    const savePath = `./temp/html/${name}/${data.saveId ?? name}.html`
    fs.writeFileSync(savePath, tmpHtml)

    util.makeLog('debug', `模板已渲染 · ${data.tplFile} → ${savePath}`, 'Render')
    return savePath
  }

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
