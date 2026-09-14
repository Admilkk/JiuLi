#!/usr/bin/env node
/**
 * JiuLi CLI
 *
 * 一条命令完成安装 / 构建 / 启动 / 管理：
 *   pnpm i && pnpm start        安装依赖后一键后台启动（自动构建 + 生成配置）
 *   node jiuli.mjs init         安装依赖 + 构建 + 生成配置
 *   node jiuli.mjs start [--fg] 启动（默认 pm2 后台，--fg 前台）
 *   node jiuli.mjs stop|rs|log  停止 / 重启 / 查看日志
 *   node jiuli.mjs build|test|status
 */
import { spawnSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const CWD = process.cwd()
const isWin = process.platform === 'win32'

const color = (code, text) => `\u001b[${code}m${text}\u001b[0m`
const info = t => console.log(`${color(36, '[JiuLi]')} ${t}`)
const ok = t => console.log(`${color(32, '[JiuLi]')} ${t}`)
const warn = t => console.log(`${color(33, '[JiuLi]')} ${t}`)
const fail = t => {
  console.error(`${color(31, '[JiuLi]')} ${t}`)
  process.exit(1)
}

/** 本地 pm2 可执行文件（找不到则回退 npx） */
function pm2Bin() {
  const bin = path.join(CWD, 'node_modules', '.bin', isWin ? 'pm2.cmd' : 'pm2')
  return fs.existsSync(bin) ? bin : null
}

function run(cmd, args, opts = {}) {
  return spawnCmd(cmd, args, { stdio: 'inherit', cwd: CWD, ...opts })
}

/** Windows 下 .cmd 需要 shell；把命令拼成单字符串避免 DEP0190 警告 */
function spawnCmd(bin, args = [], opts = {}) {
  if (isWin) {
    const line = [bin, ...args].map(a => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a)).join(' ')
    return spawnSync(line, { shell: true, ...opts })
  }
  return spawnSync(bin, args, opts)
}

function hasPm2() {
  const bin = pm2Bin()
  const ret = bin
    ? spawnCmd(bin, ['-v'], { stdio: 'ignore', cwd: CWD })
    : spawnSync('npx', ['--no-install', 'pm2', '-v'], { stdio: 'ignore', cwd: CWD })
  return ret.status === 0
}

function pm2(args) {
  const bin = pm2Bin()
  if (!bin) fail('未找到 pm2，请先执行 pnpm install（或 npm i -g pm2）')
  return spawnCmd(bin, args, { stdio: 'inherit', cwd: CWD })
}

/** 依赖检查 */
function ensureDeps({ auto = true } = {}) {
  if (fs.existsSync(path.join(CWD, 'node_modules', 'typescript'))) return true
  if (!auto) return false
  info('未检测到依赖，正在安装（pnpm install）…')
  const ret = run('pnpm', ['install'])
  if (ret.status !== 0) fail('依赖安装失败，请检查网络或包管理器')
  return true
}

/** 构建检查：lib/core 与 lib/index.js 存在且不比 src 旧 */
function srcNewerThanBuild() {
  const marker = path.join(CWD, 'lib', 'index.js')
  if (!fs.existsSync(marker)) return true
  const buildTime = fs.statSync(marker).mtimeMs
  const walk = dir => {
    let newest = 0
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      const t = entry.isDirectory() ? walk(p) : fs.statSync(p).mtimeMs
      if (t > newest) newest = t
    }
    return newest
  }
  return walk(path.join(CWD, 'src')) > buildTime
}

function ensureBuild({ auto = true } = {}) {
  if (fs.existsSync(path.join(CWD, 'lib', 'core')) && !srcNewerThanBuild()) return true
  if (!auto) return false
  info('正在编译内核（tsc）…')
  const ret = run(isWin ? 'npx.cmd' : 'npx', ['tsc'])
  if (ret.status !== 0) fail('编译失败，请检查 src/ 下的 TypeScript 错误')
  ok('内核编译完成')
  return true
}

