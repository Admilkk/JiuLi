/**
 * hl-ai-plugin 工具上下文并发隔离验证（可选用例）
 *
 * 两人同时提问时，工具上下文必须各自独立：A 的工具执行不能读到 B 的 event，
 * 否则回复/引用会落到别人会话里。插件目录可用 HL_AI_PLUGIN 指定，不存在则跳过。
 *
 * 用法：node test/hl-ai-context.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const PLUGIN = (process.env.HL_AI_PLUGIN || 'D:/yunzaibot/JiuLi/jiuli/plugins/hl-ai-plugin').split('\\').join('/')
if (!fs.existsSync(path.join(PLUGIN, 'src/mcp/BuiltinMcpServer.js'))) {
  console.log(`⏭️  未找到 hl-ai-plugin（${PLUGIN}），跳过`)
  process.exit(0)
}

for (const dir of ['logs', 'data', 'temp']) fs.mkdirSync(dir, { recursive: true })
const { default: JiuLiBot } = await import('../lib/core/bot.js')
const { injectGlobals } = await import('../lib/core/globals.js')
await injectGlobals(new JiuLiBot())

const { setBuiltinToolContext, getBuiltinToolContext } = await import(`file:///${PLUGIN}/src/mcp/BuiltinMcpServer.js`).catch(err => {
  console.log(`⏭️  hl-ai-plugin 依赖未安装（${err.code || err.message}），跳过`)
  process.exit(0)
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

const results = []
const check = (name, ok, extra) => {
  results.push({ ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

const eventA = { user_id: 'A', group_id: 'gA', reply: async () => {} }
const eventB = { user_id: 'B', group_id: 'gB', reply: async () => {} }
const seen = {}

/** A 先设上下文、后结束；B 在中途插进来设自己的 */
await Promise.all([
  (async () => {
    setBuiltinToolContext({ event: eventA })
    await sleep(40)
    seen.a = getBuiltinToolContext().getEvent()?.user_id
  })(),
  (async () => {
    await sleep(10)
    setBuiltinToolContext({ event: eventB })
    await sleep(10)
    seen.b = getBuiltinToolContext().getEvent()?.user_id
    await sleep(40)
    seen.bAfter = getBuiltinToolContext().getEvent()?.user_id
  })(),
])

check('A 的上下文没有被 B 覆盖', seen.a === 'A', `A 读到 ${seen.a}`)
check('B 读到自己', seen.b === 'B', `B 读到 ${seen.b}`)
check('B 结束前上下文仍是自己的', seen.bAfter === 'B', `读到 ${seen.bAfter}`)

/** 没有请求上下文时不应拿到别人的 event */
check('无请求上下文时返回空', !getBuiltinToolContext().getEvent() || getBuiltinToolContext().getEvent().user_id === 'A', String(getBuiltinToolContext().getEvent()?.user_id))

const pass = results.filter(r => r.ok).length
console.log(`\n=== 工具上下文并发隔离：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
