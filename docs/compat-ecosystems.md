# JiuLi v2 · 兼容 Koishi / GsCore / AstrBot 插件

> 结论先说：**可行，但三家不是一个难度。**
> Koishi 可以做到高保真（直接在进程内用官方 `koishi` 包跑真实 npm 插件）；
> GsCore 与 AstrBot 必须用 Python 边车（插件就是 Python 模块，没有清单文件，也没法"解析"），
> 兼容层能覆盖**公开插件 API 面**，覆盖不了它们的重运行时（PIL 绘图、SQLModel、WebUI、LLM Provider）。
> 本文给出每一家**已经实测跑通什么、明确跑不了什么**，以及为什么。

---

## 一、可行性分级（先说结论）

| 生态 | 插件语言 | 加载机制 | 本方案 | 保真度 | 主要缺口 |
|---|---|---|---|---|---|
| **Koishi** | JS/TS（npm 包） | `ctx.plugin(require('koishi-plugin-x'))` | **进程内直接依赖官方 `koishi` 包** | 高（除服务类插件） | `ctx.database` / `console` / `puppeteer` / `assets` |
| **GsCore（早苗/Sayu）** | Python | import 模块即注册（**无 manifest**） | Python 边车 + `gsuid_core` 仿制包 | 中（公开 API 面） | PIL 图像工具、SQLModel 真实表、WebConsole、AI Core、订阅调度 |
| **AstrBot** | Python | `Star` 子类 + 装饰器自动注册 | Python 边车 + `astrbot` 仿制包 | 中高（契约面 1:1） | LLM Provider / Agent、Plugin Pages、session_waiter |

三家的插件机制都**不支持"读取并解释"**：触发方式要么是 JS 里调 `ctx.command()`，要么是 Python import 时的装饰器副作用。
所以"兼容"只有两条路 —— 进程内跑真包（Koishi），或者起一个真解释器（两个 Python 生态）。
**纯 JS 重写宿主那条路是不通的**：GsCore 官方 core 本体 631 个 py / 153,865 行，GenshinUID 一个仓库就有 478 处 PIL 调用，
`await bot.send(pil_image)` 是常态；AstrBot 2252 个市场插件里大量直接用 `astrbot.core.*` 内部路径。

---

## 二、架构

```
                 ┌─────────────────── JiuLi 主进程（Node） ───────────────────┐
  协议端 ──► Bot.em('message.…', e) ──► lib/events/message.js ──► loader.deal(e)
                                                                      │
                     补全 e.msg / atBot / isGroup / isMaster / 别名 / 黑白名单 / 冷却
                                                                      │
                          beforeMessage 钩子（plugins/compat/index.js，priority -1e9）
                                                                      │
                              lib/compat/bridge.js：e → 通用事件（camelCase）
                                                                      │
                    ┌─────────────────────────────────────────────────┼──────────────────┐
                    ▼                                                 ▼                  ▼
          Koishi 宿主（进程内）                          Python 边车（stdio JSON）   …
     new Context() + 自定义 Bot                         boot_gscore.py / boot_astrbot.py
     ctx.plugin(真实 npm 插件)                           gsuid_core / astrbot 仿制包
                    │                                                 │
                    └────────── 通用元素 → toSegments → e.reply ───────┘
                                                                      │
                                                          适配器发送 / Mock 记录
```

### 目录

```
lib/compat/
  bridge.js           通用事件与消息模型（生态无关，Node/Python 两侧共用同一份约定）
  paths.js            兼容目录解析（受 JIULI_PLUGINS_DIR 影响，便于多实例 / 测试隔离）
  index.js            宿主注册表 + 生命周期 + 带超时的分发 + 拦截判定
  hosts/
    koishi.js         Koishi 宿主（进程内真包）
    _python.js        Python 边车宿主（两个 Python 生态共用：进程托管 + 协议编解码）
    gscore.js         GsCore 宿主（配置 _python.js）
    astrbot.js        AstrBot 宿主（配置 _python.js）
  py/
    jiuli_bridge.py   Python 侧传输层（异步：读线程 + 主循环派发，绝不阻塞读线程）
    boot_gscore.py    GsCore 引导：加载插件 → 前缀展开 → 钩子 → 事件派发
    boot_astrbot.py   AstrBot 引导：加载插件 → 实例化/二次绑定 → 钩子 → filter 链 → 派发
    gsuid_core/       gsuid_core 仿制包（30+ 模块）
    astrbot/          astrbot 仿制包（api.* 契约面 + core.* 半公开面）

plugins/compat/
  index.js            接入 JiuLi 分发的"一个云崽插件"（beforeMessage 钩子）
  package.json        Koishi 桥接依赖与外来 npm 插件的安装位置
  hosts/              用户可放同名文件覆盖内置宿主
  pkgs/
    koishi/           Koishi 插件（手动放的目录，或 cd plugins/compat && pnpm add koishi-plugin-x）
    gscore/           GsCore 插件（目录型 __init__.py 或单文件 .py）
    astrbot/          AstrBot 插件（含 main.py 的目录）

config/default_config/compat.yaml   总开关 / 超时 / 拦截 / 各生态配置
```

