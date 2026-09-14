import { JiuLiPlugin } from 'jiuli'
import { PluginsLoader } from 'jiuli/core'

/**
 * #重载 / #重载插件 <关键词>
 *
 * 手动重载插件；也会把"磁盘上有、但还没加载"的插件（新 clone 进来的）一起加载
 *   #重载              处理全部插件
 *   #重载 状态         只处理名字/文件里包含「状态」的插件
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

    /** 磁盘上的插件文件（用于发现"新加进来但还没加载"的插件） */
    const onDisk = await PluginsLoader.getPlugins()
    const loadedKeys = new Set(PluginsLoader.priority.map(i => i.key))
    const missing = onDisk.map(f => f.name).filter(name => !loadedKeys.has(name))
    const loaded = [...loadedKeys]

    const targets = keyword ? loaded.filter(k => k.includes(keyword)) : loaded
    const newOnes = keyword ? missing.filter(k => k.includes(keyword)) : missing

    if (!targets.length && !newOnes.length) return this.reply(`没有匹配「${keyword}」的插件`)

    const parts = []
    if (targets.length) parts.push(`重载 ${targets.length} 个`)
    if (newOnes.length)
      parts.push(`新加载 ${newOnes.length} 个（${newOnes.slice(0, 3).join(', ')}${newOnes.length > 3 ? ' …' : ''}）`)
    await this.reply(`开始${keyword ? `处理匹配「${keyword}」的插件：` : '：'}${parts.join(' · ')}…`, true)

    /** 等回复发出去再动手，避免卸载掉正在处理这条消息的插件 */
    setTimeout(async () => {
      const start = Date.now()
      let ok = 0
      const failed = []
      /** 先加载新插件 */
      for (const key of newOnes) {
        const before = PluginsLoader.pluginCount
        await PluginsLoader.reloadKey(key)
        if (PluginsLoader.pluginCount > before) ok++
        else failed.push(key)
      }
      /** 再重载已加载的 */
      for (const key of targets) {
        const before = PluginsLoader.priority.filter(i => i.key === key).length
        const countBefore = PluginsLoader.pluginCount
        await PluginsLoader.changePlugin(key)
        const after = PluginsLoader.priority.filter(i => i.key === key).length
        if (after > 0 && (after >= before || PluginsLoader.pluginCount >= countBefore)) ok++
        else failed.push(key)
      }
      const msg = `处理完成 · 成功 ${ok} 个${failed.length ? ` · 失败 ${failed.length} 个（${failed.join(', ')}）` : ''} · 用时 ${Date.now() - start}ms`
      logger.mark(msg)
      if (e.group_id) await Bot.sendGroupMsg(e.self_id, e.group_id, msg)
      else await Bot.sendFriendMsg(e.self_id, e.user_id, msg)
    }, 1500)
  }
}
