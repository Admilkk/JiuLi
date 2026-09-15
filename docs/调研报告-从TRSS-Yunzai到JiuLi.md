# 重构调研报告（存档）

> 调研时间 2026-09-14，对象：`TRSS/Yunzai`（v3.1.3）、`kan/karin-project`（参考）、`JiuLi/jiuli`（空仓库）。
> 这份报告是重构**之前**的现状收集与方案选择，实现情况见文末标注。架构现状见 [architecture.md](architecture.md)。

## 核心结论

1. **「兼容全部旧插件」= 兼容一份具体的 API 契约**，而不是兼容名字。契约由四部分组成，缺一不可：
   - **物理路径**：插件里写死的 `../../lib/plugins/plugin.js`、`lib/config/config.js`、
     `lib/puppeteer/puppeteer.js` 必须**在同样位置真实存在**（哪怕只是转发到内核的 shim）
   - **全局变量**：`Bot` / `logger` / `redis` / `segment` / `Renderer` / `plugin` / `start_type`
   - **`e` 对象契约**：约 40 个字段与方法
   - **`Bot` 的隐式语义**：Proxy 属性回落、`Bot.uin` 特化数组、`Bot.adapter` 按 path 去重、
     `Bot.wsf` / `Bot.express` 扩展点
2. **TRSS-Yunzai 内核本身不大**（`lib/` 36 个文件 3404 行），「臃肿」来自三处：内核内嵌了游戏/插件专属逻辑、
   插件生态巨大（30 个目录 517 个 js）、为兼容历史插件长出的补丁层。
3. **性能问题集中在少数可量化点**：每条消息 `await Runtime.init(e)`、每条消息 16~32 次 Redis 计数命令、
   accept 阶段串行 `await` 所有候选插件。
4. **Karin 值得学的是工程化，不是 API 设计**——照抄它的 DSL / 事件模型就是缝合怪，
   而且它没有云崽兼容层，路线与 JiuLi 目标不同。
5. **建议架构：三层物理隔离**（现代 TS 内核 + 云崽兼容层 shim + 原生插件体系），旧插件走兼容层，新插件走原生层。

## 兼容契约清单

来自对 30 个插件、517 个 js 的全量使用统计。按缺失后果分级：

| 级别 | 契约 |
| --- | --- |
| P0（缺了插件直接崩） | 全局 `Bot`（Proxy + EventEmitter）；`Bot.uin` 特化数组（随机 `toJSON`）；`Bot.adapter` 去重 push 与适配器契约；`Bot` 方法面（`makeLog`/`pickX`/`makeForwardMsg`/文件与 exec 工具/`sendXxxMsg`/`prepareEvent`）；全局 `logger`（log4js 三通道 + mark + chalk 颜色）；**原生 node-redis v4 语义**的全局 `redis`（`Yz:` 前缀）；可解析的 `oicq` 包导出 `segment.*`；`lib/plugins/plugin.js` 基类；`lib/config/config.js` 的 Proxy 回落；`lib/plugins/loader.js` 单例的公开字段；`lib/common/common.js`；`e` 对象全字段与方法；渲染双通道；框架探测（`package.json.name` 与版本号首段、`#miao` 别名）；加载约定（`index.js` 优先、`init()` 返回 `"return"`）；规则语义（`reg` 字符串/正则、`event` 三段通配、`priority`）；`Promise.withResolvers`；`start_type` |
| P1（缺了大面积回归） | `Bot.wsf` / `Bot.express` / `Bot.server`；插件对适配器的查找与 monkey-patch；`onlyReplyAt` 与别名剥离；冷却、黑白名单、群级插件开关、`Yz:count:*`；`Bot.em` 逐级 emit 与 `prepareEvent`；游戏前缀标准化；`e.runtime` 自动注入；`file_watch: false` 时禁用 watcher；插件加载超时与加载期可用全局；Guoba 的 `defSet/*.yaml`；`global.plugin` 与插件自设全局；插件自带 `node_modules` 与 workspace link |
| P2（小范围） | `Bot.on('message')` 原始事件流；`Bot.uin.now`；`Bot.fs.timeout`；`lib/util.js` 的 Map 磁盘持久化；日志格式配置项 |

## 旧设计的坑

