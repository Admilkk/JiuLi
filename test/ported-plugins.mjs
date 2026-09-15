/**
 * 生态插件适配测试
 *
 * 验证从 TRSS-Yunzai 移植过来的插件能否加载并响应指令（不启动适配器/HTTP 服务，
 * 用内置 Mock 适配器注入消息，避免与正在运行的实例抢协议连接）。
 *
 * 用法：node test/ported-plugins.mjs
 */
import fs from 'node:fs'

process.env.JIULI_CONFIG_DIR = 'test/.tmp-ported/'
fs.rmSync('test/.tmp-ported', { recursive: true, force: true })
fs.mkdirSync('test/.tmp-ported', { recursive: true })
/** 生态插件冷启动很重，放宽加载超时；开 debug 便于排查 */
fs.writeFileSync(
  'test/.tmp-ported/bot.yaml',
  ['log_level: debug', 'plugin_load_timeout: 300', 'file_watch: false', 'log_msg: true', ''].join(
    String.fromCharCode(10),
  ),
)

const { default: JiuLiBot } = await import('../lib/core/bot.js')
const { injectGlobals } = await import('../lib/core/globals.js')
const { ensureDirs } = await import('../lib/core/start.js')
const { redisInit } = await import('../lib/core/redis.js')

for (const dir of ['logs', 'data', 'temp']) fs.mkdirSync(dir, { recursive: true })
await ensureDirs()

const bot = new JiuLiBot()
await injectGlobals(bot)
await redisInit()

const loader = (await import('../lib/core/loader.js')).default
const loadStart = Date.now()
await loader.load()
console.log(`\n插件加载完成 · ${loader.pluginCount} 个插件 · 用时 ${Date.now() - loadStart}ms`)

/** 手动启动 Mock 适配器（等价于 ListenerLoader 里做的 adapter.load()） */
const mock = (bot.adapter || []).find((a) => a.name === 'Mock')
if (!mock) {
  console.log('未找到 Mock 适配器（plugins/adapter/mock.js），跳过指令测试')
  process.exit(0)
}

/**
 * 只注册事件监听器，不加载适配器（避免连接真实协议端）
 * —— 消息要能被分发，必须让 lib/events/message.js 这类监听器挂上 Bot
 */
const { listenerLoader } = await import('../lib/core/events.js')
for (const file of ['message.js', 'notice.js', 'request.js']) await listenerLoader.loadEvent(file)

await mock.load()
const emit = globalThis.__jiuli_mock_emit
const sent = globalThis.__jiuli_mock_sent
const sleep = ms => new Promise(r => setTimeout(r, ms))

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

/** 轮询等待有响应（渲染类指令在负载高时可能要十几秒，固定 sleep 不可靠） */
const waitReply = async (timeout = 40000) => {
  const startAt = Date.now()
  while (Date.now() - startAt < timeout) {
    if (sent.length > 0) return true
    await sleep(500)
  }
  return sent.length > 0
}

/** [插件目录, 说明, 测试指令] */
const targets = [
  ['miao-plugin', '喵喵（miao-plugin）', '#喵喵帮助'],
  ['genshin', '原神/星铁（genshin）', '#攻略帮助'],
  ['yenai-plugin', '椰奶（yenai-plugin）', '#椰奶状态'],
  ['xiaofei-plugin', '小飞（xiaofei-plugin）', '#小飞帮助'],
  ['HMeme', 'H表情（HMeme）', '#H表情帮助'],
]

/** 预热渲染后端（首次启动 Chromium 在负载高时可能要几十秒，不计入用例） */
if (loader.priority.some(i => i.key === 'demo/render-demo.js')) {
  process.stdout.write('预热渲染后端')
  sent.length = 0
  emit({ type: 'message', group_id: '666000111', user_id: '10001', msg: '#渲染测试' })
  await waitReply(90000)
  console.log(` … ${sent.length ? '完成' : '未响应（后续渲染用例可能超时）'}`)
}

let groupSeq = 0
for (const [dir, label, cmd] of targets) {
  /** 每个插件用不同群号 + 留出冷却时间，避免踩默认群冷却（groupCD/singleCD） */
  const gid = `6660001${String(++groupSeq).padStart(2, '0')}`
  const installed = fs.existsSync(`plugins/${dir}`)
  if (!installed) {
    console.log(`⏭️  ${label} 未安装，跳过`)
    continue
  }
  const loaded = loader.priority.some(i => i.key.startsWith(dir))
  if (!loaded) {
    check(`${label} 加载`, false, '未出现在已加载插件列表')
    continue
  }
  await sleep(2500)
  sent.length = 0
  emit({ type: 'message', group_id: gid, user_id: '10001', msg: cmd })
  const replied = await waitReply()
  const out = JSON.stringify(sent)
  check(`${label} 响应「${cmd}」`, replied, out.slice(0, 70) || '（40 秒内无响应）')
}

fs.rmSync('test/.tmp-ported', { recursive: true, force: true })
const pass = results.filter(r => r.ok).length
console.log(`\n=== 生态插件适配测试：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
