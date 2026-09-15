import fs from 'node:fs/promises'
import path from 'node:path'
import { JiuLiPlugin, cfg } from 'jiuli'
import { Restart } from './restart.js'

/** 同一时间只允许一个更新流程 */
let updating = false

/**
 * 更新框架本体与插件
 *
 *   #更新 [#安静] [强制] [插件名]
 *   #全部[安静][强制]更新
 *   #更新日志 [插件名]
 *
 * 生态插件会 `new Update(e)` 后直接调用 getPlugin / runUpdate / getLog / restart，
 * 这些方法名与云崽保持一致，不要改。
 */
export default class Update extends JiuLiPlugin {
  constructor(e) {
    super({
      name: '更新',
      dsc: '#更新 #静更新 #强制更新 #全部更新 #更新日志',
      event: 'message',
      priority: -Infinity,
      rule: [
        { reg: '^#更新日志\\s*(.*)$', fnc: 'updateLog' },
        { reg: '^#全部(安?静)?(强制)?更新$', fnc: 'updateAll', permission: 'master', log: false },
        { reg: '^#重启更新$', fnc: 'update', permission: 'master', log: false },
        { reg: '^#(安?静)?(强制)?更新\\s*(.*)$', fnc: 'update', permission: 'master' },
      ],
    })
    if (e) this.e = e
  }

  /** 静默模式：只说结果，不说"开始更新"与"已是最新" */
  get quiet() {
    return /^#(全部)?(安?静)/.test(this.e?.msg || '')
  }

  /** 展示名：框架本体为 typeName，插件为目录名 */
  typeName = 'JiuLi'
  isUp = false
  isPkgUp = false
  oldCommitId = ''

  init() {
    /** 自动/定时更新走虚拟事件（与进程管理插件同一套做法） */
    this.e = {
      isMaster: true,
      logFnc: '[自动更新]',
      msg: '#全部静更新',
      reply: msg => Bot.sendMasterMsg(msg),
    }
    if (cfg.bot.update_time) this.autoUpdate()
    this.task = []
    const push = (name, cron, fnc) => {
      for (const i of Array.isArray(cron) ? cron : [cron]) this.task.push({ name, cron: i, fnc })
    }
    if (cfg.bot.update_cron) push('定时更新', cfg.bot.update_cron, () => this.updateAll())
  }

  autoUpdate() {
    setTimeout(() => this.updateAll().finally(() => this.autoUpdate()), cfg.bot.update_time * 60000)
  }

  /** 在插件目录（或仓库根）执行命令 */
  exec(cmd, plugin = '', opts = {}) {
    const cwd = plugin ? path.join(process.cwd(), 'plugins', plugin) : process.cwd()
    return Bot.exec(cmd, { quiet: true, cwd, ...opts })
  }

