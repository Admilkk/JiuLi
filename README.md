# JiuLi（玖璃）

> 兼容 TRSS-Yunzai 生态的新一代机器人框架 · 内核 TypeScript · 三层架构

JiuLi 是一个从 [TRSS-Yunzai](https://gitee.com/TimeRainStarSky/Yunzai) 重构而来的机器人框架。
目标是：**高性能、类型完备，同时零改动兼容全部云崽（Yunzai）生态插件**。

## 特性

- **旧插件零改动兼容**：`lib/` 下的物理路径 shim + 全局变量 + `e` 对象契约 + `Bot` 隐式语义，
  与云崽（TRSS-Yunzai）的开发习惯完全一致。把插件目录丢进 `plugins/` 即可使用。
- **内核 TypeScript**：`src/` 全量 TS 编写，编译到 `lib/core/`，类型完备、可 `pnpm typecheck`。
- **原生插件双形态**：JiuLi 插件支持 `JiuLiPlugin` 类形态与 `definePlugin + command/task/accept` 函数式 DSL，
  与旧插件共用同一套内核与注册表。
- **性能改进**（相对云崽）：
  - `e.runtime` 懒加载（旧版每条消息都执行 MysInfo/NoteUser 初始化）
  - 事件索引：按事件类型分桶，避免每条消息全量遍历插件
  - 单实例分发：accept 与 rule 复用同一插件实例
  - 消息计数内存聚合 + 定时批量写回（默认 1s，键格式与云崽一致）
  - 慢插件统计与 `#玖璃性能` 指标
  - 日志惰性求值、Bot 属性回落解析缓存
- **可插拔渲染**：扫描 `renderers/` 目录加载渲染后端；内置 puppeteer 后端，浏览器懒启动 + 空闲自动关闭。
- **Redis 可选**：连接失败且为本机地址时可降级为内存实现（`config/jiuli.yaml → redis_fallback`），
  内存实现覆盖插件常用命令。
- **其余**：多账号（`Bot.uin` 随机语义完整保留）、插件热重载、适配器契约（`Bot.adapter.push`）、
  HTTP/WS 服务与文件托管（`Bot.fileToUrl`）、定时任务、跨插件 handler 总线、上下文会话。

## 快速开始

```bash
pnpm install && pnpm start     # 安装依赖 → 自动构建 → pm2 后台启动（一条命令）
```

常用命令（CLI 与 npm scripts 等价）：

| 命令 | 说明 |
|---|---|
| `pnpm start` | pm2 后台启动（自动检查依赖/构建/配置；`pnpm start --fg` 前台） |
| `pnpm stop` | 停止 |
| `pnpm rs` | 重启（重启完成后会通知到原会话） |
| `pnpm log [条数]` | 查看日志（`pnpm log -f` 持续输出） |
| `pnpm run setup` | 仅安装依赖 + 编译内核 + 生成配置 |
| `pnpm app` | 前台直接运行（`node .`） |
| `pnpm build` / `pnpm watch` / `pnpm typecheck` | 编译 / 增量编译 / 类型检查 |
| `pnpm test` | 冒烟测试（27 项：旧插件 / 内置插件 / 渲染 / 诊断） |
| `pnpm test:hot` | 热重载测试（新增 / 修改 / 删除 js、新建目录） |
| `pnpm test:restart` | 守护进程与重启契约测试 |
| `pnpm jiuli create <名称>` | 生成插件骨架（`--dsl` 用函数式形态，`--dir` 建独立目录） |
| `pnpm jiuli add <git地址>` | 安装第三方插件（克隆到 `plugins/` 并自动装依赖） |
| `pnpm jiuli list` | 列出 `plugins/` 下的插件目录 |
| `pnpm jiuli status` | 环境与运行状态 |

启动模式：

| 命令 | 进程模型 | 重启行为 |
|---|---|---|
| `node .`（默认，internal） | 守护进程 + 主进程，同一终端 | `#重启` 时主进程以 255 退出，守护进程**在同一终端**重新拉起（不开新窗口） |
| `pnpm start`（pm2） | pm2 后台管理 | `#重启` 交给 pm2，日志用 `pnpm log` 查看 |
| `node . start`（external） | 单进程 | 以 255 退出，交给外部管理器（systemd/supervisor）拉起 |
| `node . stop` | — | 请求运行中的实例退出 |

### 终端直接输入指令

内置标准输入适配器：`node .` 启动后（TTY 环境）终端会出现 `> ` 提示符，
直接输入 `#帮助`、`#状态`、`#版本` 等指令即可，机器人回复会打印回终端。
默认配置的主人账号就是 `stdin:stdin`（`config/config/other.yaml → master`）。

无协议端调试也内置了 Mock 适配器（日志打印机器人发出的消息）；设置 `JIULI_MOCK_STDIN=1`
后可用 JSON 事件驱动：`{"type":"message","group_id":"123456","user_id":"10001","msg":"#帮助"}`

### 内置插件

框架自带开箱可用的基础功能（与云崽一致，均为 JiuLi 原生写法）：

| 目录 | 是谁的 | 内容 |
|---|---|---|
| `plugins/example/` | **你的** | 自己写的插件（一个 `.js` 一个功能），新增/修改/删除**即时热重载**；`pnpm jiuli create` 默认生成到这里 |
| `plugins/system/` | 框架 | `#帮助` `#插件列表` `#状态` `#诊断` `#版本` `#设置主人` `#撤回` `#添加/#删除/#消息列表`（词条） `#重载` `#重启` `#关机` `#停止` `#日志` `#更新` `#Bot上线/#Bot下线` |
| `plugins/adapter/` | 框架 | `stdin.js`（终端交互）、`mock.js`（无协议端调试） |
| `plugins/demo/` | 框架 | 示例：`demo-class.js`（类形态） `demo-dsl.js`（DSL） `render-demo.js`（`#渲染测试` `#渲染列表` `#渲染图片` `#渲染长图`） |
| `plugins/其他目录/` | 第三方 | clone 来的插件（如 `Yunzai-QQBot-Plugin`），不入 git，依赖由 `pnpm install` 自动装 |

目录地图、加载规则、写法速查：见 **[plugins/README.md](plugins/README.md)**。

### 日志

```
──────── JiuLi ────────
JiuLi v0.1.0 启动中…
兼容模式 · 对外标识 TRSS-Yunzai v3.1.3
[  Server ] 启动 HTTP 服务器 http://[::]:2536
[  Render ] 渲染后端 puppeteer 已就绪 · 类型 image · 支持 script 是
[  Plugin ] 插件 26 个 · 规则 47 条 · 事件监听 8 个 · 定时任务 2 个 · 用时 1秒768
[ Adapter ] 适配器 3 个 · Mock(QQ) · 标准输入(stdin) · QQBot(QQBot)
[  Online ] JiuLi 就绪 · 用时 3秒234 · 在线账号 2 个
──────── 启动完成 ────────

[   Msg   ] 收 ◀ 群 测试群(888777666) · 小明(10001) · 主人 · #状态
[  Plugin ] 中 ▶ 状态统计 <system/status.js> · 规则 /^#(状态|统计)/ · 方法 status · 优先级 5000
[   Msg   ] 发 ▶ 群 测试群(888777666) · 转发(2节点) · 由 状态统计 · 0ms
[  Plugin ] 状态统计 <system/status.js> · 完成 · 73ms
```

- 收到/发出消息的内容都会记录（含图片大小、@、转发节点数等摘要），`config/config/bot.yaml → log_msg: false` 可关闭
- 浏览器启动细节：程序路径 / 模式 / 参数 / 数据目录 / 重启与空闲策略，截图会记录模板、体积、耗时、累计张数
- `#日志` 可直接把最近日志发到聊天里；日志文件在 `logs/jiuli.YYYY-MM-DD.log`（错误另存 `logs/error/`）

### 开始写自己的插件

```bash
pnpm jiuli create my-plugin          # 生成 plugins/my-plugin/index.js（带注释的骨架）
pnpm jiuli create my-plugin --dsl    # 函数式 DSL 形态
```

`plugins/` 里各种文件夹分别是什么、加载规则、最小示例：见 **[plugins/README.md](plugins/README.md)**；
事件对象字段、权限、上下文会话、渲染、适配器等完整说明：见 **[docs/plugin-guide.md](docs/plugin-guide.md)**。

## 目录结构

```
jiuli/
├─ app.js                 启动入口（启动模式切换）
├─ jiuli.mjs              CLI：init / create / start / stop / rs / log / build / test / status
├─ templates/             插件骨架模板（pnpm jiuli create 使用）
├─ src/                   ★ 内核 TypeScript 源码（构建产物到 lib/core）
│   ├─ index.ts           原生插件 API（JiuLiPlugin / definePlugin / command / task / accept ...）
│   └─ core/              内核：bot / loader / plugin / config / redis / render / events / metrics ...
├─ lib/                   运行时目录
│   ├─ core/              ← 由 tsc 生成（勿手改）
│   ├─ plugins/*.js       兼容层 shim：plugin / loader / handler / runtime / config(makeConfig)
│   ├─ config/*.js        兼容层 shim：config(cfg) / init / log / redis
│   ├─ common/common.js   common 工具
│   ├─ puppeteer/         旧式截图入口
│   ├─ renderer/          渲染后端加载器 + art-template Renderer
│   ├─ events/            事件监听器（message / notice / request / connect / online）
│   ├─ listener/          监听器基类
│   ├─ modules/           oicq / md5 / node-fetch 兼容包（pnpm link:）
│   └─ util.js            工具集合
├─ renderers/puppeteer/   渲染后端实现（可自行扩展 renderers/<name>/）
├─ plugins/               插件目录（详见 plugins/README.md）
│   ├─ example/           你自己的插件（平铺 js，即时热重载）
│   ├─ system/  adapter/  框架内置插件与适配器（随仓库）
│   ├─ demo/              示例插件与渲染模板（随仓库）
│   └─ <第三方插件>/       不入库（.gitignore），依赖由 pnpm workspace 安装
├─ config/
│   ├─ default_config/    默认配置（随仓库提供）
│   ├─ config/            用户配置（首次启动自动生成，不入库）
│   └─ <插件>.yaml        插件配置（可能含凭据，不入库）
├─ test/smoke.mjs         冒烟测试（21 项）
└─ docs/                  架构说明、插件开发指南、重构调研报告
```

## 架构：三层隔离

| 层 | 位置 | 职责 |
|---|---|---|
| 内核 | `src/` → `lib/core/` | 纯 TS，无全局依赖：事件总线、插件注册与分发、适配器契约、渲染协议、配置中心、存储、指标、日志 |
| 兼容层 | `lib/**`（手写 JS） | 复刻云崽契约的薄 shim：物理路径、全局变量、`e` 对象、`Bot` 语义。旧插件通过它无感接入内核 |
| 插件 | `plugins/**` | 旧插件（`extends plugin`）与 JiuLi 原生插件（类 / DSL）共用同一套注册与分发 |

关键点：**旧插件里写死的相对路径 import（如 `../../lib/plugins/plugin.js`）决定了兼容层必须物理存在于 `lib/` 下**，
因此 JiuLi 不重命名这些路径，而是把它们做成转发到内核的 shim。内核永不 import 插件，插件依赖通过动态导入与扩展点解耦。

消息流转：

```
适配器 Bot.em('message.group.normal', e)
  → Bot.prepareEvent(e)           补全 bot/friend/group/member/sender/reply
  → lib/events/message.js         监听器
  → PluginsLoader.deal(e)         黑白名单 → 冷却 → 事件处理 → 回复包装 → runtime 挂载
  → 事件索引取候选插件 → checkDisable/filtEvent
  → accept（短路）→ rule 正则匹配 → 权限校验 → 调用插件方法
  → 插件 e.reply(...) → 适配器发送
```

详见 [docs/architecture.md](docs/architecture.md)。

## 兼容性说明

**已支持**（冒烟测试覆盖）：

- 插件基类 `plugin`：`name/dsc/event/priority/rule/task/handler/namespace`，
  `reply / conKey / setContext / getContext / finish / awaitContext / resolveContext / renderImg`
- `rule`：`reg`（字符串/正则）、`fnc`（方法名）、`event` 三段通配、`permission`、`log:false`
- `task`：cron（5/6 段，`node-schedule`）、`fnc` 支持方法名与函数
- `accept(e)` 钩子、`init()` 钩子（返回 `"return"` 跳过加载）
- 事件对象：`msg / img / at / atBot / isGroup / isPrivate / isMaster / reply(msg, quote, {recallMsg, at}) / getReply / recall / logText`
  与 `e.group / e.friend / e.member / e.bot` 方法面
- 全局：`Bot / logger / redis / segment / Renderer / plugin / start_type`；
  可 import：`lib/config/config.js`(cfg) / `lib/plugins/*` / `lib/common/common.js` / `lib/puppeteer/puppeteer.js` / `lib/util.js`
- 配置：`config/default_config/*.yaml` + `config/config/*.yaml`（bot / other / group / redis / renderer / server / db），
  `cfg.getGroup/getConfig/getdefSet/getYaml/getOther/master/masterQQ/uin/package`
- 消息计数键：`Yz:count:<receive|send>:msg:{total|bot:ID|user:ID|group:ID}:{day|month|year|total}`（与云崽一致，旧插件可读）
- 渲染：`e.runtime.render(plugin, path, data, cfg)` 与 `lib/puppeteer/puppeteer.js` 的 `screenshot/screenshots`，
  模板目录约定 `plugins/<插件>/resources/<path>.html`，`temp/html` 落盘、`pluResPath/_res_path/tplFile/saveId`
- 适配器：`Bot.adapter.push({ id, name, path, load() })`，`Bot[uin] = { pickFriend/pickGroup/pickMember, fl/gl/gml, stat, ... }`，
  `Bot.em('connect.<id>', ...)`、`Bot.wsf[path]`、`Bot.express`
- 热重载：平铺插件文件的新增/修改/删除（有 `index.js` 的目录不监听，与云崽一致）

**框架探测**：部分生态插件通过 `package.json` 名称/版本判断框架（如 miao-plugin、genshin、steam-plugin）。
`config/jiuli.yaml → compat.spoof_yunzai` 默认开启，会对外暴露 `name: trss-yunzai` 与兼容版本号；如需关闭请自行评估。

**实机验证记录**：

- `Yunzai-QQBot-Plugin`（QQ 官方机器人适配器，依赖 qq-official-bot / fastify / silk-wasm 等）：
  放入 `plugins/` 后依赖由 pnpm workspace 自动安装，适配器加载成功并完成鉴权连接
  （日志：`[AUTH] 访问令牌已设置` → `[WebSocketReceiver] 欢迎 XXX` → `QQBot(QQBot) ... 已连接`）。

**已知限制**：

- 直接读取框架内部状态的插件（如 `loader.dealEvent`、`loader.load_time`）已提供，但更深层的内部字段不保证一致；
- 依赖 `e.runtime.MysInfo / NoteUser / MysUser` 的插件（genshin 生态）需要 `plugins/genshin` 存在，JiuLi 会动态加载；
- `plugins/miao-plugin` 的 `#miao` / `#miao.models` 别名已在根 `package.json#imports` 中保留；
- 渲染后端需自行扩展时，按 `renderers/<name>/index.js` 约定导出 `(config) => renderer`。

## JiuLi 原生插件

`plugins/demo/` 下有可直接参考的示例。

函数式 DSL：

```js
import { definePlugin, command, task, accept } from 'jiuli'

export default definePlugin({
  name: '示例',
  apps: [
    command(/^#?(玖璃|jiuli)你好$/, async (e, match) => e.reply('你好'), { name: '打招呼' }),
    command(/^#管理$/, async e => e.reply('ok'), { permission: 'master' }),
    task('0 8 * * *', () => logger.mark('早安'), { name: '早安' }),
    accept('notice.group.poke', async e => e.reply('别戳了')),
  ],
})
```

类形态：

```js
import { JiuLiPlugin } from 'jiuli'

export default class Demo extends JiuLiPlugin {
  constructor() {
    super({ name: '示例', priority: 100, event: 'message', rule: [{ reg: '^#渲染$', fnc: 'render' }] })
  }
  async render() {
    const img = await this.render('hello/index', { title: '你好' }) // base64:// 或 false
    return this.reply(img || '渲染失败')
  }
}
```

详见 [docs/plugin-guide.md](docs/plugin-guide.md)。

## 配置

`config/config/jiuli.yaml`（首次启动自动生成）：
```yaml
compat:
  spoof_yunzai: true        # 伪装成 TRSS-Yunzai（部分插件据此判断框架）
  name: trss-yunzai
  version: 3.1.3
  globals: true             # 注入全局变量
  runtime: true             # 注入 e.runtime（懒加载）
redis_fallback: true        # Redis 不可用时降级为内存实现
perf:
  metrics: true             # 插件耗时统计
  slow_plugin_ms: 3000      # 慢插件告警阈值
  count_flush_ms: 1000      # 计数写回间隔（0 = 实时）
  once_instance: true       # accept 与 rule 复用同一实例
  event_index: true         # 事件类型索引
```

## 开发

```bash
pnpm build        # 编译 TS 内核（src → lib/core）
pnpm watch        # 增量编译
pnpm typecheck    # 仅类型检查
pnpm test         # 冒烟测试
node jiuli.mjs status   # 环境与运行状态
```

修改兼容层（`lib/**` 手写 JS）后无需编译；修改内核或内置插件（`src/**`、`plugins/**` 的原生插件）后需 `pnpm build`。

> **多实例 / 测试隔离**：设置环境变量 `JIULI_CONFIG_DIR=/path/to/config/` 可让该实例使用独立的用户配置目录
> （测试脚本就是这么做的，默认 `config/config/`）。
>
> **维护提示**：升级或调试时**不要删除 `data/`、`logs/`、`config/config/`**——它们是运行状态（数据、日志、主人与群配置）。
> 框架已对"目录被清理"做了自愈（写文件前先确保目录存在），但正在运行的实例仍可能短暂报错。
> 需要重置配置时，删掉对应单个 `config/config/*.yaml` 让它重新生成即可。

> 版本管理策略与云崽一致：只跟踪 `plugins/{adapter,system,other}` 与示例插件，
> 第三方插件与其 `node_modules`、`config/*.yaml`（可能含账号凭据）都不入库。

## 路线图

- [x] Phase 1：内核 + 兼容层 P0（Bot / logger / redis / segment / plugin / cfg / loader / e 对象 / 渲染双通道）
- [x] 内置插件：`system`（状态/帮助/设置主人/词条/撤回…）、`other`（重启/关机/更新/日志/版本）、`adapter/stdin`
- [x] 一键启动与进程管理：`jiuli` CLI + pm2（`pnpm start / stop / rs / log`）
- [x] 冒烟测试 21 项：旧插件 rule/accept/上下文 + 原生双形态 + 内置插件 + 词条 + 计数 + 渲染
- [x] 适配器实机验证：stdin（终端交互）、Yunzai-QQBot-Plugin（QQ 官方机器人）
- [x] 日志重写：消息收发内容（收 ◀ / 发 ▶）、命中插件与正则、浏览器启动细节、启动摘要
- [x] `#诊断` 指令（适配器 / 在线账号 / 插件 / 渲染 / 最近收发）+ 渲染自检插件（`plugins/demo/render-demo.js`）
- [ ] Phase 2：`plugins/adapter/*`（OneBotv11 / Milky / Satori …）实机验证与补齐
- [ ] Phase 3：原生插件脚手架、类型包细化、`Bot.express` 路由助手、WebUI 配置页
- [ ] Phase 4：指标面板、热重载补全（含 index.js 目录与 resources）
- [ ] Phase 5：生态插件逐个实机验证（miao-plugin / genshin / Guoba …），建立「已知不兼容列表」

## 许可

AGPL-3.0（与 TRSS-Yunzai 保持一致）。本项目是 TRSS-Yunzai 的重构版本，
保留了原作者（TimeRainStarSky、Yoimiya-Kokomi、Le-niao 等）的著作权声明。
