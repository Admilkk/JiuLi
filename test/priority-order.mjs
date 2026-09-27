/**
 * 插件 priority 异常时不能打乱分发顺序
 *
 * 背景：`sortPriority()` 原来是 `a.priority - b.priority || order 比较`。
 * 只要有一个条目的 priority 是 `undefined`（插件漏传，或占位 / 降级类没设这个字段），
 * `undefined - 数字 = NaN`，而 NaN 是假值 → `||` 兜到 order 比较 ——
 * 该条目与任何人比较都退化成按 order 比，**比较函数不再满足传递性**
 * （实测 `卸载枫叶(-1e42) < placeholder(undefined) < atme更新(-Infinity)`，
 * 但 `cmp(卸载枫叶, atme更新) = Infinity`）。V8 的 sort 在比较函数不一致时结果不可预测，
 * 会把整张表的顺序打乱 —— 表现为「某条指令被别的插件抢走」，且没有任何报错。
 *
 * 实测案例：xhh-TL 的降级占位类没设 priority，导致 `#体力`（-999）被
 * genshin 的 `体力查询`（300）抢走，317 条条目里 304 条错位。
 *
 * 本测试覆盖：
 *   A. 纯函数口径：priorityRank 只兜 NaN 类输入，保留 ±Infinity
 *   B. 端到端：夹具插件漏传 priority + 一个 -999 的插件 → -999 仍先匹配
 *   C. 回归：-Infinity / 数字 / 同优先级按加载顺序，行为都不变
 *
 * 用法：node test/priority-order.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

process.env.JIULI_CONFIG_DIR = 'test/.tmp-prio-cfg/'
const PLUGINS_DIR = '.tmp-plugins-prio'
process.env.JIULI_PLUGINS_DIR = PLUGINS_DIR

for (const d of ['test/.tmp-prio-cfg', PLUGINS_DIR]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync('test/.tmp-prio-cfg', { recursive: true })
fs.mkdirSync(path.join(PLUGINS_DIR, 'example'), { recursive: true })

/** 只放内置 + 适配器，够走完加载与一次分发 */
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
for (const dir of ['system', 'other', 'adapter'])
  if (fs.existsSync(path.join('plugins', dir))) copyTree(path.join('plugins', dir), path.join(PLUGINS_DIR, dir))
fs.mkdirSync(path.join(PLUGINS_DIR, 'node_modules'), { recursive: true })
try {
  fs.symlinkSync(path.resolve('.'), path.join(PLUGINS_DIR, 'node_modules', 'jiuli'), 'junction')
} catch {}

fs.writeFileSync('test/.tmp-prio-cfg/bot.yaml', 'log_level: info\nplugin_load_timeout: 20\nfile_watch: false\n')
fs.writeFileSync('test/.tmp-prio-cfg/other.yaml', 'master:\n  - "mock:10001"\n')
fs.writeFileSync('test/.tmp-prio-cfg/group.yaml', 'default:\n  groupCD: 0\n  singleCD: 0\n  onlyReplyAt: 0\n')

/* ---------- 夹具插件 ---------- */
/**
 * 关键夹具：**故意不传 priority**，模拟「插件漏传 / 占位降级类没设这个字段」。
 * 修复前它会让整个排序失去传递性。
 */
fs.writeFileSync(
  path.join(PLUGINS_DIR, 'example', '漏传优先级.js'),
  `import { JiuLiPlugin } from 'jiuli'
export default class NoPrio extends JiuLiPlugin {
  constructor() {
    super({ name: '漏传优先级的插件', dsc: 'no-prio', rule: [{ reg: '^#抢指令$', fnc: 'hi' }] })
  }
  async hi() { return this.reply('漏传优先级的插件接走了') }
}
`,
)

/** 低优先级（-999）插件：应当先于默认优先级匹配同一条指令 */
fs.writeFileSync(
  path.join(PLUGINS_DIR, 'example', '低优先级.js'),
  `import { JiuLiPlugin } from 'jiuli'
export default class LowPrio extends JiuLiPlugin {
  constructor() {
    super({ name: '低优先级插件', dsc: 'low', priority: -999, rule: [{ reg: '^#抢指令$', fnc: 'hi' }] })
  }
  async hi() { return this.reply('低优先级插件接走了') }
}
`,
)

