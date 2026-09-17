/**
 * 系统外部命令自检验证
 *
 * ffmpeg 这类命令缺了只在插件运行时报 `Command failed: ffmpeg …`，
 * 所以要能自检 + 给出安装命令（自动安装只在 Linux + root 下做）。
 *
 * 用法：node test/deps-check.mjs
 */
/** 测试机不该真的去装东西 */
process.env.JIULI_NO_AUTO_INSTALL = '1'

const { missingDeps, canAutoInstall, depPath, ensureDeps, SYSTEM_DEPS } = await import('../lib/core/deps.js')

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

check('能探测到已存在的命令', Boolean(await depPath('node')), await depPath('node'))
check('不存在的命令返回空', (await depPath('这个命令肯定不存在-xyz')) === '')
check('声明了 ffmpeg 作为需要的命令', SYSTEM_DEPS.some(i => i.cmd === 'ffmpeg' && i.pkg.apt && i.pkg.dnf && i.pkg.yum))

const missing = await missingDeps()
check('缺失列表只包含声明的依赖', missing.every(i => SYSTEM_DEPS.includes(i)), `缺 ${missing.map(i => i.cmd).join(' · ') || '无'}`)

/** 设了 JIULI_NO_AUTO_INSTALL（且测试机多为非 Linux）→ 只提示、不安装 */
check('关闭自动安装时不具备安装条件', canAutoInstall() === false)

const ready = await ensureDeps()
check('自检不抛错，且返回与缺失状态一致', ready === (missing.length === 0), `ready=${ready} 缺=${missing.length}`)

const pass = results.filter(r => r.ok).length
console.log(`\n=== 系统命令自检验证：${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