1. **内核反向依赖插件**：`lib/plugins/runtime.js` 顶层 import genshin 的 model 与 miao 的 `#miao`，框架被具体插件绑死
2. **游戏逻辑写进内核**：`loader.js` 的星铁 / 绝区零前缀正则
3. **配置魔法**：未定义属性回落 `getAllCfg`，`getGroup` 每次 4 层对象展开无缓存
4. **`Bot` 是上帝对象**：HTTP/WS、多账号、文件托管、工具、事件总线、日志入口挤在一个类里
5. **全局与 import 混用**：一部分是全局，一部分要 import，插件作者必须记住哪套是哪套
6. **共享实例被写 `e`**：`Object.assign(plugin, { e })` 让实例长期持有最后一个事件
7. **分发链串行 await**：一个慢插件阻塞后面所有插件
8. **插件给框架打补丁**：`Bot.xxx ??=` 兜底，说明内核 API 不完整
9. **热重载不完整**：只监听没有 `index.js` 的平铺插件，`index.js` / `resources` 改动不热更
10. **渲染先落盘再截图**：为保留模板相对资源路径语义而做的取舍

## 性能热点与实现情况

| # | 问题 | 处理 |
| --- | --- | --- |
| 1 | 每条消息 `await Runtime.init(e)`（redis 查询 + 建 DB 对象），即使最终没有插件处理 | ✅ `e.runtime` 懒挂载 |
| 2 | 每条消息 16~32 次 `incrBy` | ✅ 内存聚合 + 定时批量写回，键格式不变 |
| 3 | accept 阶段串行实例化并 `await` 所有候选插件 | ✅ 事件索引分桶 + 单实例分发 |
| 4 | 每插件每消息多次对象构造 | ✅ `perf.once_instance` 复用实例 |
| 5 | `filtEvent` 每条消息遍历全量插件 | ✅ 加载期按 `post_type` 建索引 |
| 6 | 每条消息都拼 `logText`（含 chalk 颜色码） | ✅ 日志字符串惰性求值 |
| 7 | `Bot` Proxy 每次属性访问走回落链 | ✅ 解析结果缓存（bots 变更时失效） |
| 8 | 内核大量 lodash / moment | ✅ 内核改用 es-toolkit，兼容层保留 lodash |
| 9 | 渲染后端 import 期初始化 | ✅ 后端懒加载，浏览器首次截图才启动 |
| 10 | 517 个 js 全量 import，`init()` 串行 | ✅ 文件级并行导入；启动耗时已单独分析（见 architecture.md） |
| 11 | `makeLog` 每次都查等级 | ✅ 保持等级短路 + 惰性求值 |

## Karin 借鉴 / 不借鉴

**借鉴**：类型系统与 JSDoc 补全；插件清单（`package.json` 声明入口）；每插件独立数据目录；
engines 版本门禁；适配器抽象；hooks 分段；`store: Map` 链内传值；内建 DB + 伪 Redis 降级；
配置逐级合并（bot → 群 → 用户）；CLI 只驱动外部 pm2；依赖 alias 到 fork；热重载用时间戳重 import。

**不照抄**：它的插件 DSL 命名与形状；强类型类实例 + camelCase 的事件模型（与云崽的普通对象 + snake_case 冲突）；
纯远程渲染（旧插件依赖本地 puppeteer 与模板相对路径）；TS 运行时完全依赖 tsx；
它的已知 bug（rank/priority 不统一等）；13MB WebUI 全家桶。

## 建议架构（已落地）

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 内核 | `src/**` → `lib/core/**` | 纯 TS、无全局依赖、不 import 插件 |
| 兼容层 | `lib/**`（手写 JS） | 复刻云崽契约的薄 shim |
| 插件 | `plugins/**` | 旧插件与原生插件共用注册与分发 |

路线图状态：

- [x] 内核 + 兼容层 P0，内置插件（system / adapter / demo），渲染双通道
- [x] 一键启动与进程管理（CLI + pm2 + 守护进程），`#重启` 不新开窗口
- [x] 测试：冒烟 35 项、热重载 11 项、生态插件适配 5 项、重启与守护契约
- [x] 日志重写（收发内容、命中规则、浏览器细节、启动摘要）
- [x] 生态插件移植与实机验证（miao / genshin / yenai / xiaofei / HMeme / TRSS-Plugin / QQBot / ICQQ / hl-icqq-web）
- [x] 原生插件双形态 + 分发钩子 + 生命周期 + 配置助手
- [ ] 适配器插件实机补齐（OneBotv11 / Milky / Satori）
- [ ] 惰性加载插件（需先解决运行时改规则的兼容问题）