/** 默认优先级（不传 → 基类 5000）的插件，排在低优先级之后 */
fs.writeFileSync(
  path.join(PLUGINS_DIR, 'example', '默认优先级.js'),
  `import { JiuLiPlugin } from 'jiuli'
export default class DefPrio extends JiuLiPlugin {
  constructor() {
    super({ name: '默认优先级插件', dsc: 'def', rule: [{ reg: '^#抢指令$', fnc: 'hi' }] })
  }
  async hi() { return this.reply('默认优先级插件接走了') }
}
`,
)

/** -Infinity 是生态惯例，必须原样保留（不能被兜成 5000） */
fs.writeFileSync(
  path.join(PLUGINS_DIR, 'example', '负无穷优先级.js'),
  `import { JiuLiPlugin } from 'jiuli'
export default class InfPrio extends JiuLiPlugin {
  constructor() {
    super({ name: '负无穷优先级插件', dsc: 'inf', priority: -Infinity, rule: [{ reg: '^#抢指令$', fnc: 'hi' }] })
  }
  async hi() { return this.reply('负无穷优先级插件接走了') }
}
`,
)

/** 显式传 undefined：与漏传等价，同样不能打乱排序 */
fs.writeFileSync(
  path.join(PLUGINS_DIR, 'example', '显式undefined.js'),
  `import { JiuLiPlugin } from 'jiuli'
export default class UndefPrio extends JiuLiPlugin {
  constructor() {
    super({ name: '显式undefined插件', dsc: 'undef', priority: undefined, rule: [{ reg: '^#抢指令$', fnc: 'hi' }] })
  }
  async hi() { return this.reply('显式undefined插件接走了') }
}
`,
)

