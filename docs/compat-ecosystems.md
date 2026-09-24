# 生态兼容使用手册

JiuLi 除了云崽（TRSS-Yunzai）插件，还能加载 **Koishi**、**GsCore（早苗）**、**AstrBot** 的插件。
本文是使用说明：怎么开启、怎么装插件、哪些功能能用、出问题怎么查。

> 这个能力目前在 **`v2` 分支**上，是探索性实现，**暂不建议用于生产环境**。
> 分支定位与整体兼容情况见 [V2.md](../V2.md)。

## 一、装之前先确认

| 生态 | 插件从哪来 | 额外要求 | 成熟度 |
|---|---|---|---|
| **Koishi** | npm 上的 `koishi-plugin-*` | 无 | 较好：纯逻辑插件基本都能用 |
| **GsCore（早苗）** | 早苗系列插件（gsuid_core 的 `plugins/` 目录） | Python 3.11+ | 一般：轻中量插件可用，绘图类不行 |
| **AstrBot** | AstrBot 市场的 `astrbot_plugin_*` | Python 3.11+ | 一般：指令 / 消息类可用，AI 类不行 |

三个生态可以同时开，也可以只开一个。默认全部关闭，不影响原本的云崽插件。

**需要 Python**：装 GsCore / AstrBot 插件要求机器上能跑 Python 3.11 以上。
兼容层会依次尝试 `py -3`（Windows）、`python3`、`python`，探测不到时会提示你在配置里写死路径。

## 二、开启

编辑 `config/config/compat.yaml`：

```yaml
enabled: true

ecosystems:
  koishi:
    enabled: true
  gscore:
    enabled: true
    python: ''      # 留空自动探测；也可以写死解释器路径（如 /usr/bin/python3）
  astrbot:
    enabled: true
    python: ''
```

改完 `#重启`。启动日志应该能看到（插件名按实际显示）：

```
[  Compat ] 开始加载生态兼容宿主：koishi · gscore · astrbot
[  Compat ] Koishi 插件 3 个 · koishi-plugin-a · koishi-plugin-b · koishi-plugin-c
[  Compat ] Koishi 兼容宿主已就绪 · 插件 3 个
[  Compat ] GsCore 插件 2 个 · 插件甲 · 插件乙
[  Compat ] GsCore 兼容宿主已就绪 · GsCore 插件 2 个 · 插件甲 · 插件乙
[  Compat ] AstrBot 插件 1 个 · astrbot_plugin_xxx
[  Compat ] AstrBot 兼容宿主已就绪 · AstrBot 插件 1 个 · astrbot_plugin_xxx
```

某个生态起不来时，紧接着会有一行 `xxx 兼容宿主加载失败：原因`，照着第六节查。

### 配置项说明

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关，关掉后完全不加载外来插件 |
| `timeout_ms` | `15000` | 一条消息交给外来插件处理的最长时间。超时就把这条消息交回云崽插件，避免某个插件卡住整个机器人 |
| `intercept` | `true` | 外来插件回过消息后，同一条消息不再给云崽插件。想让两边都跑就改成 `false` |
| `ecosystems.<生态>.enabled` | `false` | 单个生态的开关 |
| `ecosystems.gscore.python`<br>`ecosystems.astrbot.python` | 空 | Python 解释器路径，留空自动探测 |
| `ecosystems.<生态>.env` | 空 | 传给插件的环境变量（有些插件需要 token 之类） |
| `ecosystems.koishi.plugins` | 空 | 一般不用填。`pnpm add` 装的会自动加载；需要单独给某个插件传配置时才写包名 |
| `ecosystems.koishi.config` | 空 | 传给 Koishi 插件的配置：`{ "插件包名": { ... } }` |
| `ecosystems.koishi.database` | 空 | 需要数据库的 Koishi 插件才要填，见 3.1 |

## 三、装插件

### 3.1 Koishi 插件

Koishi 插件是 npm 包，装到兼容层目录里：

```bash
cd plugins/compat
pnpm add koishi-plugin-xxx
```

装完 `#重启` 即可，**不用再改配置** —— 宿主会自动加载 `plugins/compat/node_modules` 下
所有 `koishi-plugin-` 开头的包。

**想用自己 clone 的插件源码**（不是 npm 包）：把整个插件目录放到
`plugins/compat/pkgs/koishi/<包名>/`，里面要有 `package.json`。

**需要数据库的插件**（签到、金币、图库、好感度这类）：不装数据库时它们会
**加载成功但功能没反应**，启动日志里会有这样一行：

```
[  Compat ] Koishi 插件 xxx 依赖的服务不存在，它不会生效：database
```

按下面两步补上：

```bash
cd plugins/compat
pnpm add @koishijs/plugin-database-sqlite
```

```yaml
# config/config/compat.yaml
ecosystems:
  koishi:
    database: '@koishijs/plugin-database-sqlite'
```

### 3.2 GsCore（早苗）插件

```bash
# 1. 放插件：目录型插件要有 __init__.py
#    plugins/compat/pkgs/gscore/<插件名>/__init__.py
#    单文件插件也支持：plugins/compat/pkgs/gscore/<插件名>.py

# 2. 装插件自己声明的依赖
python -m pip install -r plugins/compat/pkgs/gscore/<插件名>/requirements.txt
```

> 插件目录名建议和插件代码里 `Plugins(name=...)` 保持一致，否则命令前缀配置会对不上。