/** 生成默认配置（由框架本体负责，这里只做提示） */
function ensureConfig() {
  if (fs.existsSync(path.join(CWD, 'config', 'config', 'bot.yaml')))
    return ok('检测到用户配置 config/config/')
  info('首次启动将自动生成 config/config/（默认配置）')
}

/* ---------------- 命令 ---------------- */

function cmdInit() {
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor < 20) fail(`需要 Node.js >= 20，当前 ${process.version}`)
  ensureDeps()
  ensureBuild()
  ensureConfig()
  if (!hasPm2()) warn('未检测到 pm2（依赖内自带，执行 pnpm install 后可用）')
  ok('初始化完成。启动：node jiuli.mjs start（后台）或 node jiuli.mjs start --fg（前台）')
}

function cmdStart(args) {
  const fg = args.includes('--fg') || args.includes('-f')
  ensureDeps()
  ensureBuild()
  ensureConfig()

  if (fg) {
    info('前台启动（Ctrl+C 退出）…')
    const child = spawn(process.execPath, ['.'], { stdio: 'inherit', cwd: CWD })
    child.on('exit', code => process.exit(code ?? 0))
    return
  }

  if (!hasPm2()) {
    warn('未找到 pm2，改为前台启动（可用 pnpm add -D pm2 后使用后台模式）')
    const child = spawn(process.execPath, ['.'], { stdio: 'inherit', cwd: CWD })
    child.on('exit', code => process.exit(code ?? 0))
    return
  }

  const pm2File = path.join(CWD, 'config', 'pm2.yaml')
  if (!fs.existsSync(pm2File)) fail('缺少 config/pm2.yaml，请先运行一次 node . （会自动生成）')
  info('pm2 后台启动…')
  pm2(['start', 'config/pm2.yaml'])
  pm2(['save'])
  ok('已后台运行。查看日志：node jiuli.mjs log；重启：node jiuli.mjs rs；停止：node jiuli.mjs stop')
}

function cmdStop() {
  pm2(['delete', 'JiuLi'])
  pm2(['save'])
  ok('已停止 JiuLi')
}

function cmdRestart() {
  pm2(['restart', 'JiuLi'])
  ok('已重启 JiuLi')
}

function cmdLog(args) {
  const lines = args.find(a => /^\d+$/.test(a)) || '100'
  /** --follow/-f 时持续输出，默认打印最近若干行后退出 */
  const follow = args.includes('--follow') || args.includes('-f')
  pm2(follow ? ['logs', 'JiuLi', '--lines', String(lines)] : ['logs', 'JiuLi', '--lines', String(lines), '--nostream'])
}

function cmdBuild() {
  ensureDeps()
  const ret = run(isWin ? 'npx.cmd' : 'npx', ['tsc'])
  if (ret.status !== 0) fail('编译失败')
  ok('内核编译完成')
}

function cmdTest() {
  ensureDeps()
  ensureBuild()
  const ret = run(process.execPath, ['test/smoke.mjs'])
  process.exit(ret.status ?? 0)
}

function cmdStatus() {
  const pkg = JSON.parse(fs.readFileSync(path.join(CWD, 'package.json'), 'utf8'))
  console.log(`JiuLi v${pkg.version}`)
  console.log(`Node ${process.version} / ${process.platform} ${process.arch}`)
  console.log(`依赖：${fs.existsSync(path.join(CWD, 'node_modules')) ? '已安装' : '未安装'}`)
  console.log(`构建：${fs.existsSync(path.join(CWD, 'lib', 'index.js')) ? '已构建' : '未构建'}`)
  console.log(`配置：${fs.existsSync(path.join(CWD, 'config', 'config', 'bot.yaml')) ? '已生成' : '未生成'}`)
  console.log(`pm2 ：${hasPm2() ? '可用' : '不可用'}`)
  if (hasPm2()) pm2(['list'])
}

