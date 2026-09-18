/**
 * hl-ai-plugin 图片内联验证（可选用例）
 *
 * 带图提问时不能把 QQ 的临时链接（带 rkey，会过期）直接交给模型服务商，
 * 否则对方下载失败 → 400 Failed to download image。这里验证插件会本机取回并转成 data URI。
 * 插件目录可用 HL_AI_PLUGIN 指定，依赖未安装则跳过。
 *
 * 用法：node test/hl-ai-image.mjs
 */
const PLUGIN = process.env.HL_AI_PLUGIN || 'D:/yunzaibot/JiuLi/jiuli/plugins/hl-ai-plugin'

for (const dir of ['logs', 'data', 'temp']) await import('node:fs').then(fs => fs.mkdirSync(dir, { recursive: true }))
const { default: JiuLiBot } = await import('../lib/core/bot.js')
const { injectGlobals } = await import('../lib/core/globals.js')
await injectGlobals(new JiuLiBot())

const { inlineRemoteImage } = await import(`file:///${PLUGIN.split('\\').join('/')}/src/services/llm/ChatService.js`).catch(err => {
  console.log(`⏭️  hl-ai-plugin 依赖未安装（${err.code || err.message}），跳过`)
  process.exit(0)
})

const results = []
const check = (name, ok, extra) => {
  results.push({ ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

/** 真实可访问的图片（QQ 头像） */
const url = 'https://q1.qlogo.cn/g?b=qq&s=100&nk=3610159055'
const dataUrl = await inlineRemoteImage(url)
check('远程图片被转成 data URI', dataUrl.startsWith('data:image/'), dataUrl.slice(0, 40))
check('内容确实是图片且非空', dataUrl.length > 1000, `${(dataUrl.length / 1024).toFixed(1)}KB（base64）`)
check('取不到时退回原链接（不抛错）', (await inlineRemoteImage('https://example.invalid/nope.png')) === 'https://example.invalid/nope.png')
check('非 HTTP 输入原样返回', (await inlineRemoteImage('data:image/png;base64,AAA')) === 'data:image/png;base64,AAA')

const pass = results.filter(r => r.ok).length
console.log(`\n=== 图片内联验证：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