### 3.3 AstrBot 插件

```bash
# 1. 放插件：目录里要有 main.py（建议连 metadata.yaml 一起）
#    plugins/compat/pkgs/astrbot/astrbot_plugin_xxx/

# 2. 装依赖
python -m pip install -r plugins/compat/pkgs/astrbot/astrbot_plugin_xxx/requirements.txt
```

> 插件目录名保持仓库原名（`astrbot_plugin_` 开头）最省事。

## 四、哪些功能能用

### Koishi

能用：

- 指令，含参数、选项（`-x`）、指令别名、子指令
- 消息监听（`ctx.on('message')`）、中间件
- 收发文本 / 图片 / @ / 表情 / 引用 / 语音 / 视频 / 文件
- 发网络请求（`ctx.http` 已内置，不用额外装）
- 插件主动推送消息

不能用：

- 数据库相关功能（除非按 3.1 装了数据库插件）
- 控制台、浏览器截图（puppeteer）、资源服务
- 撤回、取历史消息、表情回应等需要协议端配合的动作

### GsCore（早苗）

能用：

- 六种触发器：命令、全匹配、前缀、后缀、关键词、正则
- 插件前缀（`Plugins(prefix=...)`）、服务开关（`SL.lst[名字].disable()`）
- 发文本 / 图片 / @，按钮按原样发出
- 多步会话（`bot.receive_resp`）
- 定时任务（装了 `apscheduler` 就用真的，没装用内置的）
- 插件配置项读写（落在 `data/<插件名>/config.json`）
- 用户绑定类数据的增删查（JSON 文件存储）

不能用：

- **图片绘制**：GenshinUID / StarRailUID 这类重绘图插件跑不起来
- **真实数据库**：只有 JSON 文件存储，没有事务；复杂查询结果可能不准
- 网页控制台
- AI 自然语言触发（`to_ai`）
- 订阅消息的定时推送
- 米游社 / Enka / Amber 等数据接口

### AstrBot

能用：

- 指令，含参数（按类型自动转换）、子指令、指令组
- 正则触发、消息类型过滤、权限过滤、平台过滤
- 读插件配置（`_conf_schema.json`）
- 收发文本 / 图片 / @ / 引用，消息链
- 插件主动推送消息

不能用：

- **AI 相关**：调用模型、工具调用、Agent
- 插件自带的网页页面（Plugin Pages）
- 多步会话（`session_waiter`）
- 插件自己注册新平台

## 五、和云崽插件一起用时会发生什么

- 一条消息会**先给外来插件**；外来插件**回了消息**，这条消息就不再走云崽插件
- 外来插件只是"匹配上了但没回复"，**不影响**云崽插件
  （否则一个监听全部消息的插件会把云崽插件全挡掉）
- 想让两边都跑：`intercept: false`
- 外来插件处理超时（默认 15 秒）：这条消息交回云崽插件，日志里会有超时提示

## 六、出问题怎么查

先看启动日志，再对照下表：

| 日志里出现 | 含义 | 怎么处理 |
|---|---|---|
| `Koishi 兼容宿主加载失败` | koishi 本体没装上 | `cd plugins/compat && pnpm install` |
| `Koishi 插件 xxx 依赖的服务不存在，它不会生效` | 缺服务，通常是 database | 按 3.1 装数据库插件 |
| `GsCore/AstrBot 兼容宿主加载失败` | 没找到 Python 或缺依赖 | 看后面的原因；可在配置里写死 `python` 路径 |
| `xxx 插件加载失败：` + 堆栈 | 该插件缺 Python 包，或代码本身报错 | 按插件说明装依赖；堆栈里能看到缺哪个模块 |
| `xxx 插件处理超时` | 插件卡住了 | 调大 `timeout_ms`，或先禁用该插件 |
| `Python 进程已退出` | 边车进程崩了 | 看它上方的 stderr 输出；该生态本次运行内不可用，`#重启` 可恢复 |

几个常见现象：

- **插件在列表里，但发指令没反应**
  多半是它需要的服务或依赖不存在。Koishi 插件缺服务时**不会报错**，
  只有启动日志里那一条警告，先翻日志。
- **指令被云崽插件抢了**
  说明外来插件这次没有回消息（拦截判定看的是"有没有回复"）。
  检查插件是否真的触发了；必要时把 `intercept` 设为 `false` 并观察两天再定。
- **`on_prefix` 类型的命令要连着写**
  早苗插件的"前缀"触发器要求参数紧贴命令：`前缀测试abc` 能触发，`前缀测试 abc`（带空格）不能。
  带空格参数的用"命令"类触发器。
- **第一次装完 Python 插件启动慢**
  正常，边车是常驻进程，之后启动约 0.5 秒。

## 七、关闭或卸载

- 临时关闭：`config/config/compat.yaml` → `enabled: false`，然后 `#重启`
- 只关某个生态：把对应的 `enabled` 改成 `false`
- 不想要这个功能：直接用 `master` 分支 —— 兼容层只存在于 `v2`，不会再合并回 `master`

## 八、相关文档

- [V2.md](../V2.md) —— 这个分支是什么、整体兼容情况、后续计划
- [plugins/compat/README.md](../plugins/compat/README.md) —— 兼容层目录结构、回归测试用的插件样本来源
- [plugin-guide.md](plugin-guide.md) —— 怎么写云崽插件（不是外来插件）
