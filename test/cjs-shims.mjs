/**
 * CJS 壳包在 require 侧也要可用
 *
 * node-fetch / md5 / oicq 被换成 ESM 实现（lib/modules/*）。只给 exports 的 import 条件时，
 * CJS 依赖里的 `require('md5')` / `require('node-fetch')` 拿到的是命名空间对象（不可调用），
 * 在 Node 22.12+ 的 require(esm) 下表现为调用即 TypeError。
 *
 * 属于回归用例，随 pnpm test:all 一起跑；也可单独执行：node test/cjs-shims.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

/* ---------- require 侧 ---------- */
const fetch = require('node-fetch')
check('require("node-fetch") 直接可调用', typeof fetch === 'function', `typeof=${typeof fetch}`)
check('require("node-fetch") 带 Headers', typeof fetch?.Headers === 'function')

const md5 = require('md5')
check(
  'require("md5") 直接可调用且结果正确',
  typeof md5 === 'function' && md5('1') === 'c4ca4238a0b923820dcc509a6f75849b',
  typeof md5 === 'function' ? md5('1') : `typeof=${typeof md5}`,
)

const oicq = require('oicq')
check('require("oicq").segment 是 segment 对象', typeof oicq?.segment?.image === 'function')

/* ---------- import 侧没被破坏 ---------- */
const esmFetch = (await import('node-fetch')).default
const esmMd5 = (await import('md5')).default
const { segment } = await import('oicq')
check('import 侧 node-fetch / md5 仍可用', typeof esmFetch === 'function' && typeof esmMd5 === 'function')
check('require 与 import 拿到同一个 segment 实例', oicq.segment === segment)

/* ---------- 子路径：生态里会 require('oicq/package.json').version ---------- */
for (const pkg of ['md5', 'node-fetch', 'oicq'])
  check(`require("${pkg}/package.json") 可用`, require(`${pkg}/package.json`)?.name === pkg)

/* ---------- 老 Node（require(ESM) 被禁用）下模块也必须能加载 ---------- */
{
  const { execFileSync } = await import('node:child_process')
  const probe = `
    const { createRequire } = require('node:module')
    const require_ = createRequire(process.cwd() + '/')
    const o = require_('oicq')
    const warm = typeof o.segment === 'object' && typeof o.segment.image === 'function'
    // 老 Node 上 segment 只能来自 globalThis（框架启动时注入），这里模拟注入后再取
    globalThis.segment = { image: () => {} }
    const viaGlobal = typeof o.segment?.image === 'function'
    console.log(warm ? 'WARM' : viaGlobal ? 'VIA_GLOBAL' : 'BROKEN')
  `
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--no-experimental-require-module', '-e', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (err) {
    out = `ERR ${err.message.split('\n')[0]}`
  }
  check(
    '禁用 require(ESM) 时模块可加载，且 globalThis.segment 能兜住（老 Node）',
    out === 'WARM' || out === 'VIA_GLOBAL',
    out,
  )
  check('禁用 require(ESM) 时 require("oicq") 不抛错（加载期不静默失败）', !String(out).startsWith('ERR'), out)
}

const pass = results.filter(r => r.ok).length
console.log(`\n=== CJS 壳包测试：${pass}/${results.length} 通过 ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)
process.exit(pass === results.length ? 0 : 1)
