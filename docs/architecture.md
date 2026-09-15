# JiuLi 架构说明

## 设计约束

1. **零改动兼容云崽插件**（硬约束）：插件里写死的相对路径（`../../lib/plugins/plugin.js` 等）
   无法用模块别名绕过，因此这些路径必须在 `lib/` 下真实存在。
2. **内核 TS + 兼容层 JS**：内核编译到 `lib/core/`；兼容层手写，状态越少越好。
3. **内核不依赖插件**：云崽内核反向 import 了 genshin / miao 的内部模块，JiuLi 改为动态加载 + 扩展点。

## 分层

```
plugins/**            旧插件（extends plugin）/ JiuLi 原生插件
   │  import（旧路径 / 'jiuli'）
lib/**  兼容层（手写 JS shim）
   lib/plugins/{plugin,loader,handler,runtime,config}.js
   lib/config/{config,init,log,redis}.js
   lib/common/common.js  lib/puppeteer/puppeteer.js
   lib/renderer/*  lib/events/*  lib/listener/*  lib/util.js
   lib/modules/{oicq,md5,node-fetch}
   │  import '../core/...'
lib/core/**  内核（由 src/** 编译）
   bot.ts          Bot 单例（Proxy / uin / adapter / HTTP / WS / 文件）
   loader.ts       插件加载 + 消息分发 + 任务 + 热重载
   plugin.ts       插件基类（rule / 上下文 / renderImg）
   config/         配置中心（YAML + Proxy 回落 + 热更新）
   redis.ts        Redis + 内存降级
   render/         art-template Renderer + 后端加载器
   runtime.ts      e.runtime（懒加载，genshin 生态动态接入）
   events.ts       监听器基类 + 监听 / 适配器加载
   handler.ts      跨插件 handler 总线
   metrics.ts      插件耗时统计
   log.ts          日志（等级短路 + 文件输出）
   util.ts         工具（Bot.* 回落实现）
   plugin-config.ts  makeConfig 兼容实现
   globals.ts / start.ts / types.ts / segment.ts / common.ts
```

## 启动流程

```
app.js（模式：internal / external / pm2 / daemon / stop）
 └─ lib/core/start.ts → start()
     ├─ 时区、进程标题（compat.spoof_yunzai 决定对外显示名）
     ├─ setLogDir + ensureDirs（temp/data/logs/resources）
     ├─ new Bot() → injectGlobals()：Bot / logger / plugin / segment / Renderer / start_type
     ├─ 未捕获异常与退出钩子
     └─ bot.run()
         ├─ redisInit()（失败 → 拉起本机 redis-server → 内存降级）
         ├─ serverLoad()（HTTP，可选 HTTPS）
         ├─ renderService.load()（扫描 renderers/，浏览器首次截图才启动）
         ├─ PluginsLoader.load()
         │    ├─ 扫描 plugins/（有 index.js 只加载它，否则平铺 .js）
         │    ├─ 并行 import → loadPlugin：new → init() → task → rule 预编译 → handler
         │    ├─ 事件索引 + 优先级排序 + 定时任务
         │    └─ 热重载 watcher
         ├─ loadEvents()（lib/events/*.js + Bot.adapter 逐个 load()）
         └─ stat.online = 2 → emit('online')
```

## 启动耗时分析

插件是**并行 `import()`** 的，日志里的「启动关键路径」记录的是「开始加载 → 该插件就绪」的耗时
（含公共依赖解析），最后就绪的几个就是拖慢启动的，不代表插件有问题。

实测（Windows / 102 个插件 / Node 25）：

| 环节 | 耗时 |
| --- | --- |
| 内置 16 个 system 插件 | 0.24s |
| 单个重插件（genshin） | 2.2s |
| 全部 102 个插件 | 8~14s |

耗时构成（`--cpu-prof` 采样，修 yenai 之前 / 之后）：

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| 模块解析（`internalModuleStat` / `lstat` / `getPackageScopeConfig`） | 55% | 68% |
| 子进程（`spawn` / `spawnSync`，即 PowerShell） | 15% | 2% |
| 插件自身 JS | ~1% | ~1% |

结论：

1. **主因是 Node 解析模块图的文件系统调用**：本机 `statSync` 单次约 107µs
   （Defender 实时扫描 + pnpm 软链结构），1119 个模块文件 × 每个约百次候选路径探测 ≈ 十几秒。
   **串行 13.61s ≈ 并行 13.68s**，与并发策略无关。
2. **避免第三方插件在 import 阶段做同步外部调用**：典型是 `systeminformation`——Windows 下用
   PowerShell 查 WMI，`si.graphics()` 单次约 10s、`si.cpu()` / `si.osInfo()` 各约 4.6s。
   yenai-plugin 原本在 5 个模块顶层调用，光 import 就占 10s；改为惰性后 23.5s → 13.7s。
3. V8 编译缓存（`NODE_COMPILE_CACHE`）实测无收益（24.9s → 28.0s），瓶颈不在解析 / 编译。
4. 进一步提速只能改**惰性加载**（静态提取规则正则，命中才 import），
   与运行时改规则的插件存在兼容风险，暂未实现。