  /**
   * 把名字解析成 plugins/ 下的目录名；空串表示框架本体，false 表示没找到
   *
   * 宽松匹配：`#更新ICQQ` 能命中 `Yunzai-ICQQ-Plugin`
   */
  async getPlugin(name) {
    const plugin = String(
      name ?? this.e?.msg?.replace(/#(全部)?(安?静)?(强制)?更新(日志)?/, '') ?? '',
    ).trim()
    if (!plugin) {
      this.typeName = 'JiuLi'
      return ''
    }

    const dirs = await fs.readdir('plugins').catch(() => [])
    for (const i of [plugin, `${plugin}-Plugin`, `${plugin}-plugin`])
      if (dirs.includes(i)) return (this.typeName = i)

    const key = plugin.toLowerCase()
    const hits = dirs.filter(i => {
      const low = i.toLowerCase()
      return low.endsWith(`${key}-plugin`) || low.endsWith(key) || low.includes(key)
    })
    if (hits.length === 1) return (this.typeName = hits[0])
    if (hits.length > 1) {
      await this.reply(`「${plugin}」匹配到多个插件：\n${hits.join(' · ')}\n请写明完整目录名`)
      return false
    }
    await this.reply(`plugins/ 下没有「${plugin}」，可用 #插件列表 查看`)
    return false
  }

  async getCommitId(plugin = '') {
    return (await this.exec('git rev-parse --short HEAD', plugin)).stdout
  }

  async getTime(plugin = '') {
    return (await this.exec('git log -1 --pretty=%cd --date=format:"%F %T"', plugin)).stdout
  }

  async getBranch(plugin = '') {
    return (await this.exec('git branch --show-current', plugin)).stdout
  }

  async getRemote(branch, plugin = '') {
    return (await this.exec(`git config branch.${branch}.remote`, plugin)).stdout
  }

  /** string 为真时返回 `origin/master` 这种字符串，否则返回 { remote, branch } */
  async getRemoteBranch(str, plugin = '') {
    const branch = await this.getBranch(plugin)
    if (!branch && str) return ''
    const remote = await this.getRemote(branch, plugin)
    if (!remote && str) return ''
    return str ? `${remote}/${branch}` : { remote, branch }
  }

  async getRemoteUrl(branch, hide, plugin = '') {
    if (branch) {
      const url = (await this.exec(`git config remote.${branch}.url`, plugin)).stdout
      return hide ? url.replace(/\/\/([^@]+)@/, '//') : url
    }
    const ret = await this.exec('git config -l', plugin)
    const urls = {}
    for (const i of ret.stdout.match(/remote\..*?\.url=.+/g) || []) {
      const b = i.replace(/remote\.(.*?)\.url=.+/g, '$1')
      const url = i.replace(/remote\..*?\.url=/g, '')
      urls[b] = hide ? url.replace(/\/\/([^@]+)@/, '//') : url
    }
    return urls
  }

  /** 更新一个仓库：plugin 为空表示框架本体 */
  async runUpdate(plugin = '') {
    if (!(await Bot.fsStat(path.join(plugin ? `plugins/${plugin}` : '.', '.git')))) {
      await this.reply(
        plugin ? `「${plugin}」不是 git 仓库（没有 .git），无法更新` : '当前目录不是 git 仓库，无法更新框架',
      )
      return false
    }
    this.typeName = plugin || 'JiuLi'

    let cmd = 'git pull'
    let type = '更新'
    if (this.e?.msg?.includes('强制')) {
      type = '强制更新'
      const remoteBranch = await this.getRemoteBranch(true, plugin)
      cmd = remoteBranch
        ? `git reset --hard ${remoteBranch} && git pull --rebase`
        : 'git fetch --all && git reset --hard origin/HEAD'
    }

    this.oldCommitId = await this.getCommitId(plugin)
    logger.mark(`${this.e?.logFnc || '[更新]'} 开始${type} ${this.typeName}`)
    if (!this.quiet) await this.reply(`开始${type} ${this.typeName}`)

    const ret = await this.exec(cmd, plugin)
    if (ret.error && !(await this.gitErr(plugin, ret.stdout, ret.error.message))) {
      logger.mark(`${this.e?.logFnc || '[更新]'} ${type}失败 ${this.typeName}`)
      return false
    }

    const time = await this.getTime(plugin)
    if (/Already up[ -]to[ -]date|已经是最新/.test(ret.stdout)) {
      if (!this.quiet) await this.reply(`${this.typeName} 已是最新\n最后更新时间：${time}`)
    } else {
      this.isUp = true
      if (/package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml/.test(ret.stdout)) this.isPkgUp = true
      await this.reply(`${this.typeName} 更新成功\n更新时间：${time}`)
      const log = await this.getLog(plugin)
      if (log) await this.reply(log)
    }
    logger.mark(`${this.e?.logFnc || '[更新]'} 最后更新时间：${time}`)
    return true
  }

  /** 常见 git 错误的解释与下一步建议；返回 true 表示已在内部补救成功 */
  async gitErr(plugin, stdout, error) {
    const hint = plugin ? `#强制更新${plugin}` : '#强制更新'
    const url = error.match(/'(.+?)'/g)?.[0]?.replace(/'/g, '') || ''
    if (/unable to access|无法访问|Could not resolve|连接超时|Failed to connect/i.test(error))
      await this.reply(`远程仓库连接失败：${url || error}\n请检查网络或代理后重试`)
    else if (/not found|未找到|does not (exist|appear)|不存在|Authentication failed|鉴权失败/i.test(error))
      await this.reply(`远程仓库地址或凭据有误：${url || error}`)
    else if (/local changes|本地修改|be overwritten by merge|被合并操作覆盖/i.test(error))
      await this.reply(
        `「${plugin || 'JiuLi'}」有本地改动，git 拒绝覆盖：\n${stdout || ''}\n` +
          `确认不需要这些改动后发送 ${hint} 覆盖更新`,
      )
    else if (/Merge conflict|合并冲突/i.test(stdout))
      await this.reply(`${error}\n${stdout}\n若修改过文件请手动更新，否则发送 ${hint}`)
    else if (/divergent branches|偏离的分支|Need to specify how to reconcile/i.test(error)) {
      const ret = await this.exec('git pull --rebase', plugin)
      if (!ret.error && /Successfully rebased|成功变基/i.test(ret.stdout + ret.stderr)) return true
      await this.reply(`${error}\n${stdout}\n可发送 ${hint} 覆盖更新`)
    } else await this.reply(`${error}\n${stdout}\n未知错误，可尝试发送 ${hint}`)
    return false
  }

  async update() {
    if (!this.e?.isMaster) return false
    if (updating) return this.reply('正在更新，请稍候再试')

    /** rule 里带捕获组时 useHandler 会传参，这里统一按消息解析 */
    const plugin = await this.getPlugin()
    if (plugin === false) return false

    updating = true
    try {
      await this.runUpdate(plugin)
      if (this.isPkgUp) await this.updatePackage()
      if (this.isUp) this.restart()
    } finally {
      updating = false
    }
  }

  async updateAll() {
    if (!this.e?.isMaster) return false
    if (updating) return this.reply('正在更新，请稍候再试')

    updating = true
    try {
      await this.runUpdate()
      for (const dir of await fs.readdir('plugins').catch(() => [])) {
        /** 只更新 git 仓库，非仓库目录（system / demo / 自建目录）静默跳过 */
        if (!(await Bot.fsStat(path.join('plugins', dir, '.git')))) continue
        await this.runUpdate(dir).catch(err => logger.error(`更新 ${dir} 失败`, err))
      }
      if (this.isPkgUp) await this.updatePackage()
      if (this.isUp) this.restart()
    } finally {
      updating = false
    }
  }

  async updatePackage() {
    await this.reply('开始更新依赖')
    const ret = await this.exec('pnpm install')
    if (ret.error) await this.reply(`依赖安装失败，请手动执行 pnpm install\n${Bot.String(ret.stderr)}`)
    return ret
  }

  /** 延迟一点再重启，保证上面的消息先发出去 */
  restart(delay = 2000) {
    if (!this.isUp) return
    setTimeout(() => new Restart(this.e).restart(), delay)
  }

  /** 提交日志：有 oldCommitId 时列出上次更新之后的提交（返回可转发的数组） */
  async getLog(plugin = '') {
    const ret = await this.exec('git log -100 --pretty="%h||[%cd] %s" --date=format:"%F %T"', plugin)
    if (ret.error) return '读取提交日志失败'

    /** 单独查看日志（没有更新基线）时只列最近 10 条 */
    const max = this.oldCommitId ? 100 : 10
    const log = []
    for (const str of ret.stdout.split('\n')) {
      const [id, msg] = str.split('||')
      if (!msg) continue
      if (this.oldCommitId && id === this.oldCommitId) break
      if (msg.includes('Merge branch')) continue
      log.push(msg)
      if (log.length >= max) break
    }
    if (!log.length) return ''

    const msg = [`${this.typeName} 更新日志，共 ${log.length} 条`, log.join('\n\n')]
    const url = await this.getRemoteUrl((await this.getRemoteBranch(false, plugin)).remote, true, plugin)
    if (typeof url === 'string' && url) msg.push(url)
    return Bot.makeForwardArray(msg)
  }

  async updateLog() {
    const plugin = await this.getPlugin()
    if (plugin === false) return false
    const log = await this.getLog(plugin)
    return this.reply(log || `${this.typeName} 暂无新的提交`)
  }
}

/** 兼容旧插件的具名导入：import { update } from '../../system/update.js' */
export { Update as update }
