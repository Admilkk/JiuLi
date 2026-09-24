/**
 * AstrBot（Star）兼容层自测
 *
 * 链路：JiuLi 事件 → Python 边车 → astrbot 仿制包 → 真实形态的 Star 插件 → 回到 JiuLi 发送
 * 跑：node test/compat-astrbot.mjs
 */
import assert from 'node:assert'
import { check, makeApi, makeDispatcher, summary, textOf } from './compat-harness.mjs'

async function main() {
  console.log('AstrBot 兼容层自测')
  const host = (await import('../lib/compat/hosts/astrbot.js')).default
  const { api, sent } = makeApi({ python: '', env: {} })
  const dispatch = makeDispatcher(host, sent)

  await host.start(api)
  /**
   * 加载到两个：
   *   - astrbot_plugin_jiuli_test：本地夹具，覆盖各种 filter / 组件
   *   - helloworld：**从官方模板仓库原样下载的真实插件**（Soulter/helloworld, AstrBot v4.28.1 官方模板），
   *     用它证明「真实 AstrBot 插件零改动可跑」
   */
  check('宿主启动并加载到插件（含官方模板 helloworld）', () => assert.ok(host.pluginCount() >= 2, `pluginCount=${host.pluginCount()}`))

  // 0) 官方模板 helloworld：@register + @filter.command + event.get_messages()
  {
    const { handled, sent: out } = await dispatch('/helloworld')
    check('官方模板插件的 /helloworld 指令可用', () => {
      assert.equal(handled, true)
      assert.match(textOf(out[0]?.msg), /Hello, 小测/)
    })
  }

  // 1) @filter.command 带参数（参数按签名解析）
  {
    const { handled, sent: out } = await dispatch('astr命令 小明')
    check('指令命中并解析参数', () => {
      assert.equal(handled, true)
      assert.match(textOf(out[0]?.msg), /你好 小明！/)
    })
    check('链式结果里 At 被转成 JiuLi at segment', () => {
      const at = out[0]?.msg?.find(i => i.type === 'at')
      assert.ok(at, `segments=${JSON.stringify(out[0]?.msg)}`)
      assert.equal(at.qq, '20000')
    })
  }

  // 2) 指令默认参数
  {
    const { sent: out } = await dispatch('astr命令')
    check('缺省参数用默认值', () => assert.match(textOf(out[0]?.msg), /你好 世界！/))
  }

  // 3) 消息组件：Image.fromURL
  {
    const { sent: out } = await dispatch('astr图片')
    check('Image.fromURL 转成 JiuLi image segment', () => {
      const img = out[0]?.msg?.find(i => i.type === 'image')
      assert.ok(img, `segments=${JSON.stringify(out[0]?.msg)}`)
      assert.match(String(img.file), /example\.com\/astr\.png/)
    })
  }

  // 4) @filter.regex（不受唤醒前缀约束）
  {
    const { sent: out } = await dispatch('astr正则456')
    check('@filter.regex 命中', () => assert.match(textOf(out[0]?.msg), /正则命中/))
  }

  // 5) @filter.event_message_type(ALL) 监听
  {
    const { sent: out } = await dispatch('astr监听')
    check('event_message_type 监听命中', () => assert.match(textOf(out[0]?.msg), /监听命中/))
  }
  {
    const { handled } = await dispatch('一句平凡的话')
    check('监听器没回复时不拦截', () => assert.equal(handled, false))
  }

  // 6) event.send 直接发送
  {
    const { sent: out } = await dispatch('astr发送')
    check('event.send 直接发送命中', () => assert.match(textOf(out[0]?.msg), /直接发送命中/))
  }

  // 7) permission_type(ADMIN)：非管理员不放行
  {
    const { handled, sent: out } = await dispatch('astr管理', { role: 'member' })
    check('非管理员不能触发 ADMIN 指令', () => {
      assert.equal(handled, false)
      assert.equal(out.length, 0)
    })
  }
  {
    const { sent: out } = await dispatch('astr管理', { isMaster: true })
    check('管理员可以触发 ADMIN 指令', () => assert.match(textOf(out[0]?.msg), /管理员指令命中：admin/))
  }

  // 8) 主动消息：context.send_message(umo, chain)
  {
    const { sent: out } = await dispatch('astr主动')
    check('context.send_message 主动发送命中', () => assert.match(textOf(out[0]?.msg), /主动消息命中/))
    check('主动消息回到同一会话', () => assert.equal(out[0]?.target?.channelId, '20000'))
  }

  // 9) StarTools.get_data_dir
  {
    const { sent: out } = await dispatch('astr数据目录')
    check('StarTools 可用', () => assert.match(textOf(out[0]?.msg), /数据目录：astrbot_plugin_jiuli_test/))
  }

  await host.stop()
  const failed = summary()
  process.exit(failed ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
