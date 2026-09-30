/**
 * 中文（非 ASCII）路径下的配置初始化回归测试
 *
 * 背景：Node 25（Windows）上 `fs.cpSync(src, dst, { recursive: true })` 递归拷贝
 * 「源目录路径含非 ASCII 字符」的目录会 **fail-fast 崩掉整个进程**：
 * 退出码 0xC0000409 / -1073740791（STATUS_STACK_BUFFER_OVERRUN）、没有任何 JS 报错、
 * try/catch 也拦不住。于是把 JiuLi 装在中文目录（如 D:\yunzaibot\测试\测试jiuli\jiuli）时，
 * 首次启动会在 initCfg() 拷默认配置这一步静默死掉——看起来就是「node . 什么都不做就退出」，
 * 连 logs/ 都不会生成。
 *
 * 关键点：必须是 **源目录也在中文路径下** 才会触发（源 ASCII + 目标中文不会崩），
 * 所以这里把子进程的 cwd 也设到中文目录里，再让它按绝对 file:// URL 加载内核。
 *
 * 用法：node test/config-path.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
  ok ? pass++ : fail++
}

const entry = path.join(ROOT, 'lib/core/config/index.js')
if (!fs.existsSync(entry)) {
  console.log('⏭ 跳过：内核还没编译（先执行 node jiuli b）')
  process.exit(0)
}

const base = path.join(ROOT, 'test', `.tmp-cfg-中文-${Date.now()}`)
const workDir = path.join(base, '中文工作目录')
const userDir = path.join(workDir, '用户配置')
const pm2File = path.join(ROOT, 'config', 'pm2.yaml')
const hadPm2 = fs.existsSync(pm2File)
const FAIL_FAST = -1073740791 // 0xC0000409
const asUnsigned = n => (n < 0 ? n + 4294967296 : n)

/** 测试自己的准备工作也用手写递归：fs.cpSync 在非 ASCII 路径下本身就不可靠 */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dest)
    else fs.copyFileSync(src, dest)
  }
}

try {
  // 子进程的 cwd 就是中文目录：这样 config/default_config 与用户配置目录都在非 ASCII 路径下
  fs.mkdirSync(workDir, { recursive: true })
  copyTree(path.join(ROOT, 'config', 'default_config'), path.join(workDir, 'config', 'default_config'))

  const ret = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(entry).href)}); process.exit(0)`],
    {
      cwd: workDir,
      env: { ...process.env, JIULI_CONFIG_DIR: userDir + path.sep },
      encoding: 'utf8',
      timeout: 60000,
    },
  )

  const crashed = ret.status !== 0
  const codeText = ret.status === null ? (ret.signal ?? 'null') : `${ret.status}${ret.status < 0 ? ` (0x${asUnsigned(ret.status).toString(16).toUpperCase()})` : ''}`
  check(
    '中文路径下初始化配置不崩（子进程正常退出）',
    !crashed,
    crashed
      ? `退出码 ${codeText}${asUnsigned(Number(ret.status)) === asUnsigned(FAIL_FAST) ? ' = STATUS_STACK_BUFFER_OVERRUN，就是 fs.cpSync 那个坑' : ''}`
      : '',
  )

  const expect = fs.readdirSync(path.join(workDir, 'config', 'default_config')).filter(f => f !== 'pm2.yaml')
  const got = fs.existsSync(userDir) ? fs.readdirSync(userDir) : []
  check(
    '默认配置已复制到中文路径的用户配置目录',
    expect.length > 0 && expect.every(f => got.includes(f)),
    expect.filter(f => !got.includes(f)).join(',') || `${got.length} 个文件`,
  )

  if (ret.stderr?.trim()) console.log(`   （子进程 stderr：${ret.stderr.trim().split('\n')[0]}）`)
} finally {
  fs.rmSync(base, { recursive: true, force: true })
  if (!hadPm2) fs.rmSync(pm2File, { force: true })
}

console.log(`\n=== 中文路径配置初始化：${pass}/${pass + fail} 通过 ===`)
process.exit(fail ? 1 : 0)