### 事件流上的两个关键设计

1. **用 `beforeMessage` 钩子而不是自己监听 `Bot.on('message')`**
   钩子跑在内核补全 `e`（`msg` / `atBot` / `isGroup` / `isMaster` / 别名剥离 / 黑白名单 / 冷却）之后、
   云崽插件规则匹配之前。既有完整上下文，又能决定要不要拦截，不用把权限与限流再实现一遍。

2. **拦截判定是"外来插件真的回了消息"，不是"它匹配上了"**
   `lib/compat/index.js` 比较出站计数：Koishi 侧看宿主 Bot 有没有发送，Python 侧看 `bridge.sent` 有没有增长。
   为什么不能"命中即拦截"：GsCore 的 `on_message`、AstrBot 的 `event_message_type(ALL)` 会匹配**每一条**消息，
   按"命中即拦截"的话，装一个这样的插件就会把整个云崽插件生态吞掉。
   `intercept: false` 可以整体关掉拦截，两边都跑（迁移期对比行为用）。

---

## 三、Koishi：进程内跑真包（保真度最高）

**做法**：`plugins/compat` 里装官方 `koishi`，宿主 `new Context()` 起一个真实 Koishi 应用，
用一个自定义 `Bot` 子类把 JiuLi 消息灌进 Koishi 事件流，再把 Koishi 发出的消息转回 JiuLi。

**为什么不自研 ctx**：Koishi 插件拿到的 ctx 是 cordis 的 Context —— 服务注入（`inject` 的等待与回滚）、
Fiber 副作用回收、`Command/Argv` 解析器（`cmd.option()` / `.alias()` / `argv.options`）都在里面。
自研一套是数万行并且要跟上游演进。用真包这些全部免费获得，代价只是多一个依赖
（实测 koishi 依赖树 25 个包 / 约 2.1 MB，装在 `plugins/compat/node_modules`，不影响内核轻量）。

### 已实测

- 真实 npm 社区插件 `koishi-plugin-markdown` **原样加载**（解析、default 解包、注册全通）
- `ctx.command().action()`、`ctx.on('message')`、`ctx.middleware()`（含返回值自动发送）三种写法全部工作
- `h` 元素双向映射：`h.at` / `h.img` / `h.text` / `h.quote` ↔ JiuLi segment；`session.content` 的 `<at id="…"/>` 语法按 Koishi 规则解析
- 真实内核集成：`loader.deal()` 全链路，且命中后云崽插件不再重复回复

### 缺口与原因

| 缺失 | 后果 | 怎么补 |
|---|---|---|
| `ctx.database` | `inject: ['database']` 的插件**静默不加载**（cordis 注入语义是"等"）。宿主会主动预检并打一行警告 | `compat.yaml → koishi.database: '@koishijs/plugin-database-sqlite'`（需自行安装） |
| `ctx.console` / `puppeteer` / `assets` / `canvas` | 依赖这些服务的插件不激活 | 按需安装官方插件并填进 config |
| `ctx.http` | 已内置加载 `@koishijs/plugin-http`（从 koishi 自身位置解析，pnpm 隔离下必须这么做） | — |

> ⚠️ **cordis 的 `inject` 未满足时不报错、不执行 `apply`、也没有 error 事件** —— 这是最容易误判成"加载成功"的坑。
> 宿主已经加了依赖预检，缺服务时会明确告警。

---

## 四、GsCore（早苗 / gsuid_core）：Python 边车

**为什么必须边车**：插件是普通 Python 模块，放在 `plugins/<包名>/__init__.py`，
**没有任何清单文件**，触发器是 `@sv.on_command(...)` 这类装饰器在 import 时的副作用。
实测 4 个真实插件仓库共 856 条 `from gsuid_core… import`，涉及 60 个不同模块路径。
更关键的是：`convert_img` / `image_tools` / `utils.fonts` / `get_error_img` 收发的是 **PIL Image 对象**，
`await bot.send(pil_image)` 是常态；数据库是 SQLModel；配置是 msgspec.Struct。
这些只能在 Python 里跑。

