/**
 * CLI 会话命令验证（session / attach）
 *
 * Windows 与开发机上通常没有 tmux，这里在临时目录里搭一个「假项目 + 假 tmux + 假 npx」，
 * 把它们挂到 PATH 前面，验证：
 *   1) node jiuli m  → 先补前置（依赖 / 编译内核 / 配置），再拼出正确的 tmux 命令行
 *      （-A 接管 / -s 会话名 / -c 工作目录 / 启动后留 shell）
 *   2) node jiuli at → 会话存在时 attach；不存在时明确提示并以退出码 1 结束
 *   3) 既无 tmux 也无 screen → 打印三种选择的指引，且不会误启动 bot
 *   4) 已在 tmux 内 → 不再套一层，直接启动
 *
 * 假项目里没有 src/，编译走的是假的 npx（只写标记文件），因此不会真的调 tsc、
 * 也不会联网；app.js 也是桩，更不会把真实机器人跑起来。假项目的 lib/core 在
 * 第 1 项之后补上，避免后续用例再要求编译。
 *
 * 用法：node test/cli-session.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const ROOT = process.cwd()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuli-cli-'))
const BIN = path.join(TMP, 'bin')
const STUB_LOG = path.join(TMP, 'tmux-args.log')
const BUILD_MARK = path.join(TMP, 'built.marker')
const APP_MARK = path.join(TMP, 'app-ran.marker')

fs.mkdirSync(BIN, { recursive: true })
fs.mkdirSync(path.join(TMP, 'node_modules', 'typescript'), { recursive: true })

/** 假项目：app.js 是桩，package.json 仅占位 */
fs.writeFileSync(
  path.join(TMP, 'app.js'),
  `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(APP_MARK)}, 'ran')\n`,
)
fs.writeFileSync(path.join(TMP, 'package.json'), '{ "name": "jiuli", "version": "0.0.0" }\n')

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

/** 假 tmux：把参数追加到 STUB_LOG；has-session 的退出码可控 */
function writeTmuxStub(hasSessionExit = 0) {
  fs.rmSync(STUB_LOG, { force: true })
  fs.writeFileSync(
    path.join(BIN, 'tmux'),
    [
      '#!/bin/sh',
      'echo "$@" >> "$JIULI_STUB_LOG"',
      `if [ "$1" = "has-session" ]; then exit ${hasSessionExit}; fi`,
      'exit 0',
      '',
    ].join('\n'),
  )
  try {
    fs.chmodSync(path.join(BIN, 'tmux'), 0o755)
  } catch {}
  fs.writeFileSync(
    path.join(BIN, 'tmux.cmd'),
    [
      '@echo off',
      'echo %* >> "%JIULI_STUB_LOG%"',
      `if "%1"=="has-session" exit /b ${hasSessionExit}`,
      'exit /b 0',
      '',
    ].join('\r\n'),
  )
}

/** 假 npx：只写编译标记，避免真的调 tsc / 联网 */
fs.writeFileSync(path.join(BIN, 'npx'), `#!/bin/sh\necho built > "${BUILD_MARK}"\nexit 0\n`)
try {
  fs.chmodSync(path.join(BIN, 'npx'), 0o755)
} catch {}
fs.writeFileSync(path.join(BIN, 'npx.cmd'), `@echo off\r\necho built > "${BUILD_MARK}"\r\nexit /b 0\r\n`)

/** 跑 CLI：cwd 用假项目（app.js 是桩，绝不会启动真实机器人） */
function cli(args, { pathPrefix = BIN, env = {} } = {}) {
  const ret = spawnSync(process.execPath, [path.join(ROOT, 'jiuli.mjs'), ...args], {
    cwd: TMP,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: pathPrefix ? `${pathPrefix}${path.delimiter}${process.env.PATH}` : TMP,
      JIULI_STUB_LOG: STUB_LOG,
      ...env,
    },
  })
  const stub = fs.existsSync(STUB_LOG) ? fs.readFileSync(STUB_LOG, 'utf8').trim() : ''
  return { out: `${ret.stdout || ''}${ret.stderr || ''}`, stub, code: ret.status }
}

/* ---- 1. session：先补前置，再拼 tmux 命令行 ---- */
fs.rmSync(BUILD_MARK, { force: true })
fs.rmSync(APP_MARK, { force: true })
writeTmuxStub(0)
const m = cli(['m'])
check('lib/core 缺失时先编译内核（服务器首次部署的关键）', fs.existsSync(BUILD_MARK), m.out.includes('编译内核') ? '触发了编译' : m.out.split('\n')[0])
check('jiuli m 调用了 tmux', m.stub.includes('new-session'), m.stub || '(未调用)')
check('用 -A 接管已有会话、-s 指定会话名', m.stub.includes('new-session -A -s jiuli'), m.stub)
check('透传工作目录 -c <项目根>', m.stub.includes(`-c ${TMP}`), m.stub)
check('启动 app.js 且退出后保留 shell', /app\.js.*exec /.test(m.stub), m.stub)
check('node / app.js 路径带引号（兼容含空格的路径）', /app\.js\\?"/.test(m.stub), m.stub)
check('提示脱离与接回方式', m.out.includes('Ctrl+B') && m.out.includes('jiuli attach'), m.out.split('\n').pop())

/** 后续用例不再要求编译：lib/index.js 是 ensureBuild 判据，lib/core 是内核目录 */
fs.mkdirSync(path.join(TMP, 'lib', 'core'), { recursive: true })
fs.writeFileSync(path.join(TMP, 'lib', 'index.js'), '// built\n')

/* ---- 2. attach：会话存在 / 不存在 ---- */
writeTmuxStub(0)
const at = cli(['at'])
check('jiuli at 会话存在时 attach -t jiuli', at.stub.includes('attach -t jiuli'), at.stub)

writeTmuxStub(1)
const atMissing = cli(['at'])
check(
  'jiuli at 会话不存在时明确报错（退出码 1）',
  atMissing.code === 1 && atMissing.out.includes('没有名为 jiuli 的会话'),
  atMissing.out.split('\n')[0],
)

/* ---- 3. 无 tmux / screen：给指引，不启动 bot ---- */
const none = cli(['m'], { pathPrefix: null })
check(
  '无 tmux/screen 时只给指引、不启动 bot',
  none.out.includes('没找到 tmux') && !fs.existsSync(APP_MARK),
  none.out.split('\n')[0],
)
check('指引给出三种选择', none.out.includes('node jiuli s') && none.out.includes('node .'), '')

/* ---- 4. 已在 tmux 内：不再套娃，直接启动 ---- */
const inside = cli(['m'], { pathPrefix: null, env: { TMUX: '/tmp/tmux-1000/default,123,0' } })
check(
  '已在 tmux 会话内时直接启动（不再套一层 tmux）',
  inside.out.includes('已在 tmux 会话内') && !inside.stub.includes('new-session') && fs.existsSync(APP_MARK),
  inside.out.split('\n')[0],
)

fs.rmSync(TMP, { recursive: true, force: true })
const pass = results.filter(r => r.ok).length
console.log(`\n=== CLI 会话命令测试：${pass}/${results.length} 通过 ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)
process.exit(pass === results.length ? 0 : 1)
