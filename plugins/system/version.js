import fs from 'node:fs'
import { JiuLiPlugin, cfg } from 'jiuli'

/**
 * #版本
 * 显示框架版本、兼容目标、运行环境与 git 提交
 */
export default class Version extends JiuLiPlugin {
  constructor() {
    super({
      name: '版本',
      dsc: '#版本',
      event: 'message',
      priority: -Infinity,
      rule: [{ reg: '^#版本$', fnc: 'version' }],
    })
  }

  static realVersion() {
    try {
      return JSON.parse(fs.readFileSync('package.json', 'utf8')).version
    } catch {
      return '0.0.0'
    }
  }

  /** git 提交信息缓存（避免每次 #版本 都起一个 git 子进程） */
  static commitCache = { value: '', at: 0 }

  async gitCommit() {
    const now = Date.now()
    if (Version.commitCache.value && now - Version.commitCache.at < 300000) return Version.commitCache.value
    const ret = await Bot.exec('git log -1 --pretty=format:"%h %s"', { quiet: true })
    const value = ret.error ? '' : ret.stdout
    Version.commitCache = { value, at: now }
    return value
  }

  async version() {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const commit = await this.gitCommit()
    const msg = [
      `JiuLi v${Version.realVersion()}`,
      cfg.package.name === 'trss-yunzai' ? `兼容模式：TRSS-Yunzai v${cfg.package.version}（config/jiuli.yaml → compat）` : '兼容模式：关闭',
      `Node：${process.version}  ${process.platform} ${process.arch}`,
      commit ? `提交：${commit}` : '',
      `许可：AGPL-3.0（基于 TRSS-Yunzai 重构）`,
      pkg.dependencies?.puppeteer ? `渲染：puppeteer ${pkg.dependencies.puppeteer}` : '',
    ]
      .filter(Boolean)
      .join('\n')
    return this.reply(msg)
  }
}