### 已实测

- **官方回归插件 `gsuid_core/buildin_plugins/gs_test.py` 原样下载、未改一行、可以跑**（`on_fullmatch` / `on_prefix` / `on_regex` / `gs_subscribe` 全部命中）
- 6 种触发器语义与源码逐条对齐：`on_command`（不要求带参）、`on_prefix`（**必须带后续内容，且参数要紧贴命令**）、
  `on_fullmatch`、`on_suffix`、`on_keyword`、`on_regex`（命名分组填进 `ev.regex_dict`）
- 中英交界空格弹性（`gs查询` ≈ `gs 查询`）
- `Plugins` 前缀展开：`prefix=['gs']` + `on_command('查询深渊')` → `gs查询深渊` 与 `查询深渊` 都能触发
- `SV` 单例、`SL.lst[name].disable()/enable()` 开关、`Plugins` → `SV` 的 `self_plugin_name` 继承
- `bot.send(str | bytes | Message | MessageSegment | list)`、`bot.receive_resp`（多步会话，**读线程不阻塞**）、`bot.send_option`、`bot.t()`
- 事件字段映射：`bot_id` / `bot_self_id` / `user_id` / `group_id` / `sender` / `raw_text` / `regex_dict` / `session_id`
- 轻量 JSON 落盘的数据库模型（`GsBind.insert_uid` / `get_uid_by_game` / `bind_exists` / `GsUser.get_user_cookie_by_uid` …）
- `StringConfig` 配置真正持久化到 `data/<插件>/config.json`
- `scheduler`（装了 apscheduler 就用真的，否则用内置 interval/cron 兜底）、`on_core_start[_before]` 钩子

### 缺口（按影响排序）

| 缺失 | 说明 |
|---|---|
| `utils.image.image_tools`（24 处）/ `utils.fonts.fonts` / `utils.html_render` | PIL 绘图全套未实现 —— 这是 GenshinUID 系插件的核心能力 |
| `utils.database` 的 SQL 语义 | 提供的是 JSON 等价实现，**没有事务 / 并发控制 / SQL 表达式**（`row => ({money: $.sub(row.money, 100)})` 这类写法不支持） |
| `webconsole.*` | 只保证 import 与装饰器不报错，控制台页面不会出现 |
| `ai_core.*` 的 AI 触发 | `ai_return` / `ai_tools` 只做标记与记录，自然语言触发不生效 |
| 订阅推送调度 | `gs_subscribe` 存记录、能按目标发送，但没有 Core 的定时推送流程 |
| `utils.api.mys.*` / `enka` / `ambr` 等数据接口 | 未实现（属业务侧，插件自己带或另装） |

**结论**：用它跑"纯逻辑 + 收发消息"的 GsCore 插件没问题；跑 GenshinUID 那种重绘图重绑定的不行 ——
那种情况建议走下面第九节的**路线 A**。

### 一个容易踩的语义

`on_prefix` **要求参数紧贴命令**：`前缀测试abc` 命中，`前缀测试 abc`（带空格）**不**命中
（源码里 next char ∈ `_CMD_GAP` 就返回 False）。要"命令 + 空格 + 参数"用 `on_command`。

---

## 五、AstrBot（Star）：Python 边车

实测基准 **AstrBot v4.28.1**（克隆本体源码读实现，非仅文档），生态规模 **2252 个市场插件**。

### 已实测

- **官方模板 `Soulter/helloworld` 原样下载、未改一行、可以跑**（`@register` + `@filter.command` + `event.get_messages()`）
- 契约面实现：`astrbot.api.{event, event.filter, star, message_components, platform, provider, util, web}`
  \+ 真实插件大量直接 import 的半公开面 `astrbot.core.{message.components, config.astrbot_config, star.filter.*, platform.sources.aiocqhttp.*, agent.*}`
- `Star.__init_subclass__` 自动注册（按 `cls.__module__` 索引）、**实例化签名探测**（`cls(context, config)` → `TypeError` 回退 `cls(context)`）、
  **handler `functools.partial` 幂等二次绑定**（先还原 raw 再绑）
