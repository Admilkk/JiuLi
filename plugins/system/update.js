import fs from 'node:fs/promises'
import path from 'node:path'
import { JiuLiPlugin } from 'jiuli'

/**
 * #更新 / #强制更新 / #全部更新 / #更新日志
 *
 * 框架自身通过 git pull（可选强制重置）+ pnpm install 更新；
 * 全部更新会遍历 plugins/ 下所有 git 仓库。
 */
export default class Update extends JiuLiPlugin {
  constructor() {
    super({
      name: '更新',
      dsc: '#更新 #全部更新',
      event: 'message',
      priority: -Infinity,
      rule: [
        { reg: '^#(强制)?更新$', fnc: 'update', permission: 'master' },
        { reg: '^#全部更新$', fnc: 'updateAll', permission: 'master' },
        { reg: '^#更新日志$', fnc: 'changelog' },
        { reg: '^#(重启)?重启更新$', fnc: 'update', permission: 'master', log: false },
      ],
    })
  }

  /** 更新单个仓库 */
  async pull(dir = process.cwd(), force = false) {
    if (!(await Bot.fsStat(path.join(dir, '.git')))) return { skip: true }
    if (force) {
      await Bot.exec('git fetch --all', { cwd: dir, quiet: true })
      return Bot.exec('git reset --hard origin/HEAD', { cwd: dir, quiet: true })
    }
    return Bot.exec('git pull', { cwd: dir, quiet: true })
  }

  async update() {
    const force = this.e.msg.includes('强制')
    await this.reply(`开始${force ? '强制' : ''}更新…`, true)

    const ret = await this.pull(process.cwd(), force)
    if (ret.skip) return this.reply('当前目录不是 git 仓库，请手动更新')

    if (ret.error) return this.reply(`更新失败\n${Bot.String(ret.stderr || ret.error)}`)

    const changed = !/Already up[ -]to[ -]date|已经是最新/i.test(ret.stdout || '')
    if (!changed) return this.reply('已是最新版本', true)

    const install = await Bot.exec('pnpm install', { cwd: process.cwd(), quiet: true })
    await this.reply(
      `更新完成${install.error ? '（依赖安装失败，请手动执行 pnpm install）' : ''}\n${Bot.String(ret.stdout).slice(0, 500)}\n请发送 #重启`,
    )
  }

  async updateAll() {
    await this.reply('开始更新全部插件…', true)
    const dirs = await fs.readdir('plugins', { withFileTypes: true }).catch(() => [])
    const ret = ['已更新插件：']
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const target = path.join('plugins', dir.name)
      if (!(await Bot.fsStat(path.join(target, '.git')))) {
        ret.push(`· ${dir.name}（非 git 仓库，跳过）`)
        continue
      }
      const res = await this.pull(target)
      const changed = res && !res.error && !/Already up[ -]to[ -]date|已经是最新/i.test(res.stdout || '')
      ret.push(`· ${dir.name} ${res?.error ? '更新失败' : changed ? '已更新' : '已是最新'}`)
    }
    await this.reply(`全部更新完成\n${ret.join('\n')}`)
  }

  async changelog() {
    const ret = await Bot.exec('git log -5 --pretty=format:"%h %ad %s" --date=short', { quiet: true })
    if (ret.error) return this.reply('暂无法读取更新日志（非 git 仓库？）')
    return this.reply(`最近更新：\n${ret.stdout}`)
  }
}

/** 兼容旧插件的具名导入：import { update } from '../../system/update.js' */
export { Update as update }
