/**
 * 服务器侧：验证渲染链路（含浏览器自动安装）
 * 只做一次截图，不启动适配器
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()

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

/** 云崽插件会 import lib/puppeteer/puppeteer.js 后自己 newPage 截图 */
const { default: puppeteer } = await import('../lib/puppeteer/puppeteer.js')
console.log(
  `\n浏览器接口：browserInit ${typeof puppeteer.browserInit} · browserIsOpen ${puppeteer.browserIsOpen} · screenshot ${typeof puppeteer.screenshot}`,
)
const browser = await puppeteer.browserInit()
if (!browser || typeof browser.newPage !== 'function') {
  console.log('❌ puppeteer.browserInit() 没返回可用的浏览器实例（插件自己截图会报 not a function）')
  process.exit(1)
}
const page = await browser.newPage()
await page.setContent('<h1>插件自截图</h1>')
const shot = await page.screenshot()
console.log(`✅ 插件自截图可用 · ${(shot.length / 1024).toFixed(1)}KB`)

/**
 * emoji 字体自检：彩色 emoji 画出来是带颜色的，缺字体时的豆腐块是单色的。
 * 缺字体不会报错，只会在图里显示成方块（插件里的 👑 / 💬 就踩过这个坑）。
 */
const colored = await page.evaluate(() => {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  ctx.font = '48px sans-serif'
  ctx.textBaseline = 'top'
  ctx.fillText('👑', 0, 0)
  const data = ctx.getImageData(0, 0, 64, 64).data
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
    if (a > 0 && Math.max(r, g, b) - Math.min(r, g, b) > 40) n++
  }
  return n
})
await page.close()
if (!colored) {
  console.log('❌ emoji 渲染成单色（豆腐块）—— 系统缺 emoji 字体')
  console.log('   Debian/Ubuntu：apt-get install -y fonts-noto-color-emoji')
  console.log('   CentOS/RHEL：yum install -y google-noto-color-emoji-fonts')
  process.exit(1)
}
console.log(`✅ emoji 字体可用 · 👑 彩色像素 ${colored} 个`)

/**
 * snap 版浏览器必须被自动跳过
 *
 * snap 沙箱读不到 --user-data-dir，截图会缺内容 / 白屏而且不报错；
 * 自动选择时一律跳过（/snap/bin/* 及指向 snap 启动器的软链），只有显式配置才照用。
 */
const { default: PuppeteerRenderer, isSnapBrowser } = await import('../renderers/puppeteer/lib/puppeteer.js')
const snapCases = [
  ['/snap/bin/chromium', true],
  ['/var/lib/snapd/snap/bin/chromium', true],
  ['/snap/chromium/1234/usr/lib/chromium-browser/chrome', true],
  ['/usr/bin/google-chrome', false],
  ['/usr/lib/chromium/chromium', false],
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', false],
]
const snapWrong = []
for (const [p, want] of snapCases) if ((await isSnapBrowser(p)) !== want) snapWrong.push(`${p} → ${!want}`)
if (snapWrong.length) {
  console.log(`❌ snap 浏览器识别不对：${snapWrong.join('; ')}`)
  process.exit(1)
}
console.log(`✅ snap 浏览器识别正确（${snapCases.length} 个路径样例，自动选择会跳过 snap）`)

/** renderers 下的 config.yaml 必须是「用户文件」：不入库，才能保证 #更新 不覆盖用户改动 */
try {
  const tracked = execFileSync('git', ['ls-files', 'renderers/*/config.yaml'], { cwd: ROOT })
    .toString()
    .trim()
  if (tracked) {
    console.log(`❌ 这些渲染配置被 git 跟踪了（#更新 会覆盖用户改动）：${tracked.replace(/\n/g, ' ')}`)
    process.exit(1)
  }
  console.log('✅ renderers/*/config.yaml 未被 git 跟踪（首次运行从 config_default.yaml 复制）')
} catch {
  console.log('⏭️  跳过「渲染配置是否入库」检查（当前目录不是 git 仓库）')
}

/**
 * 空闲回收回归：过去这里写的是 browser.removeListener（Browser 没有这个方法），
 * 抛错后浏览器永远关不掉 —— 内存越吃越多，新装的字体也一直不生效。
 */
console.log(`\n浏览器事件接口：off ${typeof browser.off} · removeListener ${typeof browser.removeListener}`)
const idle = new PuppeteerRenderer({ idleTime: 0.001 })
let closed = false
/** 故意只给 close：模拟没有 removeListener 的 Browser */
idle.browser = { close: async () => (closed = true), connected: true }
idle.resetIdleTimer()
await new Promise(r => setTimeout(r, 400))
if (!closed) {
  console.log('❌ 空闲回收没走到 close（浏览器不会被自动关闭）')
  process.exit(1)
}
console.log('✅ 空闲回收生效（超时后正常关闭浏览器）')
process.exit(0)