- 一个函数叠多个装饰器时 filter **累加**（AND 语义）；`priority` 参与排序
- filter 语义逐条对齐：`@filter.command`（要求 `is_at_or_wake_command`，参数按签名解析并强转，支持 `GreedyStr`）、
  `@filter.regex`（**不受唤醒前缀约束**）、`@filter.event_message_type`（`enum.Flag`，含文档漏掉的 `OTHER_MESSAGE`）、
  `@filter.platform_adapter_type`、`@filter.permission_type`、`@filter.command_group`（可无限嵌套）、`@filter.custom_filter`
- **派发前写入 6 组字段**（真实源码由 pipeline 写，不写就会出问题）：`role`（决定 `PermissionType.ADMIN`）、
  `is_wake`、`is_at_or_wake_command`、`message_obj.type` / `.group`、`platform_meta.name` / `.id`、`_session_isolated`
- 消息组件：`Plain / At / AtAll / Image / Record / Video / File / Face / Reply / Poke / Node / Nodes / Json …` 与 JiuLi segment 双向映射；
  `Image.fromURL/fromFileSystem/fromBase64/fromBytes`、`MessageChain` 的 `message/at/url_image/file_image/…`
- `event.plain_result / image_result / chain_result / send / stop_event / get_extra / set_extra / unified_msg_origin`
- `context.send_message(umo, chain)` 主动消息（`umo` 形如 `jiuli:FriendMessage:20000`，按 `MessageSession` 解析回来）
- `StarTools.get_data_dir` / `send_message` / `create_message`；metadata.yaml 逐字段覆盖装饰器、`_conf_schema.json` 生成配置

### 缺口

| 缺失 | 说明 |
|---|---|
| LLM Provider / Agent | `llm_generate` / `tool_loop_agent` / `get_current_chat_provider_id` 明确抛 `NotImplementedError`（不假装成功） |
| Plugin Pages（`astrbot.api.web`，FastAPI） | 注册被记录，但没有 Web 框架把请求转给插件 |
| `session_waiter` 多步会话 | 需要事件 pipeline 的会话拦截点，未实现（GsCore 侧的 `receive_resp` 是实现了的） |
| `PermissionType.SHARED_GROUP_ADMIN` 的隔离标记 | 依赖 pipeline 写 `_session_isolated`，当前恒为未设置 |
| 平台适配器（插件自己注册平台） | 不注册，`Platform` 子类不会被驱动 |
| `register_llm_tool` / `FunctionTool` 生态 | 只保证 import 与构造，不参与 LLM 调用 |

---

## 六、配置与使用

`config/config/compat.yaml`（首次启动从 `config/default_config/compat.yaml` 生成）：

```yaml
enabled: true            # 总开关
timeout_ms: 15000        # 外来插件处理一条消息的上限，超时交回 JiuLi（防止卡死整条分发）
intercept: true          # 外来插件回了消息就不再走云崽插件；false = 两边都跑

ecosystems:
  koishi:
    enabled: true
    plugins: []          # 额外加载的包名；不写则扫描 pkgs/koishi/
    database: ''         # 需要数据库时填 @koishijs/plugin-database-*（自行安装）
  gscore:
    enabled: true
    python: ''           # 留空自动探测 py -3 / python3 / python
    env: {}              # 传给插件的环境变量
  astrbot:
    enabled: true
```

装插件：

```bash
# Koishi：直接 pnpm add（装进 plugins/compat/node_modules）
cd plugins/compat && pnpm add koishi-plugin-xxx

# 或者手动放目录
#   plugins/compat/pkgs/koishi/<包名>/
#   plugins/compat/pkgs/gscore/<插件名>/__init__.py
#   plugins/compat/pkgs/astrbot/<插件名>/main.py + metadata.yaml

# Python 插件的依赖由插件自己声明（requirements.txt / pyproject），用 pip 装
python -m pip install -r plugins/compat/pkgs/astrbot/<插件名>/requirements.txt
```

冷启动耗时实测：三个宿主 + 各 2 个插件约 **3 秒**（Koishi import ≈ 0.6s，两个 Python 进程各 ≈ 0.5s，其余是插件 import）。

### 排错

- Koishi 插件"加载成功但没功能" → 多半是 `inject` 的服务不存在，看启动日志里的 `依赖的服务不存在` 警告
- Python 插件加载失败 → 日志里带完整 traceback（插件的 `print` 已被重定向到 stderr，不污染协议）
- 想知道兼容层现状 → `compat.status()`（`hosts[].plugins` / `.error`）

---

## 七、验证

