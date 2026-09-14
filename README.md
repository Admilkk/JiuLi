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
pnpm install          # 安装依赖（跳过 Chromium 下载，使用本机 Chrome/Edge）
pnpm build            # 编译 TypeScript 内核（src → lib/core）
node .                # 启动
```

- 启动模式：`node .`（internal）/ `node . start`（external）/ `node . pm2` / `node . daemon` / `node . stop`
- 无协议端调试：内置 `plugins/jiuli-adapter-mock`（日志中打印机器人发出的消息）；
  也可设 `JIULI_MOCK_STDIN=1`，之后每行输入一个 JSON 事件：
  ```json
  {"type":"message","group_id":"123456","user_id":"10001","msg":"#帮助"}
  ```
- 冒烟测试：`node test/smoke.mjs`
  （如需完整跑通旧插件用例，可把 TRSS-Yunzai 的部分插件复制到 `plugins/_legacy/`）

## 目录结构

```
jiuli/
├─ app.js                 启动入口（启动模式切换）
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
├─ plugins/               插件目录（旧插件直接放入即可；内置示例与 Mock 适配器）
├─ config/
│   ├─ default_config/    默认配置（随仓库提供）
│   └─ config/            用户配置（首次启动自动生成，勿提交）
├─ test/smoke.mjs         冒烟测试
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

**已知限制**：

- 直接读取框架内部状态的插件（如 `loader.dealEvent`、`loader.load_time`）已提供，但更深层的内部字段不保证一致；
- 依赖 `e.runtime.MysInfo / NoteUser / MysUser` 的插件（genshin 生态）需要 `plugins/genshin` 存在，JiuLi 会动态加载；
- `plugins/miao-plugin` 的 `#miao` / `#miao.models` 别名已在根 `package.json#imports` 中保留；
- 渲染后端需自行扩展时，按 `renderers/<name>/index.js` 约定导出 `(config) => renderer`。

## JiuLi 原生插件

`plugins/jiuli-example-dsl` 与 `plugins/jiuli-example-class` 是两个可直接参考的示例。

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
pnpm build        # 编译 TS 内核
pnpm watch        # 增量编译
pnpm typecheck    # 仅类型检查
node test/smoke.mjs
```

修改兼容层（`lib/**` 手写 JS）后无需编译；修改内核（`src/**`）后需 `pnpm build`。

## 路线图

- [x] Phase 1：内核 + 兼容层 P0（Bot / logger / redis / segment / plugin / cfg / loader / e 对象 / 渲染双通道）
- [x] 冒烟测试：旧插件 rule/accept/权限/转发消息 + 原生双形态 + 计数 + 渲染
- [ ] Phase 2：`plugins/adapter/*`（OneBotv11 / Milky / Satori …）与 `plugins/system/*` 实机验证与补齐
- [ ] Phase 3：原生插件脚手架、类型包细化、`Bot.express` 路由助手
- [ ] Phase 4：指标面板、热重载补全（含 index.js 目录与 resources）、WebUI
- [ ] Phase 5：生态插件逐个实机验证，建立「已知不兼容列表」

## 许可

AGPL-3.0（与 TRSS-Yunzai 保持一致）。本项目是 TRSS-Yunzai 的重构版本，
保留了原作者（TimeRainStarSky、Yoimiya-Kokomi、Le-niao 等）的著作权声明。
