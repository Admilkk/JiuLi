/**
 * `node jiuli deps` 验证（扫描松散 JS 插件的依赖并安装）
 *
 * 关键规则（都是实际踩过的坑）：
 *   1) 只扫「没有 index.js 的平铺插件目录」——插件包的依赖由各自 package.json + pnpm i 负责，
 *      扫它们只会报出一堆假缺失（icqq / node-karin / playwright …）
 *   2) 插件内部自己的文件写法（models/xx.js 且本地存在）不算依赖
 *   3) 内置模块 / 相对路径 / 已安装的包都不算缺失
 *   4) 子路径归到包名（missing-b/sub/path.js → missing-b）、@scope 保持完整
 *   5) resources/ 与 *.min.js 不参与扫描；正则误匹配的垃圾不会被当成包名
 *   6) 安装落到插件目录（有 package.json 时用 pnpm --dir），否则用 pnpm -w 装到根
 *      —— 直接 pnpm add 到 workspace 根会被 pnpm 拒绝（ERR_PNPM_ADDING_TO_ROOT）
 *
 * 用临时项目 + 假 pnpm，不联网、不动真实 plugins/。
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

/** 假 pnpm：把参数追加到日志 */
function writePnpmStub() {
  fs.writeFileSync(path.join(BIN, 'pnpm'), '#!/bin/sh\necho "$@" >> "$JIULI_PNPM_LOG"\nexit 0\n')
  try {
    fs.chmodSync(path.join(BIN, 'pnpm'), 0o755)
  } catch {}
  fs.writeFileSync(path.join(BIN, 'pnpm.cmd'), '@echo off\r\necho %* >> "%JIULI_PNPM_LOG%"\r\nexit /b 0\r\n')
}
const readPnpm = () => (fs.existsSync(PNPM_LOG) ? fs.readFileSync(PNPM_LOG, 'utf8').trim() : '')
const resetPnpm = () => fs.writeFileSync(PNPM_LOG, '')