/* ---------- 运行环境 ---------- */
const lines = []
const origLog = console.log
const push = (args, orig) => {
  lines.push(args.map(String).join(' ').replace(/\u001b\[[0-9;]*m/g, ''))
  orig(...args)
}
console.log = (...a) => push(a, origLog)

for (const dir of ['logs', 'data', 'temp']) fs.mkdirSync(dir, { recursive: true })

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

/* ---------- A. 纯函数口径 ---------- */
/**
 * 旧版本（未修复）没有导出 priorityRank，import 会失败。
 * 这里优雅降级成「恒等函数」，让后面的用例明确失败，而不是整个脚本崩掉 ——
 * 这样在未修复的代码上跑，能直接看到是哪几条不通过。
 */
const loaderMod = await import('../lib/core/loader.js')
const priorityRank = loaderMod.priorityRank ?? (n => n)

console.log('\n======== A. priorityRank：只兜 NaN 类输入 ========')
check(
  '框架导出了 priorityRank（修复已应用）',
  typeof loaderMod.priorityRank === 'function',
  typeof loaderMod.priorityRank === 'function' ? '' : '未导出 → 跑的是未修复版本',
)
check('undefined → 5000', priorityRank(undefined) === 5000, String(priorityRank(undefined)))
check('null → 5000', priorityRank(null) === 5000, String(priorityRank(null)))
check('NaN → 5000', priorityRank(NaN) === 5000, String(priorityRank(NaN)))
check('字符串 → 5000', priorityRank('100') === 5000, String(priorityRank('100')))
check('⚠️ -Infinity 原样保留（生态惯例，不能兜）', priorityRank(-Infinity) === -Infinity, String(priorityRank(-Infinity)))
check('⚠️ Infinity 原样保留', priorityRank(Infinity) === Infinity, String(priorityRank(Infinity)))
check('-999 原样保留', priorityRank(-999) === -999, String(priorityRank(-999)))
check('0 原样保留', priorityRank(0) === 0, String(priorityRank(0)))

/* ---------- B. 端到端 ---------- */
const { default: JiuLiBot } = await import('../lib/core/bot.js')
const { injectGlobals } = await import('../lib/core/globals.js')
const { ensureDirs } = await import('../lib/core/start.js')
const { redisInit } = await import('../lib/core/redis.js')
await ensureDirs()
const bot = new JiuLiBot()
await injectGlobals(bot)
await redisInit()

const loader = (await import('../lib/core/loader.js')).default
await loader.load()

const { listenerLoader } = await import('../lib/core/events.js')
await listenerLoader.loadEvent('message.js')
const mock = (bot.adapter || []).find(a => a.name === 'Mock')
await mock.load()
const emit = globalThis.__jiuli_mock_emit
const sent = () => (globalThis.__jiuli_mock_sent || []).map(i => (typeof i.msg === 'string' ? i.msg : JSON.stringify(i.msg)))
const sleep = ms => new Promise(r => setTimeout(r, ms))

console.log('\n======== B. 分发顺序：优先级小的先接走指令 ========')
check(
  '漏传优先级的夹具已加载',
  loader.priority.some(i => i.name === '漏传优先级的插件'),
  loader.priority.some(i => i.name === '漏传优先级的插件') ? '' : '未加载',
)

/** 模拟一次真实分发，看谁先接走 */
const whoTakesIt = async () => {
  ;(globalThis.__jiuli_mock_sent || []).length = 0
  emit({ type: 'message', group_id: 'mock:88001', user_id: '10001', msg: '#抢指令' })
  await sleep(2500)
  return sent().join(' | ')
}

const reply = await whoTakesIt()
console.log('  #抢指令 的回复：', reply || '（无）')
check(
  '⚠️ -Infinity 插件先接走（不被漏传优先级的条目挤掉）',
  reply.includes('负无穷优先级插件接走了'),
  reply || '（无回复）',
)

/** 直接看排序后的表：确认没有任何相邻逆序 */
const seq = loader.priority.map(i => ({ name: i.name, p: i.priority, r: priorityRank(i.priority) }))
let inversions = 0
for (let i = 1; i < seq.length; i++) if (seq[i - 1].r > seq[i].r) inversions++
check('排序后全表无逆序', inversions === 0, `逆序点 = ${inversions}`)

/**
 * ⚠️ 核心契约：排序用的比较函数必须满足**传递性**。
 *
 * 这才是 bug 的本质 —— 一旦有条目 priority 是 undefined，
 * `a.priority - b.priority` 算出 NaN，`||` 退化成按 order 比，于是出现
 * 「A<B 且 B<C 但 A>C」这种自相矛盾的结论。V8 的 sort 在比较函数不一致时
 * **结果不可预测**（小数组可能碰巧排对，所以只靠端到端断言抓不稳），
 * 必须直接对比较函数本身做传递性扫描。
 *
 * 扫描对象 = 真实加载的表 **+ 三行确定性构造**。
 * 只扫真实表不够：违例需要「order 小但 priority 大」的 A 与「order 大但 priority 小」
 * 的 C 把漏传条目 B 夹在中间，而真实夹具的加载顺序不保证凑齐这个形状。
 * 构造这三行能让违例**必然**出现，从而证明测试确实盯着这个 bug。
 */
{
  const oldCmp = (a, b) => a.p - b.p || (a.o ?? 0) - (b.o ?? 0)
  const newCmp = (a, b) => priorityRank(a.p) - priorityRank(b.p) || (a.o ?? 0) - (b.o ?? 0)

  /** 真实表 */
  const rows = loader.priority.map(i => ({ n: i.name, p: i.priority, o: i.order }))
  const undefCount = rows.filter(r => typeof r.p !== 'number' || Number.isNaN(r.p)).length
  console.log(`  表内 priority 非数字的条目 = ${undefCount}（夹具漏传 / 显式 undefined）`)

  /**
   * 确定性构造：A 的 order 最小但 priority 大，C 的 order 最大但 priority 小，
   * B（漏传）夹在中间。
   *   oldCmp(A,B)：300-undefined=NaN → 按 order → 1<2 → A<B
   *   oldCmp(B,C)：undefined-(-999)=NaN → 按 order → 2<3 → B<C
   *   oldCmp(A,C)：300-(-999)=1299 → A>C  ← 与上面矛盾，违例
   */
  const crafted = [
    { n: '__A_order小priority大', p: 300, o: 1 },
    { n: '__B_漏传', p: undefined, o: 2 },
    { n: '__C_order大priority小', p: -999, o: 3 },
  ]

  const scan = (cmp, list) => {
    let violations = 0
    const sample = []
    const n = list.length
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j || !(cmp(list[i], list[j]) < 0)) continue
        for (let k = 0; k < n; k++) {
          if (k === i || k === j) continue
          if (cmp(list[j], list[k]) < 0 && !(cmp(list[i], list[k]) < 0)) {
            violations++
            if (sample.length < 2)
              sample.push(`${list[i].n}(${list[i].p}) < ${list[j].n}(${list[j].p}) < ${list[k].n}(${list[k].p})`)
          }
        }
      }
    }
    return { violations, sample }
  }

  const craftedOld = scan(oldCmp, crafted)
  check(
    '夹具确实能触发 bug：旧口径（裸减法）在构造数据上有传递性违例',
    craftedOld.violations > 0,
    craftedOld.violations ? `违例 ${craftedOld.violations} 组，例：${craftedOld.sample[0]}` : '无违例 → 测试没盯住 bug',
  )
  check(
    '修复后：旧口径的违例在新口径下消失',
    scan(newCmp, crafted).violations === 0,
    `新口径违例 ${scan(newCmp, crafted).violations} 组`,
  )

  const realOld = scan(oldCmp, rows)
  const realNew = scan(newCmp, rows)
  console.log(`  真实表违例：旧口径 ${realOld.violations} 组 / 新口径 ${realNew.violations} 组`)
  check(
    '⚠️ 真实插件表在修复后无传递性违例',
    realNew.violations === 0,
    realNew.violations ? `违例 ${realNew.violations} 组，例：${realNew.sample[0]}` : '违例 0 组',
  )
}

