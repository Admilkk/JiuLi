/**
 * Koishi 兼容层自测
 *
 * 不启动整个 JiuLi（不连协议端、不起 HTTP），只把 Koishi 宿主接上假 api，
 * 验证「JiuLi 事件 → Koishi 插件 → 回到 JiuLi 发送」这条链路是通的。
 *
 * 跑：node test/compat-koishi.mjs
 */
import assert from 'node:assert'
import path from 'node:path'
import { jiuLiToUniversal, toSegments } from '../lib/compat/bridge.js'

const FIXTURE = path.resolve('plugins/compat/pkgs/koishi/koishi-plugin-jiuli-test')

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}\n    ${err?.message || err}`)
  }
}

async function main() {
  console.log('Koishi 兼容层自测')
  const host = (await import('../lib/compat/hosts/koishi.js')).default

  /** 假 api：收集宿主发出去的消息 */
  const sent = []
  const api = {
    id: 'koishi',
    /**
     * FIXTURE：本地夹具，覆盖 command / on('message') / middleware 三种写法
     * koishi-plugin-markdown：**从 npm 装的真实社区插件**，验证「真实 koishi-plugin-* 包
     *   能被解析、加载、注册」这条最容易出问题的路径（default 解包、CJS/ESM、服务缺失）
     */
    config: { plugins: [FIXTURE, 'koishi-plugin-markdown'], http: false, settle_ms: 400 },
    log: (level, msg) => {
      if (level === 'error' || level === 'warn') console.log(`    [${level}] ${msg}`)
    },
    sendTo: async (target, msg) => {
      /** 与真实的 lib/compat/index.js → sendTo 一样：通用元素在这里才变成 JiuLi segment */
      sent.push({ target, msg: toSegments(msg) })
      return true
    },
    toSegments,
    elementsToText: text => text,
    info: () => ({ name: 'JiuLi', version: 'test', uin: ['10000'] }),
  }

  await host.start(api)
  check('宿主启动后加载到插件', () => assert.ok(host.pluginCount() >= 1, `pluginCount=${host.pluginCount()}`))
  check(
    'npm 上的真实社区插件被加载',
    () => assert.ok(host.loaded.includes('koishi-plugin-markdown'), `loaded=${JSON.stringify(host.loaded)}`),
  )

  /** 造一条 JiuLi 私聊消息 */
  const makeEvent = (text, extra = {}) => ({
    post_type: 'message',
    message_type: 'private',
    self_id: '10000',
    user_id: '20000',
    message_id: `m-${Date.now()}`,
    message: [{ type: 'text', text }],
    msg: text,
    sender: { user_id: '20000', nickname: '小测' },
    ...extra,
  })

  const dispatch = async text => {
    sent.length = 0
    const handled = await host.dispatch(jiuLiToUniversal(makeEvent(text)))
    return { handled, sent: [...sent] }
  }

  // 1) 指令：Koishi command + action
  {
    const { handled, sent: out } = await dispatch('jl测试 你好')
    check('指令被 Koishi 插件处理并回复', () => assert.ok(handled === true, 'handled 应为 true'))
    check('回复内容正确', () => {
      const text = out[0]?.msg?.map(i => i.text ?? '').join('')
      assert.match(String(text), /Koishi 插件收到：你好/)
    })
    check('回到 JiuLi 的发送目标是私聊', () => assert.equal(out[0]?.target?.isGroup, false))
  }

  // 2) ctx.on('message') + session.send
  {
    const { handled, sent: out } = await dispatch('koishi监听')
    check('原始 message 监听生效', () => {
      const text = out[0]?.msg?.map(i => i.text ?? '').join('')
      assert.match(String(text), /监听命中/)
    })
    check('监听发送也算已处理', () => assert.ok(handled === true))
  }

  // 3) 中间件返回字符串
  {
    const { handled, sent: out } = await dispatch('koishi中间件')
    check('ctx.middleware 返回值被发出', () => {
      const text = out[0]?.msg?.map(i => i.text ?? '').join('')
      assert.match(String(text), /中间件命中/)
    })
    check('中间件命中算已处理', () => assert.ok(handled === true))
  }

  // 4) 元素出站：Koishi h() → JiuLi segment
  {
    const { sent: out } = await dispatch('jl图片')
    const types = (out[0]?.msg || []).map(i => i.type)
    check('h.at / h.img 正确映射成 JiuLi segment', () => {
      assert.ok(types.includes('at'), `types=${types}`)
      assert.ok(types.includes('image'), `types=${types}`)
      assert.equal(out[0].msg.find(i => i.type === 'at')?.qq, '20000')
      assert.equal(out[0].msg.find(i => i.type === 'image')?.file, 'https://example.com/a.png')
    })
  }

  // 5) 无关消息不拦截
  {
    const { handled, sent: out } = await dispatch('这不是任何指令')
    check('Koishi 没处理的消息不拦截', () => assert.equal(handled, false))
    check('Koishi 没处理时不乱发消息', () => assert.equal(out.length, 0))
  }

  // 6) 入站元素：@ 与图片
  {
    sent.length = 0
    const e = makeEvent('jl测试', {
      message: [{ type: 'at', qq: '10000' }, { type: 'text', text: 'jl测试 hi' }],
      msg: 'jl测试 hi',
      atBot: true,
    })
    const u = jiuLiToUniversal(e)
    check('入站 at 映射为 Koishi at 元素', () => {
      assert.equal(u.elements[0].type, 'at')
      assert.equal(u.elements[0].id, '10000')
    })
  }

  await host.stop()
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
  process.exit(failed ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