function cmdCreate(args) {
  const name = args.find(a => !a.startsWith('-'))
  const dsl = args.includes('--dsl')
  const asDir = args.includes('--dir')
  if (!name) fail('用法：pnpm jiuli create <插件名> [--dsl] [--dir]')
  if (!/^[\p{L}\p{N}._-]+$/u.test(name)) fail('插件名只能包含字母、数字、汉字、点、下划线、连字符')

  const tplDir = path.join(CWD, 'templates', dsl ? 'plugin-dsl' : 'plugin-class')
  if (!fs.existsSync(tplDir)) fail(`缺少模板目录 ${tplDir}`)

  const className = /^[a-zA-Z0-9._-]+$/.test(name)
    ? name
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map(s => s[0].toUpperCase() + s.slice(1))
        .join('') || 'MyPlugin'
    : name.replace(/[^\p{L}\p{N}_$]/gu, '') || 'MyPlugin'
  const render = text => text.replaceAll('{{name}}', name).replaceAll('{{ClassName}}', className)

  /** 默认：生成到 plugins/example/<名字>.js（你自己的插件目录，改动即时热重载） */
  if (!asDir) {
    const target = path.join(CWD, 'plugins', 'example', `${name}.js`)
    if (fs.existsSync(target)) fail(`plugins/example/${name}.js 已存在`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, render(fs.readFileSync(path.join(tplDir, 'index.js'), 'utf8')))
    ok(`已创建 plugins/example/${name}.js（${dsl ? 'DSL' : '类'}形态 · 保存后 2 秒内自动生效）`)
    console.log('  文档：docs/plugin-guide.md · docs 里的目录说明：plugins/README.md')
    return
  }

  /** --dir：生成独立插件目录（适合带 apps/、resources/、package.json 的插件） */
  const target = path.join(CWD, 'plugins', name)
  if (fs.existsSync(target)) fail(`plugins/${name} 已存在`)
  const copyDir = (from, to) => {
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name)
      const dest = path.join(to, entry.name)
      if (entry.isDirectory()) copyDir(src, dest)
      else fs.writeFileSync(dest, render(fs.readFileSync(src, 'utf8')))
    }
  }
  copyDir(tplDir, target)
  fs.mkdirSync(path.join(target, 'resources'), { recursive: true })

  ok(`已创建 plugins/${name}/index.js（独立目录形态）`)
  console.log(`  编辑：plugins/${name}/index.js · 模板放 plugins/${name}/resources/`)
  console.log('  生效：改动 js 后等 2 秒自动重载（或 #重载）')
  console.log('  文档：docs/plugin-guide.md')
}

function cmdHelp() {
  console.log(`JiuLi CLI

  node jiuli.mjs init          安装依赖 + 编译内核 + 生成配置
  node jiuli.mjs create <名称> [--dsl] [--dir]
                               生成插件骨架（默认 plugins/example/<名称>.js，热重载）
                               --dsl 用函数式形态；--dir 生成独立插件目录
  node jiuli.mjs start         pm2 后台启动（--fg 前台运行）
  node jiuli.mjs stop          停止
  node jiuli.mjs rs            重启
  node jiuli.mjs log [条数]     查看日志（-f 持续输出）
  node jiuli.mjs build         编译内核
  node jiuli.mjs test          冒烟测试
  node jiuli.mjs status        环境与运行状态

等价 npm scripts：pnpm setup / pnpm start / pnpm stop / pnpm rs / pnpm log / pnpm build / pnpm test`)
}

const [cmd = 'help', ...args] = process.argv.slice(2)
const commands = {
  init: cmdInit,
  create: () => cmdCreate(args),
  new: () => cmdCreate(args),
  start: () => cmdStart(args),
  run: () => cmdStart(args),
  stop: cmdStop,
  rs: cmdRestart,
  restart: cmdRestart,
  log: () => cmdLog(args),
  logs: () => cmdLog(args),
  build: cmdBuild,
  test: cmdTest,
  status: cmdStatus,
  help: cmdHelp,
}

if (!commands[cmd]) {
  warn(`未知命令：${cmd}`)
  cmdHelp()
  process.exit(1)
}
commands[cmd]()
