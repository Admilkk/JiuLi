# JiuLi 架构说明

## 设计目标与约束

1. **零改动兼容云崽插件** —— 这是硬约束，决定了整体形态：
   插件文件里写死的相对路径 import（`../../lib/plugins/plugin.js` 等）无法通过模块别名绕过
   （除非给每个插件注入 import map），因此这些路径必须在 `lib/` 下真实存在。
2. **内核性能与类型** —— 内核用 TypeScript 编写，编译到 `lib/core/`；
   兼容层保持手写 JS（它必须能"就地存在"，且状态越少越好）。
3. **内核不依赖插件** —— 云崽内核反向 import 了 genshin 的 model 与 miao 的 `#miao`；
   JiuLi 把它们改为动态加载 + 扩展点，保证内核可独立运行。

## 分层

```
┌──────────────────────────────────────────────────────────┐
│ plugins/**   旧插件（extends plugin） / JiuLi 原生插件      │
└───────────────┬──────────────────────────────────────────┘
                │ import（旧路径 / 'jiuli'）
┌───────────────▼──────────────────────────────────────────┐
│ lib/**  兼容层（手写 JS shim）                              │
│  lib/plugins/{plugin,loader,handler,runtime,config}.js    │
│  lib/config/{config,init,log,redis}.js                    │
│  lib/common/common.js  lib/puppeteer/puppeteer.js         │
│  lib/renderer/*  lib/events/*  lib/listener/*  lib/util.js│
│  lib/modules/{oicq,md5,node-fetch}                        │
└───────────────┬──────────────────────────────────────────┘
                │ import '../core/...'
┌───────────────▼──────────────────────────────────────────┐
│ lib/core/**  内核（由 src/** 编译）                        │
│  bot.ts        Bot 单例（Proxy/uin/adapter/HTTP/WS/文件）   │
│  loader.ts     插件加载 + 消息分发 + 任务 + 热重载          │
│  plugin.ts     插件基类（rule/上下文/renderImg）            │
│  config/       配置中心（YAML + Proxy 回落 + 热更新）        │
│  redis.ts      Redis + 内存降级实现                        │
│  render/       art-template Renderer + 渲染后端加载器       │
│  runtime.ts    e.runtime（懒加载，genshin 生态动态接入）     │
│  events.ts     监听器基类 + 监听/适配器加载                 │
│  handler.ts    跨插件 handler 总线                         │
│  metrics.ts    插件耗时统计                                │
│  log.ts        日志（等级短路 + 文件输出）                  │
│  util.ts       工具（Bot.* 回落实现）                      │
│  plugin-config.ts  makeConfig 兼容实现                    │
│  globals.ts / start.ts / types.ts / segment.ts            │
└──────────────────────────────────────────────────────────┘
```

## 启动流程

```
app.js（启动模式：internal/external/pm2/daemon/stop）
 └─ import lib/core/start.js → start()
     ├─ 时区 / 进程标题（compat.spoof_yunzai 决定显示名）
     ├─ setLogDir + ensureDirs（temp/data/logs/resources）
     ├─ 创建 Bot 单例（Proxy）→ injectGlobals()
     │    Bot / logger / plugin / segment / Renderer / start_type
     ├─ 未捕获异常、退出钩子
     └─ bot.run()
         ├─ redisInit()（失败 → 本机拉起 redis-server → 内存降级）
         ├─ serverLoad()（HTTP，可再启 HTTPS）
         ├─ renderService.load()（扫描 renderers/，浏览器仍在首次截图时启动）
         ├─ PluginsLoader.load()
         │    ├─ 扫描 plugins/（有 index.js 只加载它，否则平铺 .js）
         │    ├─ import → loadPlugin：new → init() → task → rule 预编译 → handler
         │    ├─ 事件索引构建 + 优先级排序 + 定时任务创建
         │    └─ 热重载 watcher
         ├─ loadEvents()（lib/events/*.js + Bot.adapter 逐个 load()）
         └─ stat.online = 2 → emit('online')
```

