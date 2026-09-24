/**
 * 生态兼容层 · 真实内核集成测试
 *
 * 与前三个单元测试的区别：这里不直接调宿主，而是启动真实 JiuLi 内核
 * （loader.load + loadEvents + Bot 事件总线 + Mock 适配器），走完整链路：
 *
 *   Mock 适配器 → Bot.em('message.private.friend') → lib/events/message.js → loader.deal(e)
 *     → 补全 e.msg / 权限 / 别名 → beforeMessage 钩子（plugins/compat）→ 三个生态宿主
 *     → 外来插件回复 → e.reply → Mock 适配器记录
 *
 * 同时验证「拦截」语义：同一个指令云崽插件也写了规则，兼容层命中后云崽插件不应再回复。
 *
 * 跑：node test/compat-integration.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

process.env.JIULI_CONFIG_DIR = 'test/.tmp-compat-cfg/'
process.env.JIULI_GS_COMPAT_DATA = 'test/.tmp-gs-compat-data'
const PLUGINS_DIR = '.tmp-plugins-compat'
process.env.JIULI_PLUGINS_DIR = PLUGINS_DIR

for (const d of ['test/.tmp-compat-cfg', 'test/.tmp-gs-compat-data', PLUGINS_DIR]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync('test/.tmp-compat-cfg', { recursive: true })
fs.mkdirSync(PLUGINS_DIR, { recursive: true })
fs.mkdirSync(path.join(PLUGINS_DIR, 'node_modules'), { recursive: true })

/** 兼容目录直接 junction 过来（不复制：里面有 koishi 的 node_modules，复制太慢） */
try {
  fs.symlinkSync(path.resolve('plugins/compat'), path.join(PLUGINS_DIR, 'compat'), 'junction')
} catch (err) {
  console.error('无法为 plugins/compat 建立 junction：', err?.message)
  process.exit(1)
}

const copyTree = (from, to) => {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.isSymbolicLink()) continue
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dest)
    else fs.copyFileSync(src, dest)
  }
}
for (const dir of ['adapter']) copyTree(path.join('plugins', dir), path.join(PLUGINS_DIR, dir))

/* 配置 */
fs.writeFileSync(
  'test/.tmp-compat-cfg/bot.yaml',
  'log_level: info\nplugin_load_timeout: 40\nfile_watch: false\nlog_msg: true\nno_handler_tip: false\n',
)
fs.writeFileSync('test/.tmp-compat-cfg/other.yaml', 'master:\n  - "mock:10001"\n')
fs.writeFileSync(
  'test/.tmp-compat-cfg/compat.yaml',
  ['enabled: true', 'timeout_ms: 10000', 'intercept: true', 'ecosystems:', '  koishi:', '    enabled: true', '  gscore:', '    enabled: true', '  astrbot:', '    enabled: true', ''].join('\n'),
)

/* 云崽插件探针：与外来插件抢同一个指令 */
fs.mkdirSync(path.join(PLUGINS_DIR, '探针'), { recursive: true })
fs.writeFileSync(
  path.join(PLUGINS_DIR, '探针', 'index.js'),
  `import { JiuLiPlugin } from 'jiuli'
export default class CompatProbe extends JiuLiPlugin {
  constructor() {
    super({
      name: '兼容探针',
      dsc: '与外来插件抢同一指令',
      rule: [
        { reg: '^jl测试', fnc: 'koishiProbe' },
        { reg: '^gs查询深渊', fnc: 'gsProbe' },
        { reg: '^#探针$', fnc: 'alive' },
      ],
    })
  }
  async koishiProbe() { return this.reply('[云崽插件] 也匹配到了 jl测试') }
  async gsProbe() { return this.reply('[云崽插件] 也匹配到了 gs查询深渊') }
  async alive() { return this.reply('[云崽插件] 探针存活') }
}
`,
)

/* 运行 */
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

for (const dir of ['logs', 'data', 'temp']) fs.mkdirSync(dir, { recursive: true })

const { default: JiuLiBot } = await import('../lib/core/bot.js')
const { injectGlobals } = await import('../lib/core/globals.js')
const { ensureDirs } = await import('../lib/core/start.js')
const { redisInit } = await import('../lib/core/redis.js')
await ensureDirs()
const bot = new JiuLiBot()
await injectGlobals(bot)
await redisInit()

const loader = (await import('../lib/core/loader.js')).default
const { loadEvents } = await import('../lib/core/events.js')
const compat = (await import('../lib/compat/index.js')).compat

const startedAt = Date.now()
await loader.load()
await loadEvents()
bot.emit('online', bot)

/** 等三个宿主就绪（koishi 首次 import + 两个 Python 进程启动都要时间） */
let status
for (let i = 0; i < 60; i++) {
  await sleep(1000)
  status = compat.status()
  if (status.hosts.length >= 3 && status.hosts.every(h => (h.plugins ?? 0) > 0)) break
}
check(
  '三个生态宿主都加载到插件',
  status?.hosts?.length >= 3 && status.hosts.every(h => (h.plugins ?? 0) > 0),
  JSON.stringify(status?.hosts?.map(h => `${h.id}:${h.plugins ?? 0}`)),
)
check('宿主启动未报错', status?.hosts?.every(h => h.ok !== false), JSON.stringify(status?.hosts?.map(h => h.error).filter(Boolean)))
check(`宿主就绪耗时 ${Math.round((Date.now() - startedAt) / 1000)}s（含插件加载）`, true)

const emit = globalThis.__jiuli_mock_emit
const SENT = globalThis.__jiuli_mock_sent
const textOf = rec =>
  (Array.isArray(rec?.msg) ? rec.msg : [rec?.msg])
    .map(m => (typeof m === 'string' ? m : m?.type === 'text' ? m.text : ''))
    .join('')

const say = async (msg, extra = {}) => {
  SENT.length = 0
  emit({ user_id: '10001', msg, ...extra })
  await sleep(1500)
  return SENT.map(textOf)
}

/* 1. Koishi */
{
  const out = await say('jl测试 你好')
  check('Koishi 插件在真实分发链路里被触发', out.some(t => /Koishi 插件收到：你好/.test(t)), JSON.stringify(out))
  check('Koishi 命中后拦截云崽插件（不双回复）', !out.some(t => /云崽插件/.test(t)), JSON.stringify(out))
}

/* 2. GsCore */
{
  const out = await say('gs查询深渊 5层')
  check('GsCore 插件在真实分发链路里被触发', out.some(t => /GsCore 查询深渊：5层/.test(t)), JSON.stringify(out))
  check('GsCore 命中后拦截云崽插件', !out.some(t => /云崽插件/.test(t)), JSON.stringify(out))
}
{
  const out = await say('查询深渊 5层')
  check('GsCore 前缀展开（无前缀写法）也生效', out.some(t => /GsCore 查询深渊：5层/.test(t)), JSON.stringify(out))
}

/* 3. AstrBot */
{
  const out = await say('astr命令 小明')
  check('AstrBot 插件在真实分发链路里被触发', out.some(t => /你好 小明！/.test(t)), JSON.stringify(out))
}

/* 4. 不拦截无关消息：云崽插件照常响应 */
{
  const out = await say('#探针')
  check('无关消息仍由云崽插件处理', out.some(t => /探针存活/.test(t)), JSON.stringify(out))
}

/* 5. 外来插件都不认识的消息：不拦截、不报错 */
{
  const out = await say('一句谁都不认识的话')
  check('无人认识的消息不产生回复', out.length === 0, JSON.stringify(out))
}

await compat.stop()
bot.watcherClose?.()

const failed = results.filter(r => !r.ok).length
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
