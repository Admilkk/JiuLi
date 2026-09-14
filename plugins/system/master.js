import fs from 'node:fs/promises'
import { ulid } from 'ulid'
import YAML from 'yaml'
import { JiuLiPlugin, cfg } from 'jiuli'

const code = {}
/** 用户配置目录（支持 JIULI_CONFIG_DIR 覆盖） */
const configFile = () => `${cfg.userDir}other.yaml`.replace(/\\/g, '/').replace(/\/+/g, '/')

/**
 * #设置主人
 * 非主人发送 #设置主人 获取验证码（日志中打印），在 120 秒内回复验证码即可将自己设为主人
 */
export default class Master extends JiuLiPlugin {
  constructor() {
    super({
      name: '设置主人',
      dsc: '设置主人',
      event: 'message',
      priority: -Infinity,
      rule: [
        { reg: '^#设置主人验证码$', fnc: 'code', permission: 'master' },
        { reg: '^#设置主人$', fnc: 'master' },
      ],
    })
  }

  code() {
    let msg = ''
    for (const i in code) msg += `[${i}] ${code[i]}\n`
    return this.reply(msg.trim() || '暂无验证码', true)
  }

  async edit(yamlFile, key, value) {
    const doc = YAML.parseDocument(await fs.readFile(yamlFile, 'utf8'))
    const values = doc.get(key)
    if (values) {
      if (values.items.some(item => item.value == value)) return
      values.add(value)
    } else doc.set(key, [value])
    /** 目录被清理时自愈 */
    await Bot.mkdir(yamlFile.replace(/[/\\][^/\\]+$/, ''))
    return fs.writeFile(yamlFile, doc.toString(), 'utf8')
  }

  master() {
    if (this.e.isMaster) return this.reply(`[${this.e.user_id}] 已经为主人`, true)

    code[`${this.e.self_id}:${this.e.user_id}`] = ulid()
    logger.mark(
      `${logger.cyan(`[${this.e.user_id}]`)} 设置主人验证码 ${logger.green(code[`${this.e.self_id}:${this.e.user_id}`])}`,
    )
    this.setContext('verify')
    return this.reply(`[${this.e.user_id}] 请输入验证码`, true)
  }

  async verify() {
    const key = `${this.e.self_id}:${this.e.user_id}`
    const verifyCode = code[key]
    const verified = Boolean(verifyCode) && this.e.msg?.trim().toUpperCase() === verifyCode
    delete code[key]
    this.finish('verify')
    if (verified) {
      await this.edit(configFile(), 'masterQQ', this.e.user_id)
      await this.edit(configFile(), 'master', `${this.e.self_id}:${this.e.user_id}`)
      return this.reply(`[${this.e.user_id}] 设置主人完成`, true)
    }
    return this.reply('验证码错误', true)
  }
}