## 启动耗时分析

`plugins/` 下的文件是**并行 `import()`** 的（`Promise.allSettled`），所以日志里的
「启动关键路径」记录的是“开始加载 → 该插件就绪”的耗时，**含公共依赖解析**，
最后就绪的几个就是拖慢启动的那几个，不代表插件自身有问题。

实测（Windows / 102 个插件 / Node 25，2026-09）：

| 环节 | 耗时 | 说明 |
| --- | --- | --- |
| 内置 16 个 system 插件 | 0.24s | 内核 + 内置插件本身 |
| 单个重插件（genshin） | 2.2s | 主要是它的依赖图 |
| 全部 102 个插件 | 8~14s | 视第三方插件而定 |

耗时构成（`--cpu-prof` 采样，修复 yenai 之前 / 之后）：

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| 模块解析（`internalModuleStat`/`lstat`/`getPackageScopeConfig`） | 55% | 68% |
| 子进程（`spawn`/`spawnSync`，即 PowerShell） | 15% | 2% |
| 插件自身 JS | ~1% | ~1% |

结论与可操作项：

1. **主因是 Node 解析模块图的文件系统调用**，不是加载策略：本机 `statSync` 单次约
   `107µs`（Windows Defender 实时扫描 + pnpm 软链目录结构），1119 个模块文件
   × 每个约 100 次候选路径探测 ≈ 十几秒。**串行加载 13.61s ≈ 并行加载 13.68s**，
   证明与并发策略无关。
2. **必须避免第三方插件在 import 阶段做同步外部调用**。典型是
   `systeminformation`：Windows 下它用 PowerShell 查 WMI，`si.graphics()` 一次约 10s、
   `si.cpu()`/`si.osInfo()` 各约 4.6s。yenai-plugin 原本在 5 个模块顶层直接调用，
   仅在 import 就占了 10s 启动时间，现已改为惰性 + 记忆化（见下方「移植适配记录」）。
3. V8 编译缓存（`NODE_COMPILE_CACHE`）实测**无收益**（24.9s → 28.0s），因为瓶颈不在解析/编译。
4. 想进一步提速只剩一条路：**改惰性加载**（启动时只静态提取规则正则，命中才真正 import 插件），
   与动态规则插件（运行时 `setContext` 增删规则）存在兼容风险，暂未实现。

## 消息分发

```
适配器: Bot.em('message.group.normal', e)
  → Bot.prepareEvent(e)
      bots[self_id] 存在时补全 bot/friend/group/member/sender.nickname/card
      adapter_id/adapter_name、reply、makeForwardMsg、sendFile
  → EventEmitter 逐级 emit：message.group.normal → message.group → message
  → lib/events/message.js 监听 'message' → PluginsLoader.deal(e)

deal(e):
  1. pushCount（内存聚合，默认 1s 批量写回 Redis）
  2. checkBlack（白/黑名单）
  3. checkLimit（禁言、群/个人 CD、1s 消息去重）
  4. dealEvent：解析 message 段 → e.msg/img/at/atBot/reply_id/file → logText
               → isMaster → 别名剥离 → only_reply_at
  5. setLimit（only_reply_at 时设置 CD）
  6. reply(e)：包装 e.reply，支持 {recallMsg, at}、异常捕获、计数
  7. Runtime.attach(e)：轻量挂载 e.runtime（重活懒加载）
  8. 候选插件：事件索引（按 post_type 分桶）+ checkDisable + filtEvent
  9. 上下文 hook：探针对象取 getContext，命中则执行对应方法（返回 'continue' 继续）
 10. only_reply_at 过滤 + 星铁/绝区零前缀标准化（isSr/isGs/game）
 11. accept 循环（返回 'return' 终止；返回真值跳出）
 12. rule 循环：event 过滤 → reg 匹配 → 权限 → 调用（绑定实例）→ false 继续
 13. 未命中：debug 日志「暂无插件处理」
```

