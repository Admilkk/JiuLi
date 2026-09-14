import { JiuLiPlugin } from 'jiuli'
import { PluginsLoader } from 'jiuli/core'

/**
 * #重载 / #重载插件 <关键词>
 *
 * 手动重载插件（等价于改文件触发的热重载，用于 index.js 目录型插件或强制刷新）
 *   #重载              重载全部插件
 *   #重载 状态         重载名字/文件里包含「状态」的插件
 */
export default class Reload extends JiuLiPlugin {
  constructor() {
    super({
      name: '重载插件',
      dsc: '#重载',
      event: 'message',
      priority: -Infinity,
      rule: [{ reg: '^#重载(插件)?\\s*(.*)$', fnc: 'reload', permission: 'master' }],
    })
  }

  async reload() {
    const keyword = String(this.e.msg).replace(/^#重载(插件)?/, '').trim()
    const e = this.e
    const keys = [...new Set(PluginsLoader.priority.map(i => i.key))]
    const targets = keyword ? keys.filter(k => k.includes(keyword)) : keys

    if (!targets.length) return this.reply(`没有匹配「${keyword}」的插件`)

    await this.reply(`开始${keyword ? `重载匹配「${keyword}」的` : '重载全部'}插件（${targets.length} 个）…`, true)

    /** 等回复发出去再动手，避免卸载掉正在处理这条消息的插件 */
    setTimeout(async () => {
      const start = Date.now()
      let ok = 0
      const failed = []
      for (const key of targets) {
        const before = PluginsLoader.priority.filter(i => i.key === key).length
        const countBefore = PluginsLoader.pluginCount
        await PluginsLoader.changePlugin(key)
        const after = PluginsLoader.priority.filter(i => i.key === key).length
        if (after > 0 && (after >= before || PluginsLoader.pluginCount >= countBefore)) ok++
        else failed.push(key)
      }
      const msg = `重载完成 · 成功 ${ok} 个${failed.length ? ` · 失败 ${failed.length} 个（${failed.join(', ')}）` : ''} · 用时 ${Date.now() - start}ms`
      logger.mark(msg)
      if (e.group_id) await Bot.sendGroupMsg(e.self_id, e.group_id, msg)
      else await Bot.sendFriendMsg(e.self_id, e.user_id, msg)
    }, 1500)
  }
}
