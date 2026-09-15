/**
 * CLI 参数校验验证
 *
 * 起因：`node jiuli a <url> --naem genshi` 里 --name 拼错了，旧版 CLI 把未知选项
 * 和多出来的位置参数一起默默忽略，于是照旧克隆成 plugins/Yunzai-genshin —— 用户以为
 * 改名成功、其实没有。这里固定住「拼错要报错并给出建议」的行为。
 *
 * 全部在临时目录里跑，不会克隆到真实 plugins/。
 * 用法：node test/cli-args.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const ROOT = process.cwd()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuli-args-'))
const CLI = path.join(ROOT, 'jiuli.mjs')
const FAKE_URL = 'https://gitee.com/jiuli-test/not-exist.git'

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}

const cli = args => {
  const ret = spawnSync(process.execPath, [CLI, ...args], { cwd: TMP, encoding: 'utf8', timeout: 60000 })
  return { out: `${ret.stdout || ''}${ret.stderr || ''}`.replace(/\u001b\[[0-9;]*m/g, ''), code: ret.status }
}

/* ---- add：拼错 / 多余参数 / 正确用法 ---- */
const typo = cli(['a', FAKE_URL, '--naem', 'genshi'])
check('add 拼错 --naem → 报错并建议 --name', typo.code === 1 && typo.out.includes('未知选项 --naem') && typo.out.includes('--name'), typo.out.split('\n').slice(-2).join(' / '))
check('拼错时不会开始克隆', !typo.out.includes('克隆插件'), typo.out.split('\n')[0])

const extra = cli(['a', FAKE_URL, 'genshi'])
check('add 多余的位置参数 → 报错退出', extra.code === 1 && extra.out.includes('用法'), extra.out.split('\n')[0])

const named = cli(['a', FAKE_URL, '--name', 'genshi'])
check('add --name genshi → 目标目录为 plugins/genshi', named.out.includes('plugins/genshi'), named.out.split('\n')[0])

const inline = cli(['a', FAKE_URL, '--name=genshi2'])
check('add --name=genshi2（等号写法）同样生效', inline.out.includes('plugins/genshi2'), inline.out.split('\n')[0])

const defaultName = cli(['a', FAKE_URL])
check('add 不带 --name → 用仓库名', defaultName.out.includes('plugins/not-exist'), defaultName.out.split('\n')[0])

const noValue = cli(['a', FAKE_URL, '--name'])
check('add --name 后面没跟值 → 明确报错', noValue.code === 1 && noValue.out.includes('要跟一个值'), noValue.out.split('\n').slice(-1)[0])

/* ---- create / start：同样不许默默忽略 ---- */
const dri = cli(['c', 'myplugin', '--dri'])
check('create 拼错 --dri → 建议 --dir（挑最接近的）', dri.code === 1 && dri.out.includes('是想写 --dir 吗'), dri.out.split('\n').slice(-1)[0])

const fgg = cli(['s', '--fgg'])
check('start 拼错 --fgg → 报错且不会启动', fgg.code === 1 && fgg.out.includes('未知选项 --fgg'), fgg.out.split('\n').slice(-1)[0])

fs.rmSync(TMP, { recursive: true, force: true })
const pass = results.filter(r => r.ok).length
console.log(`\n=== CLI 参数校验测试：${pass}/${results.length} 通过 ===`)
for (const r of results) if (!r.ok) console.log(`   未通过：${r.name}`)
process.exit(pass === results.length ? 0 : 1)