const write = (rel, body) => {
  const full = path.join(TMP, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
}

/* ---------- 临时项目 ---------- */
// 已安装的包（应视为已装）
write('node_modules/installed-pkg/package.json', '{"name":"installed-pkg","version":"1.0.0","main":"index.js"}')
write('node_modules/installed-pkg/index.js', 'module.exports = {}\n')

// A. 松散插件目录（有 package.json，缺依赖 → 装到这里）
write('plugins/example/package.json', '{"name":"example","dependencies":{"missing-c":"^1.2.3"}}\n')
write(
  'plugins/example/有依赖.js',
  [
    "import fs from 'node:fs'",
    "import './local.js'",
    "import installed from 'installed-pkg'",
    "import scoped from '@scope/missing-a'",
    "const sub = require('missing-b/sub/path.js')",
    "const c = await import('missing-c')",
    "import local2 from 'models/local.js'",
    "// import 垃圾 from 'not a real dep!'",
    'export default class A {}',
  ].join('\n'),
)
write('plugins/example/local.js', 'export default 1\n')
write('plugins/example/models/local.js', 'export default 2\n')

// B. 松散插件目录（没有 package.json → 装到项目根，带 -w）
write('plugins/loose/单文件.js', "import rootPkg from 'missing-root-pkg'\nexport default 1\n")

// C. min.js 不扫
write('plugins/example/resources/bundle.min.js', "import x from 'also-not-scan'\n")

// D. 插件包（有 index.js）整个跳过
write('plugins/packaged-plugin/index.js', "import p from 'should-be-skipped-pkg'\nexport default class P {}\n")
write('plugins/packaged-plugin/package.json', '{"name":"packaged-plugin","dependencies":{"declared-only": "^1.0.0"}}\n')

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

const cli = args => {
  const ret = spawnSync(process.execPath, [path.join(ROOT, 'jiuli.mjs'), ...args], {
    cwd: TMP,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, JIULI_PNPM_LOG: PNPM_LOG },
  })
  return { out: `${ret.stdout || ''}${ret.stderr || ''}`.replace(/\u001b\[[0-9;]*m/g, ''), code: ret.status, pnpm: readPnpm() }
}

/* ---------- 1. --dry ---------- */
writePnpmStub()
resetPnpm()
const dry = cli(['deps', '--dry'])
check('说明只扫松散目录、插件包交给 pnpm i', dry.out.includes('松散 JS 插件目录') && dry.out.includes('pnpm i'), dry.out.split('\n')[0].slice(0, 90))
check('插件包的依赖不报（packaged-plugin 整目录跳过）', !dry.out.includes('should-be-skipped-pkg') && !dry.out.includes('declared-only'), '')
check('@scope 包名完整', dry.out.includes('@scope/missing-a'), '')
check('子路径归到包名（missing-b）', dry.out.includes('missing-b') && !dry.out.includes('missing-b/sub'), '')
check('动态 import 也算（missing-c）', dry.out.includes('missing-c'), '')
check('插件内部自己的文件不算依赖（models/local.js）', !dry.out.includes('models/local.js'), '')
check('内置模块 / 相对路径 / 已安装的包不报', !/node:fs|local\.js|installed-pkg/.test(dry.out), '')
check('resources/ 与 .min.js 不参与扫描', !dry.out.includes('should-not-scan') && !dry.out.includes('also-not-scan'), '')
check('垃圾文本不会被当成包名', !dry.out.includes('not a real dep'), '')
check(
  '--dry 打印将执行的命令且不调用 pnpm',
  dry.out.includes('pnpm --dir plugins/example add') && dry.out.includes('pnpm -w add') && dry.pnpm === '',
  dry.pnpm || '（未调用）',
)

/* ---------- 2. 安装 ---------- */
writePnpmStub()
resetPnpm()
const run = cli(['deps'])
const calls = run.pnpm.split('\n').filter(Boolean)
check('有 package.json 的目录用 pnpm --dir 装（避开 ERR_PNPM_ADDING_TO_ROOT）', calls.some(c => c.startsWith('--dir plugins/example add ')), calls[0] || '（无调用）')
check('没有 package.json 的目录用 pnpm -w 装到根', calls.some(c => c.startsWith('-w add ')), calls[1] || '')
check(
  '包名与版本正确（缺依赖 + 插件声明版本）',
  calls.some(c => ['@scope/missing-a', 'missing-b', 'missing-c@^1.2.3'].every(p => c.includes(p))) &&
    calls.some(c => c.includes('missing-root-pkg')),
  calls.join(' | '),
)
check('提示安装完成后如何生效', run.out.includes('#重载') || run.out.includes('#重启'), run.out.split('\n').filter(Boolean).pop()?.slice(0, 60))

/* ---------- 3. 没有缺失时（另起干净项目，不做进程内删除） ---------- */
const CLEAN = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuli-deps-clean-'))
fs.mkdirSync(path.join(CLEAN, 'plugins', 'example'), { recursive: true })
fs.writeFileSync(path.join(CLEAN, 'plugins', 'example', '随便.js'), "import fs from 'node:fs'\nexport default 1\n")
resetPnpm()
const none = spawnSync(process.execPath, [path.join(ROOT, 'jiuli.mjs'), 'deps'], {
  cwd: CLEAN,
  encoding: 'utf8',
  env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, JIULI_PNPM_LOG: PNPM_LOG },
})
const noneOut = `${none.stdout || ''}${none.stderr || ''}`.replace(/\u001b\[[0-9;]*m/g, '')
check('依赖齐全时明确说明并不安装', noneOut.includes('依赖齐全') && readPnpm() === '', noneOut.trim().split('\n').pop()?.slice(0, 60))

const pass = results.filter(r => r.ok).length
console.log(`\n=== 插件依赖一键安装测试：${pass}/${results.length} 通过 ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)

/** 临时目录不在本进程内删除（Windows 上偶发异常退出），留给系统清理 */
process.exit(pass === results.length ? 0 : 1)
