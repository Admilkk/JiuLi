/**
 * 服务器侧：验证渲染链路（含浏览器自动安装）
 * 只做一次截图，不启动适配器
 */
import fs from 'node:fs'

for (const dir of ['logs', 'data', 'temp', 'resources']) fs.mkdirSync(dir, { recursive: true })
const { default: JiuLiBot } = await import('../lib/core/bot.js')
const { injectGlobals } = await import('../lib/core/globals.js')
const { ensureDirs } = await import('../lib/core/start.js')
const { redisInit } = await import('../lib/core/redis.js')
await ensureDirs()
const bot = new JiuLiBot()
await injectGlobals(bot)
await redisInit()

const { default: renderService } = await import('../lib/core/render/index.js')
await renderService.load()
console.log('已加载渲染后端：', [...renderService.renderers.keys()].join(', ') || '（无）')

/** 走插件自己的 render()，和真实指令完全同一条路（插件 key 决定模板目录） */
const { default: RenderDemo } = await import('../plugins/demo/render-demo.js')
const inst = new RenderDemo()
inst.__key = 'demo'

const t = Date.now()
const img = await inst.render('card/index', {
  name: '渲染自检',
  firstChar: '渲',
  title: '服务器渲染验证',
  time: new Date().toLocaleString('zh-CN', { hour12: false }),
  stats: [
    { label: '中文', value: '测试' },
    { label: '模板', value: 'card/index' },
  ],
})
const cost = Date.now() - t
if (!img) {
  console.log(`\n❌ 渲染失败（${cost}ms）—— 见上方 [  Render  ] 日志`)
  process.exit(1)
}
const file = typeof img === 'string' ? img : img?.file
/** file 可能是 Buffer（内联图片），别直接打印，否则终端全是乱码 */
const size = Buffer.isBuffer(file)
  ? file.length
  : file && fs.existsSync(file)
    ? fs.statSync(file).size
    : JSON.stringify(img).length
console.log(`\n✅ 渲染成功 · 用时 ${cost}ms · 产物 ${(size / 1024).toFixed(1)}KB`)
console.log('   若刚才日志里有 [  Render  ] 自动安装 一行，说明框架帮你把浏览器补上了')
process.exit(0)
