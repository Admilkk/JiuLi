/**
 * Koishi 兼容层自测插件（CJS 形态，和绝大多数真实 koishi-plugin-* 一致）
 *
 * 覆盖三种典型写法：
 *   - ctx.command(...).action(...)：指令
 *   - ctx.on('message', ...) + session.send(...)：原始监听
 *   - ctx.middleware(...)：中间件，且用 session.content 读文本、session.quote 读引用
 */
module.exports = {
  name: 'jiuli-test',
  apply(ctx) {
    ctx.command('jl测试 [text:text]', 'JiuLi Koishi 桥接自测').action((argv, text) => {
      return `Koishi 插件收到：${text ?? '(空)'}`
    })

    ctx.command('jl图片', '元素出站自测').action(() => {
      const { h } = require('koishi')
      return h('text', { content: '图文混排' }) + h.at('20000') + h.img('https://example.com/a.png')
    })

    ctx.on('message', session => {
      if (session.content === 'koishi监听') session.send('监听命中')
    })

    ctx.middleware((session, next) => {
      if (session.content === 'koishi中间件') return '中间件命中'
      return next()
    })
  },
}
