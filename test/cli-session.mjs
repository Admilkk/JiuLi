/**
 * CLI 会话命令验证（session / attach）
 *
 * Windows 与开发机上通常没有 tmux，这里放一个「假 tmux」到 PATH 最前，用它验证：
 *   1) node jiuli m  → 拼出的 tmux 命令行正确（-A 接管 / -s 会话名 / -c 工作目录 / 退出后留 shell）
 *   2) node jiuli at → 会话存在时 attach；不存在时明确提示并以退出码 1 结束
 *   3) 既无 tmux 也无 screen → 打印三种选择的指引，且不会误启动 bot
 *   4) 已在 tmux 内 → 不再套一层
 *
 * 注意：CLI 在临时目录里运行（那里没有 app.js），即便走到「启动」分支也只会报找不到
 * 模块，不会真的把机器人跑起来。
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
fs.mkdirSync(BIN, { recursive: true })

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

/** 假 tmux：把收到的参数追加到 STUB_LOG（CLI 用 stdio: inherit，抓不到它的输出） */
function writeStub(hasSessionExit = 0) {
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

/** 跑 CLI：cwd 用临时目录（无 app.js，绝不会真启动机器人） */
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

/* ---- 1. session：拼出的 tmux 命令行 ---- */
writeStub(0)
const m = cli(['m'])
check('jiuli m 调用了 tmux', m.stub.includes('new-session'), m.stub || '(未调用)')
check('用 -A 接管已有会话、-s 指定会话名', m.stub.includes('new-session -A -s jiuli'), m.stub)
check('透传工作目录 -c <当前目录>', m.stub.includes(`-c ${TMP}`), m.stub)
check('启动 app.js 且退出后保留 shell', /app\.js.*exec /.test(m.stub), m.stub)
check('提示脱离与接回方式', m.out.includes('Ctrl+B') && m.out.includes('jiuli attach'), m.out.split('\n').pop())

/* ---- 2. attach：会话存在 / 不存在 ---- */
writeStub(0)
const at = cli(['at'])
check('jiuli at 会话存在时 attach -t jiuli', at.stub.includes('attach -t jiuli'), at.stub)

writeStub(1)
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
  none.out.includes('没找到 tmux') && !none.out.includes('Cannot find module'),
  none.out.split('\n')[0],
)
check('指引给出三种选择', none.out.includes('node jiuli s') && none.out.includes('node .'), '')

/* ---- 4. 已在 tmux 内：不再套娃 ---- */
const inside = cli(['m'], { pathPrefix: null, env: { TMUX: '/tmp/tmux-1000/default,123,0' } })
check(
  '已在 tmux 会话内时直接启动（不再套一层 tmux）',
  inside.out.includes('已在 tmux 会话内') && !inside.stub.includes('new-session'),
  inside.out.split('\n')[0],
)

fs.rmSync(TMP, { recursive: true, force: true })
const pass = results.filter(r => r.ok).length
console.log(`\n=== CLI 会话命令测试：${pass}/${results.length} 通过 ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)
process.exit(pass === results.length ? 0 : 1)
