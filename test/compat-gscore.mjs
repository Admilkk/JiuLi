/**
 * GsCore（早苗）兼容层自测
 *
 * 链路：JiuLi 事件 → Python 边车 → gsuid_core 仿制包 → 真实形态的插件 → 回到 JiuLi 发送
 * 跑：node test/compat-gscore.mjs
 */
import assert from 'node:assert'
import fs from 'node:fs'
import { check, makeApi, makeDispatcher, sleep, summary, textOf } from './compat-harness.mjs'

/** GsCore 仿制包的落盘位置隔离到测试目录，别碰真实 data/ */
process.env.JIULI_GS_COMPAT_DATA = 'test/.tmp-gs-compat-data'
fs.rmSync('test/.tmp-gs-compat-data', { recursive: true, force: true })

async function main() {
  console.log('GsCore 兼容层自测')
  const host = (await import('../lib/compat/hosts/gscore.js')).default
  const { api, sent } = makeApi({ python: '', env: {} })
  const dispatch = makeDispatcher(host, sent)

  await host.start(api)
  /**
   * 加载到两个：
   *   - gs_jiuli_test：本地夹具，覆盖 6 种触发器 + 多步会话
   *   - gs_test.py：**gsuid_core 仓库自带的官方回归插件，原样下载未改动**，
   *     用它证明「真实 GsCore 插件零改动可跑」（它依赖 async_timeout，需 pip install async_timeout）
   */
  check('宿主启动并加载到插件（含官方 gs_test.py）', () => assert.ok(host.pluginCount() >= 2, `pluginCount=${host.pluginCount()}`))

  // 0) 官方 gs_test.py 的真实触发器（两个插件的回复会同时在 out 里，用 some 判断）
  {
    const { sent: out } = await dispatch('违禁词测试')
    check('官方插件 on_fullmatch 可用', () => assert.ok(out.some(r => /卧槽卧槽/.test(textOf(r.msg))), JSON.stringify(out.map(r => textOf(r.msg)))))
  }
  {
    /** 真实 GsCore 的 on_prefix 要求参数紧贴命令（下一字符不能是空白），所以这里不写空格 */
    const { sent: out } = await dispatch('前缀测试abc')
    check('官方插件 on_prefix 可用', () => assert.ok(out.some(r => /正在进行\[前缀测试\]/.test(textOf(r.msg))), JSON.stringify(out.map(r => textOf(r.msg)))))
  }
  {
    const { sent: out } = await dispatch('这是一个正则测试！123')
    check('官方插件 on_regex 可用', () => assert.ok(out.some(r => /正在进行\[正则测试\]/.test(textOf(r.msg))), JSON.stringify(out.map(r => textOf(r.msg)))))
  }
  {
    const { sent: out } = await dispatch('订阅测试')
    check('官方插件 gs_subscribe 可用', () => assert.ok(out.some(r => /订阅成功/.test(textOf(r.msg))), JSON.stringify(out.map(r => textOf(r.msg)))))
  }
  /** 字段映射：插件靠 ev.bot_id / ev.user_id / ev.group_id 做绑定查询，漏一个就会静默查不到 */
  {
    const { sent: out } = await dispatch('身份测试')
    check('私聊事件的 bot_id / user_id 正确', () => assert.match(textOf(out[0]?.msg), /身份 10000\/20000\/-/))
  }
  {
    const { sent: out } = await dispatch('身份测试', { group_id: '888777666' })
    check('群消息事件的 group_id 正确', () => assert.match(textOf(out[0]?.msg), /身份 10000\/20000\/888777666/))
  }

  // 1) on_command + Plugins 前缀展开：gs查询深渊 / 查询深渊 都该命中
  {
    const { handled, sent: out } = await dispatch('gs查询深渊 12层')
    check('on_command（带前缀）命中并回复', () => {
      assert.equal(handled, true)
      assert.match(textOf(out[0]?.msg), /GsCore 查询深渊：12层/)
    })
  }
  {
    const { handled } = await dispatch('查询深渊 12层')
    check('on_command（allow_empty_prefix 无前缀）同样命中', () => assert.equal(handled, true))
  }

  // 2) on_fullmatch
  {
    const { sent: out } = await dispatch('全匹配')
    check('on_fullmatch 命中', () => assert.match(textOf(out[0]?.msg), /全匹配命中/))
  }

  // 3) on_prefix 必须带后续内容
  {
    const { sent: out } = await dispatch('前缀内容')
    check('on_prefix 命中并取到 ev.text', () => assert.match(textOf(out[0]?.msg), /前缀命中：内容/))
  }
  {
    const { handled } = await dispatch('前缀')
    check('on_prefix 无参数不命中', () => assert.equal(handled, false))
  }

  // 4) on_suffix / on_keyword
  {
    const { sent: out } = await dispatch('随便什么后缀')
    check('on_suffix 命中', () => assert.match(textOf(out[0]?.msg), /后缀命中/))
  }
  {
    const { sent: out } = await dispatch('前面关键词后面')
    check('on_keyword 命中', () => assert.match(textOf(out[0]?.msg), /关键词命中/))
  }

  // 5) on_regex 的命名分组 → ev.regex_dict
  {
    const { sent: out } = await dispatch('正则123')
    check('on_regex 命中并填充 regex_dict', () => assert.match(textOf(out[0]?.msg), /正则命中：123/))
  }

  // 6) 图片段
  {
    const { sent: out } = await dispatch('图片测试')
    check('MessageSegment.image 转成 JiuLi image segment', () => {
      const img = out[0]?.msg?.find(i => i.type === 'image')
      assert.ok(img, `segments=${JSON.stringify(out[0]?.msg)}`)
      assert.match(String(img.file), /example\.com\/gs\.png/)
    })
  }

  // 7) 匹配但不回复 → 不拦截（否则一个 on_message 就能吞掉所有云崽插件）
  {
    const { handled, sent: out } = await dispatch('不回消息')
    check('匹配但未回复时不拦截', () => assert.equal(handled, false))
    check('匹配但未回复时不乱发消息', () => assert.equal(out.length, 0))
  }

  // 8) 无关消息
  {
    const { handled } = await dispatch('这是一条谁都不认识的普通消息')
    check('无触发器命中时不拦截', () => assert.equal(handled, false))
  }

  // 9) 多步会话 receive_resp
  //    注意：等待中的消息被消费后 result 立刻返回，插件恢复后才会发出回复，
  //    所以这里 sleep 一下再取 sent —— 真实的异步语义就是这样
  {
    sent.length = 0
    const pending = dispatch('多步测试')
    await sleep(400)
    const prompt = textOf(sent[0]?.msg)
    sent.length = 0
    await dispatch('A')
    await sleep(400)
    const reply = textOf(sent[0]?.msg)
    await pending
    check('receive_resp 先发提示', () => assert.match(prompt, /请选择一个选项/))
    check('receive_resp 消费了下一条消息', () => assert.match(reply, /你选了：A/))
  }

  // 10) SL 开关
  {
    await dispatch('开关测试')
    const { handled } = await dispatch('全匹配')
    check('SV.disable() 后不再触发', () => assert.equal(handled, false))
  }

  await host.stop()
  const failed = summary()
  process.exit(failed ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