### 相对云崽的语义差异（有意为之）

| 项 | 云崽 | JiuLi |
|---|---|---|
| 共享实例写入 `e` | `Object.assign(plugin, { e })`，实例长期持有最后一个事件 | 不污染共享实例；上下文检查用探针对象，规则调用用「每事件实例」 |
| 实例创建 | accept 与 rule 各 `new` 一次 | 默认复用（`perf.once_instance`），可用配置关闭 |
| 计数写入 | 每条消息直接 multi 写 16~32 个键 | 内存聚合 + 定时批量写回，键格式不变 |
| `e.runtime` | 每条消息 await `Runtime.init`（MysInfo/NoteUser） | 懒挂载；genshin 生态需要时才动态加载 |
| 候选插件选择 | 遍历全部插件 | 事件索引分桶（`perf.event_index`） |

## 渲染

- `Renderer`（art-template）：读模板（带缓存 + 热更新）→ 渲染 → 写 `temp/html/<name>/<saveId>.html`。
  落盘是刻意的：模板中的相对资源路径依赖 html 文件位置。
- `RendererLoader`：扫描 `renderers/<name>/`，每个后端导出 `(config) => { id, type, render(name, data) }`；
  按 `<script>` 支持度分两组，依次尝试直到成功。
- 内置 `renderers/puppeteer`：本机 Chrome/Edge（`.puppeteerrc.cjs` 跳过下载）、
  多进程共享（redis 缓存 ws 端点）、截图数达阈值自动重启、空闲自动关闭。
- 两条调用通道：
  - 现代：`e.runtime.render(plugin, path, data, cfg)`（`retType: base64 | msgId`）
  - 传统：`lib/puppeteer/puppeteer.js` 的 `screenshot/screenshots`

## 存储

- **Redis**：插件按原生 node-redis v4 客户端使用（键格式与云崽一致）。
  连接失败且 host 为本机时，先尝试拉起 `cfg.redis.path`；仍失败则按 `redis_fallback` 决定内存降级或退出。
  内存实现覆盖 string/hash/set/zset/list/scan/multi 等常用命令，未实现的命令返回 null 并告警一次。
- **本地 Map 持久化**：`util.getMap(dir)` 基于 level（与云崽一致，数据目录 `data/*-leveldb`）。

## 扩展点

| 扩展点 | 用法 |
|---|---|
| 渲染后端 | 新建 `renderers/<id>/index.js` + `config_default.yaml`，导出 `(config) => renderer` |
| 适配器 | 插件内 `Bot.adapter.push({ id, name, path, load() })` |
| 事件监听器 | 在 `lib/events/` 新增 `.js`，导出继承 `lib/listener/listener.js` 的类 |
| 运行时扩展 | `Runtime.use({ initUser, getMysInfo, ... })`（genshin 生态接入方式） |
| WS 处理器 | `Bot.wsf[path] = [handler]` |
| HTTP 路由 | `Bot.express.get/post(...)`，可改 `Bot.express.skip_auth / quiet` |
| 文本预处理器 | 目前保留云崽的 `loader.srReg / zzzReg`（可覆盖）；后续会抽成正式扩展点 |

## 目录/文件约定

| 路径 | 说明 |
|---|---|
| `config/default_config/*.yaml` | 默认配置（随仓库）；首次启动复制到 `config/config/` |
| `plugins/<name>/index.js` | 存在时只加载它；旧插件的 `apps/` 模式则由该文件导入 |
| `plugins/<name>/resources/<tpl>.html` | 渲染模板（`pluResPath` 指向此处） |
| `temp/html/<plugin>/<path>/<saveId>.html` | 渲染中间产物（可随时清理） |
| `data/plugins/<name>/` | JiuLi 原生插件私有数据目录（`this.dataDir`） |
| `logs/jiuli.YYYY-MM-DD.log` | 运行日志；错误另写 `logs/error/` |
