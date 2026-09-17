/**
 * TRSS-Plugin Code 模板验证（可选用例）
 *
 * 命令输出里的超长串（base64、XML）必须能在框内换行，否则会把面板撑宽、
 * 截图右侧被裁掉。插件目录可用 TRSS_PLUGIN_DIR 指定，不存在则跳过。
 *
 * 用法：node test/trss-template.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

for (const dir of ['logs', 'data', 'temp']) fs.mkdirSync(dir, { recursive: true })
const { default: JiuLiBot } = await import('../lib/core/bot.js')
const { injectGlobals } = await import('../lib/core/globals.js')
const { ensureDirs } = await import('../lib/core/start.js')
const { redisInit } = await import('../lib/core/redis.js')
await ensureDirs()
await injectGlobals(new JiuLiBot())
await redisInit()

const PLUGIN = (process.env.TRSS_PLUGIN_DIR || 'D:/yunzaibot/JiuLi/jiuli/plugins/TRSS-Plugin').split('\\').join('/')
const tplDir = `${PLUGIN}/Resources/Code`
if (!fs.existsSync(path.join(tplDir, 'Code.html'))) {
  console.log(`⏭️  未找到 TRSS-Plugin 的 Code 模板（${tplDir}），跳过`)
  process.exit(0)
}
const tpl = fs.readFileSync(path.join(tplDir, 'Code.html'), 'utf8')

/** 还原截图里的那种内容：超长 base64 + 一行超长 XML + 正常行 */
const base64 = 'JABQAHIA' + 'bwBnAHIAZQBzAHM'.repeat(14)
const Code =
  `<span class="ansi-red-fg">❌ 远程命令错误:</span>\n` +
  `Error: Command failed: powershell -EncodedCommand ${base64}\n` +
  `&lt;# CLIXML\n&lt;Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">&lt;S S="Error">Get-Process : Cannot find a process with the name "notepad"&lt;/S>&lt;/Objs>\n` +
  `<span class="ansi-green-fg">✓ 正常的一行输出</span>`

const html = tpl
  .replaceAll('{{htmlDir}}', `file:///${tplDir.split('\\').join('/')}/`)
  .replace('{{@Code}}', Code)
  .replaceAll('{{sysMem}}', '8.5').replaceAll('{{sysCpu}}', '12').replaceAll('{{sysPing}}', '35')

const outDir = path.resolve('test/.tmp-code')
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
const pageFile = path.join(outDir, 'index.html')
fs.writeFileSync(pageFile, html)

const renderService = (await import('../lib/core/render/index.js')).default
const browser = await renderService.browserInit()
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
await page.goto(`file:///${pageFile.split('\\').join('/')}`, { waitUntil: 'networkidle0' })

const box = await page.evaluate(() => {
  const code = document.querySelector('.code-box')
  const panel = document.querySelector('.system-panel')
  const body = document.body
  return {
    codeScroll: code.scrollWidth,
    codeClient: code.clientWidth,
    panelWidth: panel.getBoundingClientRect().width,
    bodyScroll: body.scrollWidth,
  }
})
const img = await page.screenshot({ fullPage: true })
fs.writeFileSync(path.join(outDir, 'render.png'), img)
await page.close()

const ok = box.codeScroll <= box.codeClient + 1 && box.bodyScroll <= 951
console.log('检测结果:', JSON.stringify(box))
console.log(`超长行是否会溢出：${ok ? '✅ 不会（内容在框内换行）' : '❌ 仍会溢出'}`)
console.log(`出图大小：${(img.length / 1024).toFixed(1)}KB · 图片：test/.tmp-code/render.png`)
