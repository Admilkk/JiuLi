# 生态插件移植适配记录

`plugins/` 下的生态插件按 `.gitignore` **不入库**（体积 + 各自许可），所以对它们做的适配
都在工作区里，不会随框架仓库分发。这份文档记录全部差异点，用来在
`pnpm jiuli add <插件>`、重新拉取或插件自行更新之后**重新应用**。

适配只改插件自己的代码/配置，不动框架契约；框架侧的兼容层在 `src/` 与 `lib/` 里。

## 1. 跨插件引用路径 `other/` → `system/`

云崽把内置插件放 `plugins/other/`，JiuLi 并入了 `plugins/system/`，旧插件里对内置插件的
相对引用需要跟着改：

| 文件 | 改动 |
| --- | --- |
| `yenai-plugin/apps/update.js` | `../../other/update.js` → `../../system/update.js` |
| `HMeme/apps/update.js` | `../../other/update.js` → `../../system/update.js` |
| `xiaofei-plugin/apps/更新.js` | `../../other/restart.js` → `../../system/restart.js` |

配套地，`plugins/system/update.js` 补 `export { Update as update }`、
`plugins/system/restart.js` 补 `export { Restart }`，让旧插件的具名导入成立。

## 2. yenai-plugin：把 `systeminformation` 的 import 期调用改成惰性（启动省约 10 秒）

Windows 下 `systeminformation` 是用 PowerShell 查 WMI，实测单次耗时：
`si.graphics()` 约 10s、`si.cpu()` 约 4.6s、`si.osInfo()` 约 4.6s、`si.memLayout()` 约 2.3s。
yenai-plugin 原来在 5 个模块**顶层**直接调用它们（`(async () => { ... })()`），
这些调用会占住主线程，把框架启动整体拖慢约 10 秒（23.5s → 13.7s，详见
`docs/architecture.md` 的「启动耗时分析」）。

改法统一为「惰性 + 记忆化」，即首次用到时才取，之后复用同一个 Promise：

| 文件 | 原实现 | 改为 |
| --- | --- | --- |
| `model/State/OtherInfo.js` | `let osInfo = null; (async() => { osInfo = await si.osInfo() })()` | `ensureOsInfo() { return (osInfo ||= si.osInfo().catch(() => ({}))) }`，并把默认导出的 `otherInfo(e)` 改为 `async`、内部 `await ensureOsInfo()` |
| `model/State/SystemResources/CPU.js` | `(async() => { cpu = await si.cpu() })()` | `ensureCpu() { return (cpu ||= si.cpu().catch(() => null)) }`，在 `getCpuInfo()` 内 `await` |
| `model/State/SystemResources/RAM.js` | `(async() => { memLayout = await si.memLayout() })()` | `ensureMemLayout()`，在 `getMemUsage()` 内 `await`（`memLayout[0].clockSpeed` 顺带加可选链） |
| `model/State/SystemResources/GPU.js` | `(async function initGetIsGPU() { ... si.graphics() ... })()` | `ensureIsGPU()` 惰性判定，`getGPU()` 里 `if (!(await ensureIsGPU())) return false` |
| `model/State/index.js` | `otherInfo: getOtherInfo(e),` | `otherInfo: await getOtherInfo(e),`（配合上面的 async 化） |

配套配置 `plugins/yenai-plugin/config/config/state.yaml`：

```yaml
monitor:
  # 常驻 PowerShell，WMI 查询快 3~4 倍（graphics 11.9s→3.6s、cpu 4.6s→1.3s）
  statusPowerShellStart: true
```

开启后首次 `#椰奶状态` 约 5.7s（渲染就绪），后续更快；不开启则每次都要重新起 PowerShell。

## 3. HMeme：`memes/` 必须是资源仓库

`plugins/HMeme/memes` 对应仓库 `https://gitee.com/fox-glaze/hmeme-img.git`。
插件用 `fs.existsSync(memes/.git)` 判断：没有 `.git` 且目录非空时会直接抛
`非空且不是 Git 仓库`，且**强制更新也救不回来**（`git clone ... .` 在非空目录必然失败）。

复制插件时如果排除了 `.git`，就会落入这个状态。修法（约 2MB、68 个文件、3 秒）：

```bash
git clone https://gitee.com/fox-glaze/hmeme-img.git plugins/HMeme/memes
```

验证：`git -C plugins/HMeme/memes branch -r` 能看到 `origin/master`（插件的强制更新会执行
`git fetch --all` + `git reset --hard origin/master`）。

## 4. 其它

- 移植时**不要复制 `node_modules`**（尤其是别复制 `dist`/`temp`），依赖交给根目录
  `pnpm install` 统一装，避免重复的依赖副本拖慢模块解析。
- 首次加载很重（miao 光资源 264MB，依赖图含 jimp / sequelize / puppeteer 等），
  机器忙时可在 `config/config/bot.yaml` 调大 `plugin_load_timeout`（默认 60 秒）。
