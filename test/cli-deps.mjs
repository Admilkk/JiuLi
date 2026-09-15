/**
 * `node jiuli deps` 验证（扫描插件依赖并一键安装）
 *
 * 用临时项目 + 假 pnpm：
 *   1) 只报真正缺失的包（内置模块 / 相对路径 / 已安装的都不算）
 *   2) 子路径归到包名（missing-b/sub/path.js → missing-b）、@scope 保持完整
 *   3) resources/ 与 *.min.js 不参与扫描（那些是前端产物/压缩库）
 *   4) 正则误匹配的垃圾（带空格 / 感叹号等）不会被当成包名
 *   5) 插件自己声明过版本就用它的（nearest package.json）
 *   6) --dry 只打印不安装；真装时 pnpm add 收到正确参数
 *
 * 不联网、不动真实 plugins/。
 * 用法：node test/cli-deps.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const ROOT = process.cwd()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuli-deps-'))
const BIN = path.join(TMP, 'bin')
const PNPM_LOG = path.join(TMP, 'pnpm-args.log')
fs.mkdirSync(BIN, { recursive: true })

/* ---------- 假 pnpm：记录参数 ---------- */
function writePnpmStub() {
  fs.rmSync(PNPM_LOG, { force: true })
  fs.writeFileSync(path.join(BIN, 'pnpm'), '#!/bin/sh\necho "$@" >> "$JIULI_PNPM_LOG"\nexit 0\n')
  try {
    fs.chmodSync(path.join(BIN, 'pnpm'), 0o755)
  } catch {}
  fs.writeFileSync(path.join(BIN, 'pnpm.cmd'), '@echo off\r\necho %* >> "%JIULI_PNPM_LOG%"\r\nexit /b 0\r\n')
}

/* ---------- 临时项目 ---------- */
const write = (rel, body) => {
  const full = path.join(TMP, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
}

// 一个已安装的包（写在项目 node_modules 下，应被视为"已装"）
write('node_modules/installed-pkg/package.json', '{"name":"installed-pkg","version":"1.0.0","main":"index.js"}')
write('node_modules/installed-pkg/index.js', 'module.exports = {}\n')

write(
  'plugins/example/有依赖.js',
  [
    "import fs from 'node:fs'",
    "import './local.js'",
    "import installed from 'installed-pkg'",
    "import scoped from '@scope/missing-a'",
    "const sub = require('missing-b/sub/path.js')",
    "const c = await import('missing-c')",
    "// import 垃圾 from 'not a real dep!'",
    'export default class A {}',
  ].join('\n'),
)
write('plugins/example/local.js', 'export default 1\n')

// 插件自己声明过版本 → 安装时带上
write('plugins/example/package.json', '{"name":"example","dependencies":{"missing-c":"^1.2.3"}}\n')

// 这些不该被扫描
write('plugins/example/resources/bundle.min.js', "import x from 'should-not-scan'\n")
write('plugins/example/resources/script/lib.min.js', "import y from 'also-not-scan'\n")

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

const cli = args => {
  const ret = spawnSync(process.execPath, [path.join(ROOT, 'jiuli.mjs'), ...args], {
    cwd: TMP,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
      JIULI_PNPM_LOG: PNPM_LOG,
    },
  })
  const pnpm = fs.existsSync(PNPM_LOG) ? fs.readFileSync(PNPM_LOG, 'utf8').trim() : ''
  return { out: `${ret.stdout || ''}${ret.stderr || ''}`.replace(/\u001b\[[0-9;]*m/g, ''), code: ret.status, pnpm }
}

/* ---------- 1. --dry ---------- */
writePnpmStub()
const dry = cli(['deps', '--dry'])
check('列出缺失的包（@scope 保持完整）', dry.out.includes('@scope/missing-a'), dry.out.split('\n').find(l => l.includes('missing'))?.slice(0, 80))
check('子路径归到包名（missing-b）', dry.out.includes('missing-b') && !dry.out.includes('missing-b/sub'), '')
check('动态 import 也算（missing-c）', dry.out.includes('missing-c'), '')
check('不报内置模块 / 相对路径 / 已安装的包', !/node:fs|local\.js|installed-pkg/.test(dry.out), '')
check('resources/ 与 .min.js 不参与扫描', !dry.out.includes('should-not-scan') && !dry.out.includes('also-not-scan'), '')
check('正则误匹配的垃圾不会被当成包名', !dry.out.includes('not a real dep'), '')
check('--dry 不调用 pnpm', dry.pnpm === '', dry.pnpm || '（未调用）')

/* ---------- 2. 真装（假 pnpm） ---------- */
writePnpmStub()
const run = cli(['deps'])
check('调用 pnpm add', run.pnpm.startsWith('add '), run.pnpm)
check(
  '参数包含全部缺失包，且用插件声明的版本',
  ['@scope/missing-a', 'missing-b', 'missing-c@^1.2.3'].every(p => run.pnpm.includes(p)),
  run.pnpm,
)
check('提示安装完成后如何生效', run.out.includes('#重载') || run.out.includes('#重启'), run.out.split('\n').pop()?.slice(0, 70))

/* ---------- 3. 没有缺失时（另起一个干净项目，避免进程内删文件） ---------- */
const CLEAN = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuli-deps-clean-'))
fs.mkdirSync(path.join(CLEAN, 'plugins', 'example'), { recursive: true })
fs.writeFileSync(path.join(CLEAN, 'plugins', 'example', '随便.js'), "import fs from 'node:fs'\nexport default 1\n")
fs.writeFileSync(path.join(CLEAN, 'plugins', 'example', 'local.js'), 'export default 1\n')

writePnpmStub()
const none = spawnSync(process.execPath, [path.join(ROOT, 'jiuli.mjs'), 'deps'], {
  cwd: CLEAN,
  encoding: 'utf8',
  env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, JIULI_PNPM_LOG: PNPM_LOG },
})
const noneOut = `${none.stdout || ''}${none.stderr || ''}`.replace(/\u001b\[[0-9;]*m/g, '')
check('依赖齐全时明确说明并不安装', noneOut.includes('依赖齐全') && !fs.existsSync(PNPM_LOG), noneOut.trim().split('\n').pop()?.slice(0, 60))

const pass = results.filter(r => r.ok).length
console.log(`\n=== 插件依赖一键安装测试：${pass}/${results.length} 通过 ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)

/** 临时目录不在本进程内删除（Windows 上偶发异常退出），留给系统清理 */
process.exit(pass === results.length ? 0 : 1)