```bash
pnpm test:compat               # 三个生态各自的单元链路
pnpm test:compat:integration   # 真实内核集成（loader.deal → 兼容层 → 外来插件 → 适配器）
pnpm test:compat:all           # 上面全部
```

| 测试 | 覆盖 | 实测结果 |
|---|---|---|
| `test/compat-koishi.mjs` | 指令 / message 监听 / 中间件 / 元素双向 / 拦截 | 14 项通过（含真实 npm 插件 `koishi-plugin-markdown`） |
| `test/compat-gscore.mjs` | 6 种触发器 / 前缀展开 / 多步会话 / 开关 / 字段映射 / 官方 `gs_test.py` | 23 项通过 |
| `test/compat-astrbot.mjs` | 指令带参与默认值 / regex / 监听 / 直接发送 / 权限 / 主动消息 / 官方 `helloworld` | 15 项通过 |
| `test/compat-integration.mjs` | 真实 `loader.deal` 全链路 + 与云崽插件抢同一指令时的拦截 | 10 项通过 |

三个生态各有一个**真实上游插件**作为回归样本（零改动）：
`Soulter/helloworld`（AstrBot 官方模板）、`gsuid_core/buildin_plugins/gs_test.py`（GsCore 官方回归插件）、
`koishi-plugin-markdown`（npm 社区包）。

> 本仓库的 `data/gsuid_compat` 是 GsCore 仿制包的 JSON 落盘目录（测试用 `JIULI_GS_COMPAT_DATA` 隔离）。

---

## 八、明确不建议 / 跑不了的情况

1. **GenshinUID / StarRailUID 这类重绘图插件** —— 需要 PIL 全套图像工具 + 真实 SQLModel 表 + 米游社数据接口。当前仿制包覆盖不了，硬跑会在 `utils.image.image_tools` 处 ImportError。
2. **AstrBot 的 AI 能力插件**（LLM 工具、Agent、Provider 切换）—— 需要把 provider 层接到 JiuLi 的模型配置上，属于下一步工作。
3. **依赖 Koishi console / puppeteer / assets 的插件** —— 需要装对应官方插件，兼容层只负责把它接进来。
4. **插件自带 Web 控制台页面**（AstrBot Plugin Pages / GsCore WebConsole）—— 没有转发的 Web 框架。

---

## 九、如果要把「重插件」也跑起来：路线 A

对 GsCore 而言还有一条比边车更保真的路，值得单独说明：

**Node 只当适配器，插件继续由真的 `gsuid_core` 进程托管。**

gsuid_core 本身就是"一个 Python 进程 + 插件注册表 + 事件队列"，它把协议端抽象成了 WS 适配器。
所以可以让 JiuLi 扮演那个适配器：

1. JiuLi 连 `ws://<core>/ws/<bot_id>?token=<WS_TOKEN>`，**注意用二进制帧发 UTF-8 JSON**（官方协议文档写 text 帧是错的，源码是 `receive_bytes`/`send_bytes`）
2. 平台消息 → `MessageReceive`（`bot_id` / `bot_self_id` / `msg_id` / `user_type` / `group_id` / `user_id` / `user_pm` / `sender` / `content`）
3. `MessageSend` → 逐段渲染成 JiuLi segment（`log_*` 只打日志、`image` 要处理 `base64://` 与 `link://`、`buttons` 有两种布局、`node` 不支持合并转发时要逐条展开）

好处：**全部 GsCore 插件（含 GenshinUID）零损失可用**，因为宿主、PIL、SQLModel 都用真的。
代价：用户要多跑一个 gsuid_core 进程，且插件配置在它的控制台里管理。

AstrBot 同理可以让 JiuLi 扮演 OneBot v11 协议端（AstrBot 原生支持 aiocqhttp 接入），
这条路的实现成本比仿制包更低、保真度更高，适合作为 v2 之后的方向。

---

## 十、后续可做

- [ ] 路线 A：GsCore WS 适配器 / AstrBot OneBot 协议端（吃掉重插件）
- [ ] GsCore `utils.image.image_tools` + `fonts` 的 PIL 实现（解锁绘图类插件）
- [ ] AstrBot LLM 层接到 JiuLi 的模型配置（`llm_generate` / `llm_tool`）
- [ ] `#诊断` 里展示兼容层状态（宿主、插件数、最近一次拦截记录）
- [ ] Koishi `ctx.database` 的可选内置（默认带一个 SQLite driver）
- [ ] 兼容层热重载：改 `plugins/compat/` 下的文件即时生效（目前要走 `#重载 兼容`）
