/**
 * TRSS-Plugin 解压功能验证（可选用例）
 *
 * 验证 plugins/TRSS-Plugin/Model/archive.js：默认同名目录、重命名、复合后缀、
 * 目录穿越防护、失败不留残留。插件目录可用 TRSS_PLUGIN_DIR 指定，不存在则跳过。
 *
 * 用法：node test/trss-archive.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
const PLUGIN = (process.env.TRSS_PLUGIN_DIR || 'D:/yunzaibot/JiuLi/jiuli/plugins/TRSS-Plugin').split('\\').join('/')
/** 没装 TRSS-Plugin 就跳过（可选用例） */
if (!fs.existsSync(PLUGIN)) {
  console.log(`⏭️  未找到 TRSS-Plugin（${PLUGIN}），跳过`)
  process.exit(0)
}
const AdmZip = (await import(`file:///${PLUGIN}/node_modules/adm-zip/adm-zip.js`)).default

const { extractArchive } = await import(`file:///${PLUGIN}/Model/archive.js`)

const tmp = 'test/.tmp-archive'
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })

const results = []
const check = (name, ok, extra) => {
  results.push({ ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

/** 造一个正常压缩包：demo.zip 里放两个文件 */
const srcDir = path.join(tmp, 'src')
fs.mkdirSync(srcDir, { recursive: true })
fs.writeFileSync(path.join(srcDir, 'a.txt'), 'hello')
fs.mkdirSync(path.join(srcDir, 'sub'), { recursive: true })
fs.writeFileSync(path.join(srcDir, 'sub', 'b.txt'), 'world')
const zipPath = path.join(tmp, 'demo.zip')
const zip = new AdmZip()
zip.addLocalFolder(srcDir)
zip.writeZip(zipPath)

/** 1) 默认：解到同名目录 */
let res = await extractArchive(zipPath)
check('解压到「压缩包同名目录」', res.ok && path.basename(res.dir) === 'demo', res.ok ? res.dir : res.reason)
check('文件内容正确', fs.readFileSync(path.join(tmp, 'demo', 'sub', 'b.txt'), 'utf8') === 'world')
check('条目数正确', res.ok && res.count === 3, res.ok ? `${res.count} 条` : '')

/** 2) 带新目录名（空格分隔的写法由 File.js 解析，这里直接传名字） */
const zip2 = path.join(tmp, 'demo2.zip')
fs.copyFileSync(zipPath, zip2)
res = await extractArchive(zip2, '重命名后的目录')
check('可以重命名目标文件夹', res.ok && path.basename(res.dir) === '重命名后的目录' && res.renamed, res.ok ? res.dir : res.reason)

/** 3) 复合后缀 .tar.gz 的默认目录名只保留主名（造一个真的 tar.gz） */
const { execFileSync } = await import('node:child_process')
const tarSrc = path.join(tmp, 'pkg-src')
fs.mkdirSync(tarSrc, { recursive: true })
fs.writeFileSync(path.join(tarSrc, 'c.txt'), 'tar')
execFileSync('tar', ['-czf', 'pkg.tar.gz', '-C', 'pkg-src', '.'], { cwd: tmp })
const tarGz = path.join(tmp, 'pkg.tar.gz')
res = await extractArchive(tarGz)
check('tar.gz 默认目录名去掉复合后缀', res.ok ? path.basename(res.dir) === 'pkg' : false, res.ok ? res.dir : `（${res.reason}）`)
check('tar.gz 内容解出来了', fs.existsSync(path.join(tmp, 'pkg', 'c.txt')))

/** 4) 目录穿越必须被拦下（adm-zip 会自己规范化 ../，所以直接校验判定函数） */
const { isSafeEntry } = await import(`file:///${PLUGIN}/Model/archive.js`)
const root = path.join(tmp, 'demo')
check('拦下 ../ 越界条目', isSafeEntry(root, '../escaped.txt') === false)
check('拦下多级 ../ 越界条目', isSafeEntry(root, 'a/../../escaped.txt') === false)
check('拦下绝对路径条目', isSafeEntry(root, path.resolve(tmp, 'elsewhere', 'x.txt')) === false)
check('放行正常条目', isSafeEntry(root, 'a/b.txt') === true && isSafeEntry(root, './c.txt') === true)

/** 5) 失败时不留半成品目录（用不支持的格式触发） */
const weird = path.join(tmp, 'weird.xyz')
fs.writeFileSync(weird, 'not an archive')
res = await extractArchive(weird)
check('不支持的格式给出明确原因', !res.ok && /不支持的压缩包格式/.test(res.reason), res.reason)
check('失败后不留半成品目录', !fs.existsSync(path.join(tmp, 'weird')))

/** 6) 文件不存在 */
res = await extractArchive(path.join(tmp, '不存在.zip'))
check('压缩包不存在时给出明确原因', !res.ok && /不存在/.test(res.reason), res.reason)

const pass = results.filter(r => r.ok).length
console.log(`\n=== 解压功能验证：${pass}/${results.length} 通过 ===`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(pass === results.length ? 0 : 1)
