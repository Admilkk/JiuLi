import fs from 'node:fs'
import moment from 'moment'
import { JiuLiPlugin, cfg } from 'jiuli'
import { PluginsLoader } from 'jiuli/core'

/** 真实框架版本（config 里的 package 可能被伪装成 trss-yunzai） */
let realVersion
function getRealVersion() {
  if (realVersion) return realVersion
  try {
    realVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
  } catch {
    realVersion = '0.0.0'
  }
  return realVersion
}

/**
 * #状态 / #统计
 *
 * 主人：运行状态 + 在线时长 + 插件加载耗时 + 消息统计
 * 非主人：仅返回自己的消息统计
 * 支持 `#状态 群 123456 日期 20260914`、`#状态 用户 10001`、`#状态 消息 image` 等查询
 */
export default class Status extends JiuLiPlugin {
  constructor() {
    super({
      name: '状态统计',
      dsc: '#状态',
      event: 'message',
      rule: [{ reg: '^#(状态|统计)', fnc: 'status' }],
    })
  }

  async status() {
    if (!this.e.isMaster)
      return this.reply(
        await this.getCount({
          用户: this.e.user_id,
          群: this.e.group_id,
        }),
      )

    const frameworkName = cfg.frameworkName
    const compat = frameworkName && frameworkName !== 'JiuLi' ? ` (对外标识 ${frameworkName} v${cfg.frameworkVersion})` : ''
    const msg =
      `—— JiuLi v${getRealVersion()}${compat} ——\n` +
      `运行时间：${Bot.getTimeDiff()}\n` +
      `内存使用：${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)}MB\n` +
      `系统版本：${process.platform} ${process.arch} ${process.version}\n\n` +
      this.botTime() +
      (await this.count())

    return this.reply(Bot.makeForwardArray([msg, this.pluginTime()]))
  }

  botTime() {
    let msg = '账号在线时长'
    for (const i of Bot.uin)
      if (Bot[i]?.stat?.start_time) msg += `\n${Bot.getTimeDiff(Bot[i].stat.start_time * 1000)} ${i}`
    return msg
  }

  pluginTime() {
    let msg = '插件加载用时'
    for (const i in PluginsLoader.load_time)
      msg += `\n${Bot.getTimeDiff(0, PluginsLoader.load_time[i])} ${i}`
    return msg
  }

  count() {
    const cmd = {
      msg: this.e.msg
        .replace(/^#(状态|统计)/, '')
        .trim()
        .split(' '),
    }
    let key = ''
    for (const i of cmd.msg)
      if (key) {
        cmd[key] = i
        key = ''
      } else {
        key = i
      }
    return this.getCount(cmd)
  }

  async getCount(cmd) {
    const date = []
    if (cmd['日期']) {
      cmd['日期'] = cmd['日期'].replace(/[^\d]/g, '')
      switch (cmd['日期'].length) {
        case 8:
          date.push([cmd['日期'].slice(0, 4), cmd['日期'].slice(4, 6), cmd['日期'].slice(6, 8)])
          break
        case 4:
          date.push([moment().format('YYYY'), cmd['日期'].slice(0, 2), cmd['日期'].slice(2, 4)])
          break
        case 2:
          date.push([moment().format('YYYY'), moment().format('MM'), cmd['日期']])
          break
        default:
          this.reply(`日期格式错误：${cmd['日期']}`)
          return ''
      }
    } else {
      const d = moment()
      for (let i = 0; i < 3; i++) {
        date.push(d.format('YYYY MM DD').split(' '))
        d.add(-86400000)
      }
      date.push([d.format('YYYY'), d.format('MM')], [d.format('YYYY')], ['total'])
    }

    let msg = '消息统计'
    if (cmd['消息']) {
      msg = `${cmd['消息']} ${msg}`
    } else {
      cmd['消息'] = 'msg'
    }

    const array = []
    if (cmd['机器人']) array.push({ text: '机器人', key: 'bot', id: cmd['机器人'] })
    if (cmd['用户']) array.push({ text: '用户', key: 'user', id: cmd['用户'] })
    if (cmd['群']) array.push({ text: '群', key: 'group', id: cmd['群'] })
    if (!array.length) {
      array.push(
        { text: msg, key: 'total' },
        { type: 'keys', text: '用户量', key: 'user:*' },
        { type: 'keys', text: '群量', key: 'group:*' },
      )
      msg = ''
      if (this.e.self_id) array.push({ text: '机器人', key: 'bot', id: this.e.self_id })
      if (this.e.user_id) array.push({ text: '用户', key: 'user', id: this.e.user_id })
      if (this.e.group_id) array.push({ text: '群', key: 'group', id: this.e.group_id })
    }

    for (const i of array) {
      if (i.id) {
        i.text += ` ${i.id}`
        i.key += `:${i.id}`
      }
      msg += `\n\n${i.text}`
      for (let d of date) {
        const key = `:${cmd['消息']}:${i.key}:${d.join(':')}`
        d = d.join('-')
        if (d == 'total') d = '总计 -------'
        else d = `${d} ${'-'.repeat(11 - d.length)}`
        const ret = await this.getRedisCount(i.type, key)
        msg += `\n${d} 收 ${ret.receive} 发 ${ret.send}`
      }
    }
    return msg
  }

  async getRedisCount(type, key) {
    const ret = {}
    for (const i of ['receive', 'send']) {
      const k = `Yz:count:${i}${key}`
      if (type == 'keys') ret[i] = (await this.redisKeysLength(k)) || 0
      else ret[i] = (await redis.get(k)) || 0
    }
    return ret
  }

  async redisKeysLength(MATCH) {
    let cursor = 0,
      length = 0
    do {
      const reply = await redis.scan(cursor, { MATCH, COUNT: 10000 })
      cursor = reply.cursor
      length += reply.keys.length
    } while (cursor != 0)
    return length
  }
}