## 消息分发

```
适配器: Bot.em('message.group.normal', e)
  → Bot.prepareEvent(e)：补全 bot/friend/group/member/sender、adapter_*、reply、sendFile
  → EventEmitter 逐级 emit：message.group.normal → message.group → message
  → lib/events/message.js → PluginsLoader.deal(e)

deal(e):
   1. pushCount（内存聚合，默认 1s 批量写回）
   2. checkBlack（白 / 黑名单）
   3. checkLimit（禁言、群 / 个人 CD、1s 去重）
   4. dealEvent：解析消息段 → e.msg/img/at/atBot/reply_id/file → logText
                → isMaster → 别名剥离 → only_reply_at
   5. setLimit
   6. reply(e)：包装 e.reply，支持 {recallMsg, at}、异常捕获、计数
   7. Runtime.attach(e)：轻量挂载 e.runtime（重活懒加载）
   8. 候选插件：事件索引分桶 + checkDisable + filtEvent
   9. 上下文 hook：探针对象取 getContext，命中则执行（返回 'continue' 继续）
  10. only_reply_at 过滤 + 星铁 / 绝区零前缀标准化
  11. accept 循环（'return' 终止，真值跳出）
  12. rule 循环：event 过滤 → reg 匹配 → 权限 → 调用（绑定实例）→ false 继续
  13. 未命中：debug 日志「暂无插件处理」
```

### 与云崽的语义差异（有意为之）

| 项 | 云崽 | JiuLi |
|---|---|---|
| 共享实例写入 `e` | `Object.assign(plugin, { e })`，实例长期持有最后一个事件 | 不污染共享实例；上下文检查用探针对象，规则调用用每事件实例 |
| 实例创建 | accept 与 rule 各 `new` 一次 | 默认复用（`perf.once_instance`） |
| 计数写入 | 每条消息直接写 16~32 个键 | 内存聚合 + 定时批量写回，键格式不变 |
| `e.runtime` | 每条消息 await `Runtime.init` | 懒挂载，需要时才动态加载 genshin 生态 |
| 候选插件 | 遍历全部插件 | 事件索引分桶（`perf.event_index`） |

## 渲染

- `Renderer`（art-template）：读模板（带缓存 + 热更新）→ 渲染 → 写 `temp/html/<name>/<saveId>.html`。
  落盘是刻意的，模板里的相对资源路径依赖 html 文件位置。
- `RendererLoader`：扫描 `renderers/<name>/`，后端导出 `(config) => { id, type, render(name, data) }`，
  按 `<script>` 支持度分组依次尝试。
- 内置 `renderers/puppeteer`：用本机 Chrome / Edge（`.puppeteerrc.cjs` 跳过下载）、
  多进程共享 ws 端点、截图数达阈值重启、空闲自动关闭。
- 两条调用通道：`e.runtime.render(plugin, path, data, cfg)` 与 `lib/puppeteer/puppeteer.js` 的
  `screenshot` / `screenshots`。

## 存储

- **Redis**：按 node-redis v4 原生用法（键格式与云崽一致）。连接失败且为本机地址时先尝试拉起
  `cfg.redis.path`，仍失败则按 `redis_fallback` 降级为内存实现或退出。
  内存实现覆盖 string / hash / set / zset / list / scan / multi，未实现的命令返回 null 并告警一次。
- **本地 Map**：`util.getMap(dir)` 基于 level（与云崽一致，数据目录 `data/*-leveldb`）。

## 扩展点

| 扩展点 | 用法 |
|---|---|
| 渲染后端 | `renderers/<id>/index.js` + `config_default.yaml`，导出 `(config) => renderer` |
| 适配器 | `Bot.adapter.push({ id, name, path, load() })` |
| 事件监听器 | `lib/events/` 新增 `.js`，继承 `lib/listener/listener.js` |
| 运行时扩展 | `Runtime.use({ initUser, getMysInfo, ... })` |
| WS 处理器 | `Bot.wsf[path] = [handler]` |
| HTTP 路由 | `Bot.express.get/post(...)`，可改 `express.skip_auth` / `quiet` |
| 文本预处理 | 目前沿用云崽的 `loader.srReg` / `zzzReg`（可覆盖） |

## 目录与文件约定

| 路径 | 说明 |
|---|---|
| `config/default_config/*.yaml` | 默认配置，首次启动复制到 `config/config/` |
| `plugins/<name>/index.js` | 存在时只加载它（旧插件的 `apps/` 模式由它导入） |
| `plugins/<name>/resources/<tpl>.html` | 渲染模板（`pluResPath` 指向此处） |
| `temp/html/<plugin>/<path>/<saveId>.html` | 渲染中间产物，可随时清理 |
| `data/plugins/<name>/` | 原生插件私有数据目录（`this.dataDir`） |
| `logs/jiuli.YYYY-MM-DD.log` | 运行日志，错误另写 `logs/error/` |