/** 关键断言：漏传优先级的条目必须排在 -999 之后、与默认档同档 */
const iInf = seq.findIndex(x => x.name === '负无穷优先级插件')
const iLow = seq.findIndex(x => x.name === '低优先级插件')
const iNoPrio = seq.findIndex(x => x.name === '漏传优先级的插件')
const iDef = seq.findIndex(x => x.name === '默认优先级插件')
const iUndef = seq.findIndex(x => x.name === '显式undefined插件')
console.log(`  位置：负无穷=${iInf} 低优先级(-999)=${iLow} 漏传=${iNoPrio} 默认=${iDef} 显式undefined=${iUndef}`)
check('负无穷 排在 低优先级(-999) 之前', iInf >= 0 && iLow >= 0 && iInf < iLow, `${iInf} < ${iLow}`)
check('低优先级(-999) 排在 漏传 之前', iLow >= 0 && iNoPrio >= 0 && iLow < iNoPrio, `${iLow} < ${iNoPrio}`)
check('漏传 与 默认优先级 同档（都在 5000）', priorityRank(seq[iNoPrio]?.p) === priorityRank(seq[iDef]?.p), `${seq[iNoPrio]?.p} vs ${seq[iDef]?.p}`)
check('显式 undefined 与漏传等价', priorityRank(seq[iUndef]?.p) === priorityRank(seq[iNoPrio]?.p), `${seq[iUndef]?.p} vs ${seq[iNoPrio]?.p}`)

/** 再验一次：把漏传条目临时改成极小值，它应该立刻插到 -999 之前（说明排序真的在按 priority 走） */
{
  const entry = loader.priority.find(i => i.name === '漏传优先级的插件')
  entry.priority = -99999
  loader.sortPriority()
  const after = loader.priority.map(i => i.name)
  const idxMoved = after.indexOf('漏传优先级的插件')
  const idxLow = after.indexOf('低优先级插件')
  const idxInf = after.indexOf('负无穷优先级插件')
  check(
    '改小 priority 后重新排序立即生效',
    idxMoved >= 0 && idxLow >= 0 && idxMoved < idxLow,
    `漏传=${idxMoved} 低优先级=${idxLow}（-99999 仍大于 -Infinity，故负无穷=${idxInf} 仍在最前）`,
  )
  entry.priority = undefined
  loader.sortPriority()
}

/* ---------- 汇总 ---------- */
const failed = results.filter(r => !r.ok)
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('失败用例：')
  for (const f of failed) console.log('  ·', f.name)
}
process.exit(failed.length ? 1 : 0)
