# 兼容性测试夹具

这里是从 **TRSS-Yunzai**（AGPL-3.0，作者 TimeRainStarSky 等）的 `plugins/example/` 复制的
旧插件样本，仅用于 `pnpm test` 验证兼容层——**它们不是 JiuLi 的插件，不要照着写**。

| 文件 | 用途 |
|---|---|
| `喵一个.js` | 最简 rule + reply（验证基础分发） |
| `进群退群通知.js` | `accept` 钩子 + notice 事件 + `segment.at`（验证事件监听与回复） |
| `主动复读.js` | `setContext` / `finish` 上下文会话（验证会话机制） |

`test/smoke.mjs` 会在运行时把它们复制到 `plugins/_test-fixtures/`（该目录已 gitignore，
测试结束自动删除），因为内核要求插件位于 `plugins/<目录>/<文件>.js` 才能按云崽的相对路径约定加载。
