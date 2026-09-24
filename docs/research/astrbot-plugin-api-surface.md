# AstrBot 插件（Star）体系 —— 精确 API 面清单

> 调研目的：为「让一个 Node.js 机器人框架加载并运行真实 AstrBot 插件」的兼容层提供实现依据。
> 基准版本：**AstrBot v4.28.1**（`git clone --depth 1 https://github.com/AstrBotDevs/AstrBot` 实测 `astrbot/__init__.py` → `__version__ = "4.28.1"`），Python 要求 `>=3.12`（PyPI `AstrBot` 4.28.1 `requires_python`）。
> 本报告所有代码片段均来自真实源码；`raw.githubusercontent.com/AstrBotDevs/AstrBot/master/<path>` 可直接访问对应文件。

来源总表：

| 来源 | URL |
|---|---|
| 官方文档总入口 | https://docs.astrbot.app/dev/star/plugin-new.html |
| 最小实例 | https://docs.astrbot.app/dev/star/guides/simple.html |
| 接收消息事件 | https://docs.astrbot.app/dev/star/guides/listen-message-event.html |
| 发送消息 | https://docs.astrbot.app/dev/star/guides/send-message.html |
| 插件配置 | https://docs.astrbot.app/dev/star/guides/plugin-config.html |
| 调用 AI | https://docs.astrbot.app/dev/star/guides/ai.html |
| 会话控制 | https://docs.astrbot.app/dev/star/guides/session-control.html |
| 杂项 | https://docs.astrbot.app/dev/star/guides/other.html |
| 旧指南（资源最全） | https://docs.astrbot.app/dev/star/plugin.html |
| 插件市场索引 API | https://api.soulter.top/astrbot/plugins |

---

## 一、目录布局与注册

### 1.1 目录布局

```
AstrBot/
  data/
    plugins/                       <-- 第三方插件存放目录（可被扫描发现）
      astrbot_plugin_xxx/
        metadata.yaml              <-- 必须，插件元数据（metadata.yml 亦可）
        main.py                    <-- 必须（或与目录同名的 <dir>.py）
        _conf_schema.json          <-- 可选，配置 Schema
        requirements.txt           <-- 可选，pip 依赖
        logo.png                   <-- 可选，WebUI Logo（1:1，推荐 256x256）
        .astrbot-plugin/i18n/*.json<-- 可选，插件国际化
        skills/<name>/SKILL.md     <-- 可选，随插件分发 Skill
        <任意子模块/包>             <-- 相对 import 可用（from .core.x import y）
  astrbot/
    builtin_stars/                 <-- 内置保留插件（reserved=true，不可卸载）
      astrbot/                     <-- 内置插件也遵守同一套规范
        metadata.yaml
        main.py
        skills/
      builtin_commands/
        metadata.yaml
        main.py
        commands/{admin,help,provider,...}.py
```

关键实现来自 `astrbot/core/star/star_manager.py` 的目录扫描函数（`_get_modules`，L290-320）：

```python
@staticmethod
def _get_modules(path):
    modules = []
    dirs = os.listdir(path)
    # 遍历文件夹，找到 main.py 或者和文件夹同名的文件
    for d in dirs:
        # Staged installs and rollback backups are not discoverable plugins.
        if d.startswith((".plugin-install-", ".plugin-upload-", ".plugin-backup-")):
            continue
        if os.path.isdir(os.path.join(path, d)):
            if os.path.exists(os.path.join(path, d, "main.py")):
                module_str = "main"
            elif os.path.exists(os.path.join(path, d, d + ".py")):
                module_str = d
            else:
                logger.info(f"Plugin {d} has neither main.py nor {d}.py; skipping it.")
                continue
            ...
            modules.append({"pname": d, "module": module_str, "module_path": ...})
    return modules
```

> 兼容层必须实现的发现规则：**扫描目录 → 目录内必须有 `main.py`（优先）或 `<目录名>.py` → 目录名即插件根名 → 以 `data.plugins.<目录名>.<module>` 作为模块全路径导入**（`star_manager.py` L1119-1120：`path = "data.plugins." + root_dir_name + "." + module_str`）。

### 1.2 metadata.yaml 字段全集

`PLUGIN_METADATA_FILENAMES = ("metadata.yaml", "metadata.yml")`，**必需字段** `("name", "desc", "version", "author")`，且必须是非空字符串（`astrbot/core/star/updater.py` L358-394 `_PluginUpdater.validate_plugin_metadata`）：

```python
PLUGIN_METADATA_FILENAMES = ("metadata.yaml", "metadata.yml")
PLUGIN_METADATA_REQUIRED_FIELDS = ("name", "desc", "version", "author")
PLUGIN_METADATA_MAX_BYTES = 1024 * 1024
...
missing_fields = [f for f in PLUGIN_METADATA_REQUIRED_FIELDS if f not in normalized_metadata]
if missing_fields:
    raise ValueError(f"{metadata_label} 中缺少必需字段: {', '.join(missing_fields)}。")
```

`desc` 可由 `description` 别名回退（`star_manager.py` L523-524）。

`StarMetadata` 的全部字段（`astrbot/core/star/star.py` L17-82），即 metadata.yaml 能喂进去的全部内容：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | str | ✅ | 插件唯一识别名；**必须是合法 Python 标识符且非关键字**（`_validate_importable_name`，L627-636），不能含 `/` `\` |
| `author` | str | ✅ | 作者 |
| `desc` | str | ✅ | 简介（可用 `description` 回退） |
| `version` | str | ✅ | 版本号，如 `v1.3.0` / `2.7.0-beta.2` |
| `short_desc` | str | ❌ | 市场卡片短描述，缺省回退 `desc` |
| `repo` | str\|None | ❌ | 仓库地址；缺省则无法自动更新 |
| `display_name` | str\|None | ❌ | WebUI 展示名（>= v4.5.0） |
| `support_platforms` | list[str] | ❌ | 取值为 `ADAPTER_NAME_2_TYPE` 的 key（见 §4.3） |
| `astrbot_version` | str\|None | ❌ | PEP 440 约束，如 `">=4.16,<5"`；不满足则阻止加载 |
| `pages` | list[dict] | ❌ | Plugin Pages（WebUI 自定义页面，>= v4.24.1） |
| `help` | str | ❌ | 文档/旧模板出现，但**不在** `StarMetadata` 映射里，会被忽略 |

实测三份真实 metadata.yaml：

```yaml
# https://raw.githubusercontent.com/Soulter/helloworld/master/metadata.yaml
name: helloworld
display_name: helloworld
desc: AstrBot 插件示例。
version: v1.3.0
author: Soulter
repo: https://github.com/Soulter/helloworld
```

```yaml
# https://raw.githubusercontent.com/Zhalslar/astrbot_plugin_apis/main/metadata.yaml
name: astrbot_plugin_apis
display_name: API聚合
desc: API聚合插件, 海量免费API动态添加, 支持用面板管理
help: 略
version: v3.1.2
author: Zhalslar
repo: https://github.com/Zhalslar/astrbot_plugin_apis
astrbot_version: ">=4.26.1"
```

```yaml
# https://raw.githubusercontent.com/SXP-Simon/astrbot_plugin_qq_group_daily_analysis/main/metadata.yaml
name: astrbot_plugin_qq_group_daily_analysis
display_name: 群分析总结插件
desc: "群日常分析总结插件 - 支持 OneBot (NapCat, LLOneBot, Snowluma)、QQ 官方机器人、Telegram、Discord；..."
version: v5.6.3
author: SXP-Simon
astrbot_version: ">=4.24.1"
support_platforms:
  - aiocqhttp
  - discord
  - telegram
  - qq_official
  - qq_official_webhook
repo: https://github.com/SXP-Simon/astrbot_plugin_qq_group_daily_analysis
```

### 1.3 插件类如何被注册

**重要：`@register(...)` 已废弃。** v3.5.19 之后 AstrBot 通过 `Star.__init_subclass__` 自动发现继承 `Star` 的类（`astrbot/core/star/base.py` L64-75；`register/star.py` L15-20 明确写了 `[DEPRECATED]`）：

```python
# astrbot/core/star/register/star.py
def register_star(
    name: str,
    author: str,
    desc: str,
    version: str,
    repo: str | None = None,
):
    """注册一个插件(Star)。
    [DEPRECATED] 该装饰器已废弃，将在未来版本中移除。
    在 v3.5.19 版本之后（不含），您不需要使用该装饰器来装饰插件类，
    AstrBot 会自动识别继承自 Star 的类并将其作为插件类加载。
    """
```

参数全集就是 **`name, author, desc, version, repo`**（没有 `star_cls` —— 类对象是装饰器直接接收的 `cls`；也没有单独的 `short_desc/display_name` 等）。**`metadata.yaml` 优先级高于该装饰器**（`star_manager.py` L1178 注释「yaml 文件的元数据优先」，随后逐字段覆盖 `metadata.name/author/desc/...`）。

自动注册机制：

```python
# astrbot/core/star/base.py
class Star(CommandParserMixin, PluginKVStoreMixin):
    """所有插件（Star）的父类，所有插件都应该继承于这个类"""
    def __init__(self, context: Context, config: dict | None = None) -> None:
        self.context = context
        ...

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        if not star_map.get(cls.__module__):
            metadata = StarMetadata(star_cls_type=cls, module_path=cls.__module__)
            star_map[cls.__module__] = metadata
            star_registry.append(metadata)
        else:
            star_map[cls.__module__].star_cls_type = cls
            star_map[cls.__module__].module_path = cls.__module__
```

即：**导入 `main.py` 时，`class X(Star)` 的定义语句本身就完成了注册**（写进全局 `star_map` / `star_registry`），随后 loader 用 `star_map[path]` 取回 `StarMetadata`，再做实例化。

**实例化签名探测（兼容层必须复刻）** —— `star_manager.py` L1225-1238：

```python
if plugin_config and metadata.star_cls_type:
    try:
        metadata.star_cls = metadata.star_cls_type(
            context=self.context, config=plugin_config,
        )
    except TypeError as _:
        metadata.star_cls = metadata.star_cls_type(context=self.context)
elif metadata.star_cls_type:
    metadata.star_cls = metadata.star_cls_type(context=self.context)
```

即：**有 `_conf_schema.json` → 先试 `(context=..., config=...)`，`TypeError` 则回退 `(context=...)`；无 schema → 只传 `context=`。** 实例化后 loader 会强行注入三个类属性：

```python
if metadata.star_cls_type:
    p_author, p_name = plugin_id.split("/")
    setattr(metadata.star_cls_type, "name", p_name)
    setattr(metadata.star_cls_type, "author", p_author)
    setattr(metadata.star_cls_type, "plugin_id", plugin_id)
```

`plugin_id` 定义为 `f"{author.lower()}/{name.lower()}"`（`star.py` L78-82）。

**Handler 绑定方式**：`Star.__init_subclass__` 之外，所有 `@filter.*` 装饰器把方法登记进全局 `star_handlers_registry`（`star_handler.py` L53-72，`handler_full_name = f"{module}_{func.__name__}"`）。实例化后 loader 用 `functools.partial` 把实例绑上去：

```python
# star_manager.py L1260-1276
related_handlers = star_handlers_registry.get_handlers_by_module_name(metadata.module_path)
for handler in related_handlers:
    raw_handler = handler.handler.func if isinstance(handler.handler, functools.partial) else handler.handler
    handler.handler = raw_handler
    if not plugin_disabled and metadata.star_cls is not None:
        handler.handler = functools.partial(raw_handler, metadata.star_cls)
```

> 兼容层要点：装饰器在**类定义期**只登记 metadata（含过滤器列表），函数对象尚未绑定 self；**必须在实例化后按模块路径回填 `partial(func, instance)`**。这是「注册两次/状态堆叠」类 bug 的高发点，官方用「先还原 raw_handler 再重新绑定」来保证幂等。

**旧版插件类兜底**（`_get_classes`，L279-288）：若模块未被 `Star` 子类注册，则找类名 `endswith("plugin")`（忽略大小写）或等于 `main` 的类。异常文案：`请确认插件主类继承 astrbot.api.star.Star，或类名以 Plugin 结尾 / 命名为 Main`。

### 1.4 插件如何被发现

四条路径：

1. **本地目录扫描**：`_get_plugin_modules()` 扫描 `data/plugins`（`self.plugin_store_path`）+ `astrbot/builtin_stars`（`reserved`）。仅识别「目录含 `main.py` 或 `<dir>.py`」的目录（见 §1.1）。
2. **WebUI 上传/本地文件安装**：`install_plugin_from_file` → `_install_plugin_from_directory`（`star_manager.py` L1998/L2034）。
3. **Git 仓库 / ZIP 安装**：`_PluginUpdater`（`astrbot/core/star/updater.py`）走 `git clone`（shallow，`PLUGIN_GIT_CLONE_TIMEOUT_SECONDS = 180`）或仓库 zip；若环境无 `git` 会报 `GitUnavailableError("安装此仓库需要 Git，但当前运行环境中未找到 git 命令。")`。
4. **官方插件市场**：`plugin_service.py` 拉取 `https://api.soulter.top/astrbot/plugins`（另有 `https://api.soulter.top/astrbot/plugins-md5`，本地缓存 `data/plugins.json`），条目含 `download_url` 指向 S3 zip。

**没有 pip/entry-points 插件机制** —— 插件永远是从 `data/plugins/` 目录导入的 Python 包，依赖才用 pip。

---

## 二、最小插件完整可运行代码

### 2.1 官方模板（真实文件，可直接跑）

`main.py` — https://raw.githubusercontent.com/Soulter/helloworld/master/main.py

```python
from astrbot.api.event import filter, AstrMessageEvent, MessageEventResult
from astrbot.api.star import Context, Star, register
from astrbot.api import logger

@register("helloworld", "YourName", "一个简单的 Hello World 插件", "1.0.0")
class MyPlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)

    async def initialize(self):
        """可选择实现异步的插件初始化方法，当实例化该插件类之后会自动调用该方法。"""

    # 注册指令的装饰器。指令名为 helloworld。注册成功后，发送 `/helloworld` 就会触发这个指令
    @filter.command("helloworld")
    async def helloworld(self, event: AstrMessageEvent):
        """这是一个 hello world 指令"""
        user_name = event.get_sender_name()
        message_str = event.message_str  # 用户发的纯文本消息字符串
        message_chain = event.get_messages()  # 用户所发的消息的消息链
        logger.info(message_chain)
        yield event.plain_result(f"Hello, {user_name}, 你发了 {message_str}!")

    async def terminate(self):
        """可选择实现异步的插件销毁方法，当插件被卸载/停用时会调用。"""
```

`metadata.yaml` — https://raw.githubusercontent.com/Soulter/helloworld/master/metadata.yaml

```yaml
name: helloworld # 插件唯一识别名，以 astrbot_plugin_ 前缀开头
display_name: helloworld # 用于展示的名字（需要版本 >= v4.5.0）
desc: AstrBot 插件示例。 # 插件简短描述
version: v1.3.0 # 插件版本号。格式：v1.1.1 或者 v1.1
author: Soulter # 作者
repo: https://github.com/Soulter/helloworld # 插件的仓库地址
```

### 2.2 推荐写法（去废弃装饰器 + 配置 + LLM 工具，可直接跑）

目录：`data/plugins/astrbot_plugin_demo/{main.py, metadata.yaml, _conf_schema.json, requirements.txt}`

`metadata.yaml`：

```yaml
name: astrbot_plugin_demo
display_name: Demo 插件
desc: 演示最小可运行插件。
short_desc: 一句话介绍。
version: v1.0.0
author: YourName
repo: https://github.com/you/astrbot_plugin_demo
astrbot_version: ">=4.16,<5"
support_platforms:
  - aiocqhttp
  - telegram
```

`_conf_schema.json`：

```json
{
  "greeting": {
    "description": "问候语",
    "type": "string",
    "default": "你好"
  },
  "api_key": {
    "description": "API Key",
    "type": "string",
    "default": "",
    "secret": true
  }
}
```

`requirements.txt`：

```
aiohttp>=3.9,<4
```

`main.py`：

```python
import astrbot.api.message_components as Comp
from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.star import Context, Star, StarTools


class DemoPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config          # AstrBotConfig 继承 dict
        self.data_dir = StarTools.get_data_dir()   # data/plugin_data/<name>

    async def initialize(self):
        logger.info("demo plugin initialized")

    @filter.command("demo", alias={"演示"})
    async def demo(self, event: AstrMessageEvent, who: str = "world"):
        """演示指令。"""
        yield event.plain_result(f"{self.config['greeting']}, {who}!")

    @filter.command_group("demo2")
    def demo2(self):
        pass

    @demo2.command("pic")
    async def demo2_pic(self, event: AstrMessageEvent):
        yield event.chain_result([
            Comp.At(qq=event.get_sender_id()),
            Comp.Plain("看这张图："),
            Comp.Image.fromURL("https://example.com/a.jpg"),
        ])

    @filter.llm_tool(name="get_weather")
    async def get_weather(self, event: AstrMessageEvent, location: str):
        """获取天气信息。

        Args:
            location(string): 地点
        """
        yield event.plain_result(f"{location} 晴")

    async def terminate(self):
        logger.info("demo plugin terminated")
```

调用方（AstrBot Core）侧事件流关键点：
- 指令触发条件包含 `event.is_at_or_wake_command`（见 §4.1 `CommandFilter.filter`）。
- Handler 可以是 `async generator`（`yield` 结果）或普通协程；返回/产出 `MessageEventResult`、`str` 或 `None`。

---

## 三、插件真实 import 清单（穷举）

### 3.1 `astrbot.api.*` —— 官方对外稳定面

`astrbot/api/` 只有 8 个文件：`__init__.py`、`all.py`、`message_components.py`、`web.py`、`event/`、`platform/`、`provider/`、`star/`、`util/`。

**`from astrbot.api import ...`**（`astrbot/api/__init__.py` 的 `__all__`）：

```python
from astrbot.api import (
    AstrBotConfig,             # 插件配置对象（dict 子类）
    BaseFunctionToolExecutor,
    FunctionTool,              # 新版 Function-calling 工具基类
    ToolSet,
    agent,                     # = register_agent
    html_renderer,             # 文转图/HTML 渲染
    llm_tool,                  # = register_llm_tool
    logger,                    # 插件级 logger 代理（按调用方模块路由）
    sp,                        # 简易持久化
)
```

`logger` 是 `_PluginContextLogger`，通过 `sys._getframe(1)` 找到调用方模块名，再在 `star_map` 里匹配插件 → 路由到 `astrbot.plugin.<plugin_name>` logger，非插件调用者回退全局（源码见 `astrbot/api/__init__.py`）。

**`from astrbot.api.event import ...`**：

```python
from astrbot.api.event import (
    AstrMessageEvent,
    CommandResult,        # = MessageEventResult 的别名
    EventResultType,      # CONTINUE / STOP
    MessageChain,
    MessageEventResult,
    ResultContentType,
    filter,               # 子模块，必须显式导入
)
```

**`from astrbot.api.event.filter import ...`**（= `astrbot/core/star/register/*` 的别名层）：

```python
from astrbot.api.event.filter import (
    command, command_group, event_message_type, regex, permission_type,
    platform_adapter_type, custom_filter, llm_tool,
    on_astrbot_loaded, on_platform_loaded, on_waiting_llm_request,
    on_llm_request, on_llm_response, on_agent_begin, on_agent_done,
    on_using_llm_tool, on_llm_tool_respond, on_decorating_result,
    after_message_sent, on_plugin_loaded, on_plugin_unloaded, on_plugin_error,
    EventMessageType, EventMessageTypeFilter,
    PlatformAdapterType, PlatformAdapterTypeFilter,
    PermissionType, PermissionTypeFilter,
    CustomFilter,
)
```

**`from astrbot.api.star import ...`**：

```python
from astrbot.api.star import Context, Star, StarTools, register
# 注意：该模块还 `from astrbot.core.star.config import *` 重新导出了
# load_config / put_config / update_config（已过时的配置接口）
```

**`from astrbot.api.message_components import ...`**（= `astrbot/core/message/components.py` 全量 re-export）：

```python
import astrbot.api.message_components as Comp
from astrbot.api.message_components import (
    Plain, Face, Record, Video, At, AtAll, Image, Reply, Poke, Forward,
    Node, Nodes, Json, File, Music, Share, Contact, Location,
    RPS, Dice, Shake, Unknown,
    ComponentType, ComponentTypes, BaseMessageComponent,
)
```

**`from astrbot.api.platform import ...`**：

```python
from astrbot.api.platform import (
    AstrBotMessage, AstrMessageEvent, Group, MessageMember,
    MessageType, Platform, PlatformMetadata, register_platform_adapter,
)
# 同样 `from astrbot.core.message.components import *`
```

**`from astrbot.api.provider import ...`**：

```python
from astrbot.api.provider import (
    LLMResponse, Personality, Provider, ProviderMetaData,
    ProviderRequest, ProviderType, STTProvider,
)
```

**`from astrbot.api.util import ...`**（会话控制）：

```python
from astrbot.api.util import SessionController, SessionWaiter, session_waiter
# 文档里的等价路径（同样有效）：
from astrbot.core.utils.session_waiter import session_waiter, SessionController, SessionFilter
```

**`from astrbot.api.web import ...`**（Plugin Pages 后端）：`PluginMultiDict`、`jsonable_encoder`、`FileResponse`、`JSONResponse`、`StreamingResponse` 等（依赖 `fastapi`/`starlette`）。

**`astrbot.api.all`**：一次性导入以上全部（历史便利模块，源码见 `astrbot/api/all.py`）。

### 3.2 `from astrbot.core...` —— 内部路径（真实插件大量使用）

从 3 个真实插件（`astrbot_plugin_apis` / `astrbot_plugin_livingmemory` / `astrbot_plugin_qq_group_daily_analysis`）抓到的全部 AstrBot 相关 import：

```python
# astrbot_plugin_apis（https://raw.githubusercontent.com/Zhalslar/astrbot_plugin_apis/main/main.py）
import astrbot.core.message.components as Comp
from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.core.config.astrbot_config import AstrBotConfig
from astrbot.core.star.filter.event_message_type import EventMessageType

# astrbot_plugin_livingmemory（https://raw.githubusercontent.com/lxfight/astrbot_plugin_livingmemory/master/main.py）
from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageEventResult, filter
from astrbot.api.event.filter import PermissionType, permission_type
from astrbot.api.provider import LLMResponse, ProviderRequest
from astrbot.api.star import Context, Star, StarTools, register

# astrbot_plugin_qq_group_daily_analysis
from astrbot.api import AstrBotConfig
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.event.filter import PermissionType
from astrbot.api.star import Context, Star, StarTools
from astrbot.core.message.components import File
```

文档中出现的 `astrbot.core.*` 路径：

```python
from astrbot.core.agent.message import TextPart                      # req.extra_user_content_parts
from astrbot.core.agent.run_context import ContextWrapper
from astrbot.core.agent.tool import FunctionTool, ToolExecResult, ToolSet
from astrbot.core.astr_agent_context import AstrAgentContext
from astrbot.core.platform.sources.aiocqhttp.aiocqhttp_platform_adapter import AiocqhttpAdapter
from astrbot.core.platform.sources.aiocqhttp.aiocqhttp_message_event import AiocqhttpMessageEvent
from mcp.types import CallToolResult
```

> 兼容层结论：`astrbot.api.*` 是**契约面**；`astrbot.core.*` 被真实插件当作「半公开面」直接使用（config / message.components / star.filter / platform.sources.*），因此**不能只实现 `astrbot.api`**，至少还要提供 `astrbot.core.message.components`、`astrbot.core.config.astrbot_config.AstrBotConfig`、`astrbot.core.star.filter.*`、`astrbot.core.utils.session_waiter`、`astrbot.core.platform.sources.aiocqhttp.*`（后者常与 `isinstance(event, AiocqhttpMessageEvent)` + `event.bot.api.call_action(...)` 连用）。

**统计到的装饰器真实使用频次**（4 个真实插件源码）：

| 装饰器 | 次数 |
|---|---|
| `@filter.permission_type(PermissionType.ADMIN)` | 9 |
| `@filter.command(...)`（含 `alias=`/`aliases=`） | 8 |
| `@filter.llm_tool()` | 2 |
| `@filter.event_message_type(...)` | 3 |
| `@filter.platform_adapter_type(...)` | 2 |
| `@filter.command_group(...)` | 1 |
| `@filter.custom_filter(PassiveGroupCaptureFilter, False)` | 1 |
| `@filter.on_llm_request()` / `on_llm_response()` / `after_message_sent()` / `on_platform_loaded()` | 各 1 |
| `@register(...)` | 1（旧模板） |

**真实世界兼容坑（已实测）**：`astrbot_plugin_qq_group_daily_analysis` 写了 `@filter.command("查看api", aliases=["查看api列表", "api列表"])` —— 复数 `aliases` 是**文档外的错拼**。`register_command(command_name, sub_command=None, alias=None, **kwargs)` 会把 `aliases` 吃进 `kwargs` → 变成 `extras_configs`，**别名静默失效**。兼容层应与原版保持一致（不报错、别名不生效），或至少在日志中警告。

---

## 四、过滤器（filter）全集与语义

### 4.1 注册器签名（`astrbot/core/star/register/star_handler.py`）

| 装饰器 | 别名/事件类型 | 签名 | 行为 |
|---|---|---|---|
| `register_command` | `filter.command` → `AdapterMessageEvent` | `(command_name=None, sub_command=None, alias: set\|None=None, **kwargs)` | 注册根指令或子指令；`alias` 是 **set**；父指令名会拼成 `"parent cmd"` |
| `register_command_group` | `filter.command_group` → `AdapterMessageEvent` | `(command_group_name=None, sub_command=None, alias=None, **kwargs)` | 返回 `RegisteringCommandable`，其 `.command` / `.group` / `.custom_filter` 用于级联注册；可无限嵌套 |
| `register_event_message_type` | `filter.event_message_type` | `(event_message_type: EventMessageType, **kwargs)` | 追加 `EventMessageTypeFilter` |
| `register_platform_adapter_type` | `filter.platform_adapter_type` | `(platform_adapter_type: PlatformAdapterType, **kwargs)` | 追加 `PlatformAdapterTypeFilter` |
| `register_regex` | `filter.regex` | `(regex: str\|re.Pattern, **kwargs)` | `re.search(event.get_message_str().strip())`；**不受 wake_prefix 约束** |
| `register_permission_type` | `filter.permission_type` | `(permission_type: PermissionType, raise_error: bool = True, **kwargs)` | 权限不足时默认抛错并停止事件传播 |
| `register_custom_filter` | `filter.custom_filter` | `(custom_type_filter, *args, **kwargs)` | `args[0]` 为 `raise_error`；可作用于根指令/子指令/指令组 |
| `register_llm_tool` | `filter.llm_tool` / `astrbot.api.llm_tool` | `(name: str\|None=None, **kwargs)` | 解析 docstring 生成 schema；`EventType.OnCallingFuncToolEvent` |
| `register_agent` | `astrbot.api.agent` | `(name, instruction, tools=None, run_hooks=None)` | 注册 Agent，返回 `RegisteringAgent`（其 `.llm_tool` 注册到该 Agent） |
| `register_on_astrbot_loaded` | `filter.on_astrbot_loaded` | `(**kwargs)` | `OnAstrBotLoadedEvent`；handler 只接 `self` |
| `register_on_platform_loaded` | `filter.on_platform_loaded` | `(**kwargs)` | `OnPlatformLoadedEvent` |
| `register_on_waiting_llm_request` | `filter.on_waiting_llm_request` | `(**kwargs)` | `OnWaitingLLMRequestEvent`；接 `(self, event)`；**不能 yield，用 `await event.send()`** |
| `register_on_llm_request` | `filter.on_llm_request` | `(**kwargs)` | `OnLLMRequestEvent`；接 `(self, event, req: ProviderRequest)` |
| `register_on_llm_response` | `filter.on_llm_response` | `(**kwargs)` | `OnLLMResponseEvent`；接 `(self, event, response: LLMResponse)` |
| `register_on_agent_begin` | `filter.on_agent_begin` | `(**kwargs)` | 接 `(self, event, run_context)` |
| `register_on_agent_done` | `filter.on_agent_done` | `(**kwargs)` | 接 `(self, event, run_context, response)` |
| `register_on_using_llm_tool` | `filter.on_using_llm_tool` | `(**kwargs)` | 接 `(self, event, tool, tool_args)` |
| `register_on_llm_tool_respond` | `filter.on_llm_tool_respond` | `(**kwargs)` | 接 `(self, event, tool, tool_args, tool_result)` |
| `register_on_decorating_result` | `filter.on_decorating_result` | `(**kwargs)` | 发送消息前 |
| `register_after_message_sent` | `filter.after_message_sent` | `(**kwargs)` | 消息发送后 |
| `register_on_plugin_loaded` | `filter.on_plugin_loaded` | `(**kwargs)` | 接 `(self, metadata)` |
| `register_on_plugin_unloaded` | `filter.on_plugin_unloaded` | `(**kwargs)` | 接 `(self, metadata)` |
| `register_on_plugin_error` | `filter.on_plugin_error` | `(**kwargs)` | 接 `(self, event, plugin_name, handler_name, error, traceback_text)`；调 `event.stop_event()` 可屏蔽默认报错回显 |

**优先级**：所有注册器都接受 `**kwargs`，其中 `priority` 被存进 `StarHandlerMetadata.extras_configs`，并定义排序（`star_handler.py` L277-282）：

```python
def __lt__(self, other: StarHandlerMetadata):
    return self.extras_configs.get("priority", 0) < other.extras_configs.get("priority", 0)
```

即 `@filter.command("x", priority=10)` 有效；**默认 0，越大越靠后**（按 `<` 升序取出）。`desc=` 也为保留 kwarg，会覆盖 docstring 描述。

**过滤逻辑**：多个装饰器是 **AND**（每个 filter 追加到 `event_filters`，全部通过才执行）。文档明确：钩子类（`on_*`/`after_message_sent`）**不能**与 `command`/`command_group`/`event_message_type`/`platform_adapter_type`/`permission_type` 混用。

### 4.2 `EventMessageType` 枚举（真实源码，注意与文档不一致）

`astrbot/core/star/filter/event_message_type.py`：

```python
class EventMessageType(enum.Flag):
    GROUP_MESSAGE = enum.auto()
    PRIVATE_MESSAGE = enum.auto()
    OTHER_MESSAGE = enum.auto()          # <-- 文档未提及
    ALL = GROUP_MESSAGE | PRIVATE_MESSAGE | OTHER_MESSAGE

MESSAGE_TYPE_2_EVENT_MESSAGE_TYPE = {
    MessageType.GROUP_MESSAGE: EventMessageType.GROUP_MESSAGE,
    MessageType.FRIEND_MESSAGE: EventMessageType.PRIVATE_MESSAGE,
    MessageType.OTHER_MESSAGE: EventMessageType.OTHER_MESSAGE,
}

class EventMessageTypeFilter(HandlerFilter):
    def filter(self, event, cfg) -> bool:
        message_type = event.get_message_type()
        if message_type in MESSAGE_TYPE_2_EVENT_MESSAGE_TYPE:
            return bool(MESSAGE_TYPE_2_EVENT_MESSAGE_TYPE[message_type] & self.event_message_type)
        return False
```

底层 `MessageType`（`astrbot/core/platform/message_type.py`）是 **`Enum`（字符串值）**，不是 Flag：

```python
class MessageType(Enum):
    GROUP_MESSAGE = "GroupMessage"    # 群组形式的消息
    FRIEND_MESSAGE = "FriendMessage"  # 私聊、好友等单聊消息
    OTHER_MESSAGE = "OtherMessage"    # 其他类型的消息，如系统消息等
```

> 兼容层注意：文档说「当前的事件类型有 `PRIVATE_MESSAGE` 和 `GROUP_MESSAGE`」，实际还有 `OTHER_MESSAGE`，且 `EventMessageType` 是 **`enum.Flag`（可 `|`）**；`ALL` 为三者按位或。

### 4.3 `PlatformAdapterType` 枚举 + `ADAPTER_NAME_2_TYPE`（真实源码）

`astrbot/core/star/filter/platform_adapter_type.py`：

```python
class PlatformAdapterType(enum.Flag):
    AIOCQHTTP = enum.auto()
    QQOFFICIAL = enum.auto()
    QQOFFICIAL_WEBHOOK = enum.auto()
    TELEGRAM = enum.auto()
    WECOM = enum.auto()
    WECOM_AI_BOT = enum.auto()
    LARK = enum.auto()
    DINGTALK = enum.auto()
    DISCORD = enum.auto()
    SLACK = enum.auto()
    KOOK = enum.auto()
    VOCECHAT = enum.auto()
    WEIXIN_OFFICIAL_ACCOUNT = enum.auto()
    SATORI = enum.auto()
    MISSKEY = enum.auto()
    LINE = enum.auto()
    MATRIX = enum.auto()
    WEIXIN_OC = enum.auto()
    MATTERMOST = enum.auto()
    WEBCHAT = enum.auto()
    ALL = enum.auto()          # 注意：ALL 是独立 auto()，不是按位或组合

ADAPTER_NAME_2_TYPE = {
    "aiocqhttp": PlatformAdapterType.AIOCQHTTP,
    "qq_official": PlatformAdapterType.QQOFFICIAL,
    "qq_official_webhook": PlatformAdapterType.QQOFFICIAL_WEBHOOK,
    "telegram": PlatformAdapterType.TELEGRAM,
    "wecom": PlatformAdapterType.WECOM,
    "wecom_ai_bot": PlatformAdapterType.WECOM_AI_BOT,
    "lark": PlatformAdapterType.LARK,
    "dingtalk": PlatformAdapterType.DINGTALK,
    "discord": PlatformAdapterType.DISCORD,
    "slack": PlatformAdapterType.SLACK,
    "kook": PlatformAdapterType.KOOK,
    "vocechat": PlatformAdapterType.VOCECHAT,
    "weixin_official_account": PlatformAdapterType.WEIXIN_OFFICIAL_ACCOUNT,
    "satori": PlatformAdapterType.SATORI,
    "misskey": PlatformAdapterType.MISSKEY,
    "line": PlatformAdapterType.LINE,
    "matrix": PlatformAdapterType.MATRIX,
    "weixin_oc": PlatformAdapterType.WEIXIN_OC,
    "mattermost": PlatformAdapterType.MATTERMOST,
    "webchat": PlatformAdapterType.WEBCHAT,
}
```

`PlatformAdapterTypeFilter.__init__` 同时接受 `PlatformAdapterType` 或 **str**（走 `ADAPTER_NAME_2_TYPE.get(...)`，未知名字得到 `None` → 永远 False）。匹配逻辑用 `event.get_platform_name()`（平台**类型名**，如 `aiocqhttp`），而非 platform_id。`ALL` 分支：

```python
if self.platform_type is not None and self.platform_type & PlatformAdapterType.ALL:
    return True
```

### 4.4 `PermissionType`（真实源码）

```python
class PermissionType(enum.Flag):
    """Command permissions; MEMBER also allows administrators."""
    ADMIN = enum.auto()
    MEMBER = enum.auto()
    GROUP_ADMIN = enum.auto()
    SHARED_GROUP_ADMIN = enum.auto()

COMMAND_PERMISSION_TYPES = {
    "admin": PermissionType.ADMIN,
    "member": PermissionType.MEMBER,
    "group_admin": PermissionType.GROUP_ADMIN,
    "shared_group_admin": PermissionType.SHARED_GROUP_ADMIN,
}
```

`PermissionTypeFilter.filter`（`filter/permission.py` L33-53）精确语义：

```python
def filter(self, event: AstrMessageEvent, cfg: AstrBotConfig) -> bool:
    if self.permission_type == PermissionType.ADMIN or (
        self.permission_type == PermissionType.GROUP_ADMIN and event.get_group_id()
    ):
        return event.is_admin()
    if (
        self.permission_type == PermissionType.SHARED_GROUP_ADMIN
        and event.get_group_id()
    ):
        # The pipeline marks actual isolation, including platform support.
        return event.is_admin() or bool(event.get_extra("_session_isolated", False))
    return True
```

- `ADMIN`：任意场景都要求 `event.is_admin()`（即 `event.role == "admin"`）。
- `GROUP_ADMIN`：**仅在群聊**要求 `is_admin()`；私聊直接放行。
- `SHARED_GROUP_ADMIN`：群聊下 `is_admin()` 或 `event.get_extra("_session_isolated")`。
- `MEMBER`：**永远 True**（注释「MEMBER also allows administrators」）。

> 这正是测试/兼容层最容易做错的地方：`PermissionType.ADMIN` 只检查 `event.role`，而 `event.role` 是 **pipeline 在唤醒阶段写进事件对象的字符串**（`astr_message_event.py` L51-52：`self.role = "member"`，`"""用户是否是管理员。如果是管理员，这里是 admin"""`）。兼容层必须在派发 handler 之前设置好 `event.role`。

### 4.5 `CommandFilter` 精确语义（`filter/command.py`）

```python
def filter(self, event: AstrMessageEvent, cfg: AstrBotConfig) -> bool:
    if not event.is_at_or_wake_command:            # ① 必须已唤醒 / @机器人 / 私聊
        return False
    if not self.custom_filter_ok(event, cfg):      # ② custom_filter 全通过
        return False
    message_str = re.sub(r"\s+", " ", event.get_message_str().strip())
    ok = False
    for full_cmd in self.get_complete_command_names():
        if message_str.startswith(f"{full_cmd} ") or message_str == full_cmd:
            ok = True
            message_str = message_str[len(full_cmd):].strip()
    if not ok:
        return False
    ls = [p for p in message_str.split(" ") if p]
    params = self.validate_and_convert_params(ls, self.handler_params)
    event.set_extra("parsed_params", params)       # ③ 解析结果放 extra
    return True
```

- 完整指令名 = `{parent} {cmd}` 组合 + alias（`get_complete_command_names`），因此子指令必须写全 `/math add 1 2`。
- 参数按**函数签名**（跳过前两个 `self`/`event`）解析并强制转换；缺省值 → 默认值；缺参 → `ValueError("必要参数缺失。该指令完整参数: ...")`。
- 特殊类型 `GreedyStr`（`class GreedyStr(str)`）必须是最后一个参数，吃掉剩余全部文本。
- 支持 `Optional[T]` / `T|None` 解包（`unwrap_optional`）；bool 接受 `true/yes/1`、`false/no/0`。
- **指令名不能带空格**（会解析到第二个参数）。
- 解析后的参数既通过位置参数注入 handler，也存进 `event.get_extra("parsed_params")`。

`CommandFilter` 还有 `equals(message_str)`、`print_types()`、`custom_filter_ok()`、`add_custom_filter()`。

**`RegexFilter`**（`filter/regex.py`）：`re.compile(regex)`，`bool(self.regex.search(event.get_message_str().strip()))`，源码注释明确「正则表达式过滤器不会受到 wake_prefix 的制约」。

---

## 五、`AstrMessageEvent` API

`astrbot/core/platform/astr_message_event.py`（`class AstrMessageEvent(abc.ABC)`，535 行）。**基类不是 dataclass**，构造签名：

```python
def __init__(
    self,
    message_str: str,
    message_obj: AstrBotMessage,
    platform_meta: PlatformMetadata,
    session_id: str,
) -> None:
```

### 5.1 属性 / 实例字段

| 成员 | 类型 | 说明（源码注释） |
|---|---|---|
| `message_str` | str | 纯文本的消息 |
| `message_obj` | `AstrBotMessage` | 消息对象，带完整消息结构 |
| `platform_meta` | `PlatformMetadata` | 平台信息，`name` 是平台类型名（aiocqhttp…）；`platform` 是它的旧别名 |
| `role` | str | 是否管理员；管理员时为 `"admin"`；默认 `"member"` |
| `is_wake` | bool | 是否唤醒（通过 WakingStage） |
| `is_at_or_wake_command` | bool | 是否是 At 机器人 / 带唤醒词 / 私聊（插件注册的监听器只让 `is_wake` 为 True，不会置这个） |
| `session` | `MessageSession` | 会话标识对象 |
| `created_at` | float | 事件创建时间（Unix timestamp） |
| `trace` / `span` | `TraceSpan` | 事件级 trace |
| `call_llm` | bool | 是否允许默认 LLM 请求（`should_call_llm()` 写它） |
| `plugins_name` | `list[str]\|None` | 该事件启用的插件名列表；None=全部启用，[]=全不启用 |
| `unified_msg_origin` | `str`（property） | `platform_id:message_type:session_id`，**有 setter**（会重建 `session`） |
| `session_id` | str（property） | `self.session.session_id`，**有 setter** |

`unified_msg_origin` 的实现：

```python
@property
def unified_msg_origin(self) -> str:
    """统一的消息来源字符串。格式为 platform_name:message_type:session_id"""
    return str(self.session)

@unified_msg_origin.setter
def unified_msg_origin(self, value: str) -> None:
    self.new_session = MessageSession.from_str(value)
    self.session = self.new_session
```

`MessageSession.__str__` = `f"{self.platform_id}:{self.message_type.value}:{self.session_id}"`，`MessageType.value` 为 `"GroupMessage"` / `"FriendMessage"` / `"OtherMessage"`。**因此真实 umo 形如 `aiocqhttp:FriendMessage:1234567`。**

### 5.2 方法全集（签名 + 语义）

```python
# —— 平台 / 身份 ——
def get_platform_name(self) -> str        # 平台类型名，如 "aiocqhttp"（NOTE: 可能多个同类型适配器）
def get_platform_id(self) -> str          # 平台实例唯一 ID（>= v4.0.0 推荐）
def get_self_id(self) -> str              # 机器人自身 id（读 message_obj.self_id）
def get_sender_id(self) -> str            # 发送者 id（读 message_obj.sender.user_id）
def get_sender_name(self) -> str          # 发送者昵称（可能空串）
def get_group_id(self) -> str             # 群号；非群聊返回 ""
def get_session_id(self) -> str           # = self.session_id

# —— 消息 ——
def get_message_str(self) -> str
def get_messages(self) -> list[BaseMessageComponent]   # 消息链
def get_message_type(self) -> MessageType
def get_message_outline(self) -> str      # 概览，非文本段转占位符（[图片] [表情:id] [At:qq] [转发消息] [引用消息]）
def is_private_chat(self) -> bool         # get_message_type() == MessageType.FRIEND_MESSAGE
def is_wake_up(self) -> bool              # = self.is_wake
def is_admin(self) -> bool                # = (self.role == "admin")

# —— extra（插件间共享的临时 KV）——
def set_extra(self, key, value) -> None
def get_extra(self, key: str | None = None, default=None)   # key=None → 返回整个 dict
def clear_extra(self) -> None             # 会打 info 日志

# —— 事件传播控制 ——
def set_result(self, result: MessageEventResult | str) -> None
def stop_event(self) -> None              # _force_stopped = True；不依赖 _result，不会被 clear_result 重置
def continue_event(self) -> None
def is_stopped(self) -> bool
def should_call_llm(self, call_llm: bool) -> None   # 只阻止 AstrBot 默认 LLM 链路，不阻止插件自己的
def get_result(self) -> MessageEventResult | None
def clear_result(self) -> None

# —— 构造结果（Handler 里 yield 的东西）——
def make_result(self) -> MessageEventResult
def plain_result(self, text: str) -> MessageEventResult
def image_result(self, url_or_path: str) -> MessageEventResult   # 以 http 开头走 url_image，否则 file_image
def chain_result(self, chain: list[BaseMessageComponent]) -> MessageEventResult

# —— 直接发送（不能 yield 的场景，如钩子/会话控制器内部）——
async def send(self, message: MessageChain) -> None
async def send_streaming(self, generator: AsyncGenerator[MessageChain, None], use_fallback: bool = False) -> None
async def react(self, emoji: str) -> None            # 默认实现 = 发一条 Plain(emoji)
async def send_typing(self) -> None
async def stop_typing(self) -> None
async def process_buffer(self, buffer: str, pattern: re.Pattern) -> str   # 非流式平台 fallback，内部 sleep(1.5) 限速

# —— LLM ——
def request_llm(self, prompt, func_tool_manager=None, tool_set=None, session_id="",
                image_urls=None, audio_urls=None, contexts=None,
                system_prompt="", conversation=None) -> ProviderRequest

# —— 群信息 / 临时文件 ——
async def get_group(self, group_id: str | None = None, **kwargs) -> Group | None
def track_temporary_local_file(self, path: str) -> None
def untrack_temporary_local_file(self, path: str) -> None
def cleanup_temporary_local_files(self) -> None

# —— 已废弃 ——
async def _pre_send(self) / _post_send(self)   # deprecated 3.5.18
```

`stop_event` 源码（注意「独立停止标志」这一语义，直接影响兼容层）：

```python
def stop_event(self) -> None:
    """终止事件传播。"""
    self._force_stopped = True
    if self._result is None:
        self.set_result(MessageEventResult().stop_event())
    else:
        self._result.stop_event()

def is_stopped(self) -> bool:
    if self._force_stopped:
        return True
    if self._result is None:
        return False  # 默认是继续传播
    return self._result.is_stopped()
```

**平台子类**：`AiocqhttpMessageEvent` 额外提供 `event.bot`（aiocqhttp client），可 `await event.bot.api.call_action("delete_msg", message_id=...)`（见 https://docs.astrbot.app/dev/star/guides/other.html ）。

### 5.3 `AstrBotMessage`（`event.message_obj`）

`astrbot/core/platform/astrbot_message.py`：

```python
@dataclass
class MessageMember:
    user_id: str
    nickname: str | None = None

@dataclass
class Group:
    group_id: str
    group_name: str | None = None
    group_avatar: str | None = None
    group_owner: str | None = None
    group_admins: list[str] | None = None
    members: list[MessageMember] | None = None
    member_count: int | None = None

class AstrBotMessage:
    """AstrBot 的消息对象"""
    type: MessageType        # 消息类型
    self_id: str             # 机器人的识别id
    session_id: str          # 会话id。取决于 unique_session 的设置。
    message_id: str          # 消息id
    group: Group | None      # 群组
    sender: MessageMember    # 发送者
    message: list[BaseMessageComponent]  # 消息链
    message_str: str         # 最直观的纯文本消息字符串
    raw_message: object      # 平台适配器的原始消息对象
    timestamp: int           # 消息时间戳

    def __init__(self) -> None:
        self.timestamp = int(time.time())
        self.group = None

    @property
    def group_id(self) -> str:
        """向后兼容的 group_id 属性；私聊为空"""
        if self.group:
            return self.group.group_id
        return ""
    @group_id.setter
    def group_id(self, value: str | None) -> None: ...
```

> **文档已过时**：旧指南把 `group_id` 写成普通字段 `group_id: str = ""`；**真实源码里 `group_id` 是 property，由 `self.group.group_id` 派生**，且新增 `group: Group | None`、`sender` 为 `MessageMember` dataclass。兼容层应以源码为准（`set group_id` 时若无 `Group` 会惰性创建 `Group(group_id=value)`）。

---

## 六、消息组件模型

`astrbot/core/message/components.py`（944 行）。基类是 **pydantic v1 BaseModel**（Python >= 3.14 时用 pydantic v2）：

```python
if sys.version_info >= (3, 14):
    from pydantic import BaseModel
else:
    from pydantic.v1 import BaseModel

class ComponentType(str, Enum):
    Plain = "Plain"; Image = "Image"; Record = "Record"; Video = "Video"; File = "File"
    Face = "Face"; At = "At"; Node = "Node"; Nodes = "Nodes"; Poke = "Poke"
    Reply = "Reply"; Forward = "Forward"; RPS = "RPS"; Dice = "Dice"; Shake = "Shake"
    Share = "Share"; Contact = "Contact"; Location = "Location"; Music = "Music"
    Json = "Json"; Unknown = "Unknown"

class BaseMessageComponent(BaseModel):
    type: ComponentType
    def __init__(self, **kwargs) -> None: super().__init__(**kwargs)
    def __repr_args__(self):   # 截断 base64 / 超长字段，避免日志被正文污染
    def toDict(self):          # {"type": self.type.lower(), "data": {...}}
    async def to_dict(self) -> dict:   # 默认回退 toDict()
```

### 6.1 组件构造参数全集

| 类 | 字段（构造） | 静态构造器 / 方法 | 备注 |
|---|---|---|---|
| `Plain` | `text: str`（`convert: bool = True` 被吞掉） | — | `toDict()` → `{"type":"text","data":{"text":...}}` |
| `Face` | `id: int` | — | QQ 表情 |
| `Image` | `file: str\|None=""`, `_type: str\|None=""`, `url: str\|None=""`, `path: str\|None=""` | `fromURL(url)`, `fromFileSystem(path)`, `fromBase64(b64)`, `fromBytes(bytes)`, `fromIO(IO)`, `await convert_to_file_path()`, `await convert_to_base64()`, `await register_to_file_service()` | `fromFileSystem` 存 `file=<file:// URI>` + `path=<abs>` |
| `Record` | `file: str\|None`, `url: str\|None=""`, `text: str\|None=None`, `path: str\|None=None` | `fromFileSystem`, `fromURL`, `fromBase64`, `await convert_to_file_path()`, `await convert_to_base64()`, `await register_to_file_service()` | 文档：暂时只接受 wav |
| `Video` | `file: str`, `url: str\|None=""`, `cover: str\|None=""`, `path: str\|None=""` | `fromFileSystem`, `fromURL`, `fromBase64`, `await convert_to_file_path()`, `await register_to_file_service()`, `async to_dict()` | `to_dict` 会把本地文件注册成 `{callback_api_base}/api/file/{token}` |
| `At` | `qq: int\|str`, `name: str\|None=""` | — | `toDict()` → `{"type":"at","data":{"qq":str(qq)}}`；`qq="all"` 表示全体 |
| `AtAll` | 继承 `At`，`qq: str = "all"` | — | |
| `Reply` | `id: str\|int`, `chain: list\|None=[]`, `sender_id: int\|None\|str=0`, `sender_nickname: str\|None=""`, `time: int\|None=0`, `message_str: str\|None=""`；deprecated: `text`, `qq`, `seq` | — | `toDict()` **仅输出 id**：`{"type":"reply","data":{"id":str(id)}}` |
| `Poke` | `poke_type: str\|int\|None=None`, `id: int\|str\|None=0`, `_type: str\|int="126"`；deprecated `qq` | `target_id()` | 兼容旧签名 `Poke(type="poke", ...)`；`toDict()` → `{"type":"poke","data":{"type":"126","id":...}}` |
| `Forward` | `id: str` | — | |
| `Node` | `content: list[BaseMessageComponent]`，`id=0`, `name=""`, `uin="0"`, `seq=""`, `time=0` | `async to_dict()` | 合并转发节点；`to_dict` 递归把 Image/Record 转 base64 |
| `Nodes` | `nodes: list[Node]` | `async to_dict()` → `{"messages":[...]}`；`toDict()` 已 deprecated | |
| `Json` | `data: str\|dict`（str 会 `json.loads`） | — | |
| `File` | `name: str, file: str = "", url: str = ""` | `file` property（**同步取文件，异步上下文下会告警并返回 ""**）, `await get_file(allow_return_url=False)`, `await register_to_file_service()`, `async to_dict()` | 内部字段是 `file_`；setter 会按 http 前缀分流到 `url` |
| `Music` | `_type: str`, `id=0`, `url=""`, `audio=""`, `title=""`, `content=""`, `image=""` | — | |
| `Share` | `url: str, title: str, content=""`, `image=""` | — | |
| `Contact` | `_type: str`, `id: int\|None=0` | — | TODO |
| `Location` | `lat: float, lon: float, title=""`, `content=""` | — | TODO |
| `RPS` / `Dice` / `Shake` / `Unknown` | `text: str`（`Unknown`） | — | RPS/Dice/Shake 为 TODO 占位 |

**组件注册表**（用于 OneBot/CQ 段名反查类）：

```python
ComponentTypes = {
    "plain": Plain, "text": Plain, "image": Image, "record": Record,
    "video": Video, "file": File,
    "face": Face, "at": At, "rps": RPS, "dice": Dice, "shake": Shake,
    "share": Share, "contact": Contact, "location": Location, "music": Music,
    "reply": Reply, "poke": Poke, "forward": Forward,
    "node": Node, "nodes": Nodes, "json": Json, "unknown": Unknown,
}
```

### 6.2 `MessageChain` 与 `MessageEventResult`

`astrbot/core/message/message_event_result.py`：

```python
@dataclass
class MessageChain:
    chain: list[BaseMessageComponent] = field(default_factory=list)
    use_t2i_: bool | None = None          # None = 跟随用户设置
    use_markdown_: bool | None = None     # None 跟随平台，True 强制 Markdown，False 强制纯文本
    type: str | None = None               # 消息链业务场景标记

    def derive(self, chain=None) -> "MessageChain"     # 复制并继承元数据
    def message(self, message: str)                    # chain.append(Plain(message))；可链式
    def at(self, name: str, qq: str | int)
    def at_all(self)
    def error(self, message)                            # deprecated -> 用 message
    def url_image(self, url) / file_image(path) / base64_image(b64)
    def use_t2i(self, use_t2i: bool) -> "MessageChain"
    def use_markdown(self, use: bool | None = True) -> "MessageChain"
    def get_plain_text(self, with_other_comps_mark: bool = False) -> str
    def squash_plain(self)                              # 把所有 Plain 合并到第一个 Plain

class EventResultType(enum.Enum):
    CONTINUE = enum.auto()
    STOP = enum.auto()

class ResultContentType(enum.Enum):
    LLM_RESULT; AGENT_RUNNER_ERROR; GENERAL_RESULT; STREAMING_RESULT; STREAMING_FINISH

@dataclass
class MessageEventResult(MessageChain):
    result_type: EventResultType | None = EventResultType.CONTINUE
    result_content_type: ResultContentType | None = ResultContentType.GENERAL_RESULT
    async_stream: AsyncGenerator | None = None

    def stop_event(self) / continue_event(self) / is_stopped(self)
    def set_async_stream(self, stream)
    def set_result_content_type(self, typ)
    def is_llm_result(self) / is_model_result(self)

CommandResult = MessageEventResult     # 兼容旧名
```

> **注意**：`MessageEventResult` **不是** `MessageChain` 的子类关系之外的独立类型 —— 它就是 `MessageChain` 的 dataclass 子类（字段全部继承）。`event.chain_result(list)` 的实现是直接 `mer.chain = chain`（不拷贝）。

### 6.3 组件如何与平台互转

- **出站（AstrBot → 平台）**：平台适配器调用组件的 `toDict()`（同步）或 `await to_dict()`（异步，用于需要下载/上传/注册文件服务的场景）。`toDict` 输出 **OneBot v11 CQ 段风格**：`{"type": "<小写段名>", "data": {...}}`。
- **入站（平台 → AstrBot）**：适配器把平台原始消息转成 `list[BaseMessageComponent]` 填入 `AstrBotMessage.message`，同时生成 `message_str`（Plain 拼接）；原始对象留在 `message_obj.raw_message`。`ComponentTypes` 反查段名 → 组件类。
- **平台支持矩阵**（旧指南 https://docs.astrbot.app/dev/star/plugin.html ）：

| 平台 | At | Plain | Image | Record | Video | Reply | 主动消息 |
|---|---|---|---|---|---|---|---|
| QQ 个人号(aiocqhttp) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Telegram | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| QQ 官方接口 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| 飞书 | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| 企业微信 | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| 钉钉 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

补充：QQ 官方接口、钉钉发送时会强制带 `At`；钉钉图片仅支持 http 链接；`Node`/`Nodes`（合并转发）**当前仅 OneBot v11** 支持。

- **aiocqhttp 特有行为**：`plain` 类型消息在发送时使用 `strip()` 去掉空格与换行 → 需要保留空白时在前后加零宽空格 `\u200b`。

---

## 七、`Star` 基类与 `Context` API

### 7.1 `Star` 基类（`astrbot/core/star/base.py`）

```python
class Star(CommandParserMixin, PluginKVStoreMixin):
    """所有插件（Star）的父类，所有插件都应该继承于这个类"""
    author: str
    name: str
    context: Context
    logger: logging.Logger       # 每个插件独立的 logger（等级可在 WebUI 单独设置）

    def __init__(self, context: Context, config: dict | None = None) -> None: ...
    def __init_subclass__(cls, **kwargs): ...        # 自动注册（见 §1.3）

    async def text_to_image(self, text: str, return_url=True) -> str
    async def html_render(self, tmpl: str, data: dict, return_url=True, options: dict | None = None) -> str
    async def initialize(self) -> None   # 插件被激活时调用（可与 __init__ 分开做异步初始化）
    async def terminate(self) -> None    # 插件被禁用/重载时调用
    def __del__(self) -> None            # [Deprecated]
```

Mixin 提供的能力：`CommandParserMixin`（指令解析辅助）、`PluginKVStoreMixin`（插件 KV 存储，`self.get_kv_data` / `put_kv_data` 一类接口）。

### 7.2 `StarTools`（类方法，`astrbot/core/star/star_tools.py`）

```python
class StarTools:
    @classmethod
    async def send_message(cls, session: str | MessageSesion, message_chain: MessageChain) -> bool
    @classmethod
    async def create_message(cls, type: str, self_id: str, session_id: str,
                             sender: MessageMember, message: list[BaseMessageComponent],
                             message_str: str, message_id: str = "",
                             raw_message: object = None, group_id: str = "") -> AstrBotMessage
    @classmethod
    async def create_event(cls, abm: AstrBotMessage, platform: str = "aiocqhttp", is_wake: bool = True) -> None
    @classmethod
    def activate_llm_tool(cls, name: str) -> bool                     # deprecated
    @classmethod
    async def activate_llm_tool_async(cls, name: str) -> bool
    @classmethod
    def deactivate_llm_tool(cls, name: str) -> bool                   # deprecated
    @classmethod
    async def deactivate_llm_tool_async(cls, name: str) -> bool
    @classmethod
    def register_llm_tool(cls, name, func_args, desc, func_obj)       # deprecated
    @classmethod
    def unregister_llm_tool(cls, name: str) -> None
    @classmethod
    def get_data_dir(cls, plugin_name: str | None = None) -> Path     # data/plugin_data/<name>，会 ensure_dir
```

`get_data_dir()` 不传参时通过 `inspect` 栈帧 + `star_map` 反查调用方插件名。真实插件大量使用：`plugin_data_dir = StarTools.get_data_dir(PLUGIN_NAME)`。

### 7.3 `Context` 方法全集（`astrbot/core/star/context.py`，919 行）

构造依赖（决定兼容层要伪造哪些对象）：

```python
def __init__(
    self,
    event_queue: Queue,
    config: AstrBotConfig,
    db: BaseDatabase,
    provider_manager: ProviderManager,
    platform_manager: PlatformManagerProtocol,
    conversation_manager: ConversationManager,
    message_history_manager: PlatformMessageHistoryManager,
    persona_manager: PersonaManager,
    astrbot_config_mgr: AstrBotConfigManager,
    knowledge_base_manager: KnowledgeBaseManager,
    cron_manager: CronJobManager,
    subagent_orchestrator: SubAgentOrchestrator | None = None,
) -> None:
```

公开方法与签名：

| 方法 | 签名 | 用途 | 状态 |
|---|---|---|---|
| `llm_generate` | `async (*, chat_provider_id, prompt=None, image_urls=None, audio_urls=None, tools: ToolSet=None, system_prompt=None, contexts=None, **kwargs) -> LLMResponse` | 调 LLM，**不自动执行 tool calls** | >= 4.5.7 |
| `tool_loop_agent` | `async (*, event, chat_provider_id, prompt=None, image_urls=None, audio_urls=None, tools=None, system_prompt=None, contexts=None, max_steps=128, tool_call_timeout=120, **kwargs) -> LLMResponse` | Agent 循环（自动执行工具直到收敛）；kwargs 支持 `stream` / `agent_hooks` / `agent_context` | >= 4.5.7 |
| `get_current_chat_provider_id` | `async (umo: str) -> str` | 取当前会话的 chat provider id；找不到抛 `ProviderNotFoundError` | >= 4.5.7 |
| `get_using_provider` | `(umo: str\|None=None) -> Provider\|None` | 当前文本生成 provider | **deprecated** → 用 `get_using_provider_async` |
| `get_using_provider_async` | `async (umo=None) -> Provider\|None` | 同上 | 推荐 |
| `get_using_tts_provider[_async]` | `(umo=None) -> TTSProvider\|None` | TTS provider | sync 版 deprecated |
| `get_using_stt_provider[_async]` | `(umo=None) -> STTProvider\|None` | STT provider | sync 版 deprecated |
| `get_provider_by_id` | `(provider_id: str) -> Provider\|TTSProvider\|STTProvider\|EmbeddingProvider\|RerankProvider\|None` | 按 ID 取；找不到会 warning | |
| `get_all_providers` | `() -> list[Provider]` | 全部 Chat_Completion provider | |
| `get_all_tts_providers` / `get_all_stt_providers` / `get_all_embedding_providers` | `() -> list[...]` | | |
| `get_registered_star` | `(star_name: str) -> StarMetadata\|None` | 按插件名取 Metadata | |
| `get_all_stars` | `() -> list[StarMetadata]` | 全部已载入插件 Metadata | |
| `get_llm_tool_manager` | `() -> FunctionToolManager` | `provider_manager.llm_tools` | |
| `add_llm_tools` | `(*tools: FunctionTool) -> None` | 注册 Function-calling 工具（同名会替换并 warning） | >= 4.5.1 |
| `activate_llm_tool` / `deactivate_llm_tool` | `(name: str) -> bool` | sync 版 | **deprecated** |
| `activate_llm_tool_async` / `deactivate_llm_tool_async` | `async (name: str) -> bool` | 推荐 | |
| `get_config` | `(umo: str\|None=None) -> AstrBotConfig` | 无 umo 返回默认配置，有 umo 返回该会话配置 | |
| `send_message` | `async (session: str\|MessageSesion, message_chain: MessageChain) -> bool` | **主动消息**；str 会 `MessageSesion.from_str`；找不到平台返回 False 并 warning；**qq_official 不支持** | |
| `register_web_api` | `(route, view_handler, methods: list[str], desc) -> None` | 注册 Web API（同 route+methods 会替换） | |
| `get_platform_inst` | `(platform_id: str) -> Platform\|None` | 按 platform_id 取适配器 | >= 4.0.0 |
| `get_platform` | `(platform_type: PlatformAdapterType\|str) -> Platform\|None` | 按类型/名取 | **deprecated** 4.0.0 |
| `get_db` | `() -> BaseDatabase` | 数据库 | |
| `register_provider` | `(provider: Provider) -> None` | 追加 chat provider | |
| `get_event_queue` | `() -> Queue` | 事件队列 | |
| `register_llm_tool` | `(name, func_args: list, desc, func_obj)` | 旧注册方式，`func_args` 必须是 **dict 列表** | **deprecated** |
| `unregister_llm_tool` | `(name: str) -> None` | | **deprecated** |
| `register_commands` | `(star_name, command_name, desc, priority, awaitable, use_regex=False, ignore_prefix=False)` | 旧指令注册 | **deprecated** |
| `register_task` | `(task: Awaitable, desc: str) -> None` | 后台任务 | **deprecated**（改用 `initialize()`） |
| 属性 | `provider_manager`, `platform_manager`, `conversation_manager`, `message_history_manager`, `persona_manager`, `astrbot_config_mgr`, `kb_manager`, `cron_manager`, `subagent_orchestrator`；私有 `_config`, `_db`, `_event_queue` | | |

`send_message` 核心循环（兼容层必须复刻「按 platform_id 匹配 `platform_insts`」的语义）：

```python
async def send_message(self, session: str | MessageSesion, message_chain: MessageChain) -> bool:
    if isinstance(session, str):
        try:
            session = MessageSesion.from_str(session)
        except BaseException as e:
            raise ValueError("不合法的 session 字符串: " + str(e))
    for platform in self.platform_manager.platform_insts:
        if platform.meta().id == session.platform_name:
            await platform.send_by_session(session, message_chain)
            ...
            return True
    logger.warning(f"cannot find platform for session {str(session)}, message not sent")
    return False
```

> 注意：`MessageSession.platform_name` 在 `__post_init__` 里被赋值为 `platform_id`，所以 `send_message` 实际是**按 platform_id 匹配**（`platform.meta().id`）。

### 7.4 `Platform` 抽象基类（兼容层要实现的等价物）

`astrbot/core/platform/platform.py`：

```python
class Platform(abc.ABC):
    def __init__(self, config: dict, event_queue: Queue) -> None: ...
    @abc.abstractmethod
    def run(self) -> Coroutine[Any, Any, None]: ...      # 平台运行实例，返回协程
    async def terminate(self) -> None: ...
    @abc.abstractmethod
    def meta(self) -> PlatformMetadata: ...
    async def send_by_session(self, session: MessageSesion, message_chain: MessageChain) -> None: ...
    def commit_event(self, event: AstrMessageEvent) -> None:      # _event_queue.put_nowait(event)
    def create_event(self, message: AstrBotMessage) -> AstrMessageEvent:
        return AstrMessageEvent(
            message_str=message.message_str,
            message_obj=message,
            platform_meta=self.meta(),
            session_id=message.session_id,
        )
    def get_client(self) -> object: ...
    async def webhook_callback(self, request: Any) -> Any: ...
    # 另有 status / errors / last_error / record_error / clear_errors / unified_webhook / get_stats
```

`PlatformMetadata`：

```python
@dataclass
class PlatformMetadata:
    name: str                    # 平台类型名，如 aiocqhttp, discord, slack
    description: str
    id: str                      # 唯一标识，用于配置中识别特定平台
    default_config_tmpl: dict | None = None
    adapter_display_name: str | None = None
    logo_path: str | None = None
    support_streaming_message: bool = True
    support_proactive_message: bool = True
    module_path: str | None = None
    i18n_resources: dict[str, dict] | None = None
    config_metadata: dict | None = None
```

`register_platform_adapter`（`astrbot/core/platform/register.py`）签名 `(adapter_name, default_config_tmpl=None, adapter_display_name=None, logo_path=None, ...)`，会把 `default_config_tmpl` 自动补 `type`/`enable`/`id` 键，并写入全局 `platform_cls_map`。

---

## 八、配置系统

### 8.1 `_conf_schema.json` 格式

放置于插件目录，UTF-8（允许 BOM，加载用 `utf-8-sig`，见 `_load_plugin_config_schema` L607-621）。字段全集（官方文档 https://docs.astrbot.app/dev/star/guides/plugin-config.html ）：

| 键 | 说明 |
|---|---|
| `type` | **必填**。`string` / `text` / `int` / `float` / `bool` / `object` / `list` / `dict` / `template_list` / `file` |
| `description` | 描述 |
| `hint` | 提示信息（问号按钮） |
| `obvious_hint` | hint 是否醒目 |
| `default` | 默认值（int 0 / float 0.0 / bool False / str "" / object {} / list []） |
| `items` | `type=object` 时的子 Schema（可嵌套） |
| `invisible` | 是否在面板隐藏（默认 false） |
| `secret` | 仅 `string` 和字符串 `list`；面板以密码框展示（**不加密存储**） |
| `options` | 下拉可选项列表 |
| `editor_mode` / `editor_language` / `editor_theme` | 代码编辑器（>= v3.5.10；语言默认 `json`；主题 `vs-light`/`vs-dark`） |
| `_special` | >= v4.0.0。`select_provider` / `select_provider_tts` / `select_provider_stt` / `select_persona` / `select_knowledgebase`（后者结果类型为 list） |
| `file_types` | `type=file`（>= v4.13.0）：允许上传的扩展名列表 |
| `template_schema` | `type=dict` 时的可视化模板 |
| `templates` | `type=template_list`（>= v4.10.4）；模板项支持 `display_item`、`hide_hint_in_list` |

完整示例：

```json
{
  "token": {
    "description": "Bot Token",
    "type": "string",
    "secret": true
  },
  "sub_config": {
    "description": "测试嵌套配置",
    "type": "object",
    "hint": "xxxx",
    "items": {
      "name": { "description": "testsub", "type": "string", "hint": "xxxx" },
      "id": { "description": "testsub", "type": "int", "hint": "xxxx" },
      "time": { "description": "testsub", "type": "int", "hint": "xxxx", "default": 123 }
    }
  }
}
```

`template_list` 保存结果形如：

```json
"field_id": [
  { "__template_key": "template_1", "attr_name": "", "attr_a": 10, "attr_b": true },
  { "__template_key": "template_2", "attr_c": 10, "attr_d": true }
]
```

真实插件规模参考：`astrbot_plugin_qq_group_daily_analysis/_conf_schema.json` = **122,576 字节**；`astrbot_plugin_livingmemory/_conf_schema.json` = 40,440 字节。

### 8.2 配置的加载与注入

`star_manager.py` L1156-1170：**只要插件目录存在 `_conf_schema.json`**（`self.conf_schema_fname`），就用它创建一个 `AstrBotConfig`，实体落在 `data/config/<root_dir_name>_config.json`：

```python
plugin_config = None
plugin_schema_path = os.path.join(plugin_dir_path, self.conf_schema_fname)
if os.path.exists(plugin_schema_path):
    plugin_config = AstrBotConfig(
        config_path=os.path.join(self.plugin_config_path, f"{root_dir_name}_config.json"),
        schema=self._load_plugin_config_schema(plugin_schema_path),
    )
```

随后作为 `config=` 关键字传给插件 `__init__`（见 §1.3 的签名探测）。插件侧标准写法：

```python
from astrbot.api import AstrBotConfig

class ConfigPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        # AstrBotConfig 继承自 Dict，拥有字典的所有方法
        super().__init__(context)
        self.config = config
        # self.config.save_config()  # 保存配置
```

**Schema 迁移**：更新版本后 Core 会递归比对 Schema，自动补默认值、移除不存在的配置项。

### 8.3 已在用的旧配置接口（`astrbot/core/star/config.py`，文件头即写「此功能已过时」）

```python
def load_config(namespace: str) -> dict | bool
def put_config(namespace: str, name: str, key: str, value, description: str) -> None
def update_config(namespace: str, key: str, value) -> None
```

读写 `data/config/{namespace}.json`，值为 `{"config_type","name","description","path","value","val_type"}` 结构；`namespace` 不能为空、不能以 `internal_` 开头，`value` 仅支持 `str/int/float/bool/list`（不支持 dict）。**这些通过 `astrbot.api.star`（`from astrbot.core.star.config import *`）和 `astrbot.api.all` 导出**，因此兼容层若想覆盖老插件，需要提供它们。

另有 `context.get_config(umo=None)` 读全局/会话配置，返回 `AstrBotConfig`。

---

## 九、插件语言与运行时

### 9.1 必须是 Python

**是的，AstrBot 插件必须是 Python。** 没有 TypeScript/JS 插件的可能：

- 发现机制硬编码 Python 模块导入（`main.py` / `<dir>.py`，模块路径 `data.plugins.<dir>.<module>`，见 `_get_modules` / `_import_plugin_with_dependency_recovery`）。
- 插件类必须继承 `astrbot.api.star.Star`，或（旧版）类名 `endswith("plugin")` / `== "main"`（`_get_classes`）。
- 装饰器是 Python 装饰器，注册表是进程内全局对象（`star_handlers_registry` / `star_map` / `llm_tools`）。
- Handler 必须是**协程或异步生成器**（`yield event.plain_result(...)`）。
- 依赖安装走 `pip`（`requirements.txt`）。

**WebUI/Dashboard 前端**（`dashboard/`，Vue + pnpm）是独立的 TS 前端，与插件体系无关。插件要给 WebUI 加页面，走 **Plugin Pages**（`metadata.yaml` 的 `pages` 字段 + `astrbot.api.web` 后端路由），而不是写插件级 TS。

### 9.2 Python 版本要求

| 来源 | 值 |
|---|---|
| PyPI `AstrBot` 4.28.1 `requires_python` | **`>=3.12`**（实测 `https://pypi.org/pypi/astrbot/json`） |
| 仓库 `AGENTS.md` 开发约定 | 「兼容 …Python 3.10+」（约定，非运行时门槛） |
| `components.py` pydantic 分支 | `sys.version_info >= (3, 14)` 用 pydantic v2，否则用 `pydantic.v1` |

### 9.3 依赖声明与安装

- 插件目录下 `requirements.txt`（**pip 官方格式**，支持 PEP 440 约束；不支持 pyproject/poetry）。
- 安装由 `pip_installer.install(requirements_path=...)` 执行，外层有 `_install_requirements_with_precheck()`（`star_manager.py` L139-190）做依赖冲突预检，冲突抛 `DependencyConflictError`；失败时还有「优先已安装依赖」的回退 `pip_installer.prefer_installed_dependencies(...)`。
- 运行时也会检查：`_check_plugin_dept_update()` / `_ensure_plugin_requirements()`（`star_manager.py` L333-371）。
- 实测真实 requirements.txt：

```
# astrbot_plugin_apis
aiohttp>=3.9,<4
beautifulsoup4>=4.12,<5

# astrbot_plugin_livingmemory
networkx>=3.0
jieba>=0.42.1
pytz>=2021.3
aiofiles>=23.0.0
aiosqlite>=0.20.0

# astrbot_plugin_qq_group_daily_analysis
diskcache
ulid-py
psutil
```

- 开发约束（官方）：不要用 `requests`，用 `aiohttp`/`httpx`；持久化数据放 `data/`（`StarTools.get_data_dir()` → `data/plugin_data/<plugin_name>`），不要放插件目录。
- 可选 `pyproject`-无关：`metadata.yaml` 的 `astrbot_version` 用 PEP 440 specifier 约束宿主版本；不满足会抛 `PluginVersionUnsupportedError` 阻止加载（可用 `ignore_version_check=True` 跳过，WebUI 有「无视警告，继续安装」）。

---

## 十、WebUI / 市场生态规模

数据来源：官方插件市场索引 `https://api.soulter.top/astrbot/plugins`（实测抓取，`$meta` 标注 `"name": "AstrBot Official Plugin Market"`，`"homepage": "https://cloud.astrbot.app"`，`"repository": "https://github.com/AstrBotDevs/astrbot-cloud"`，`schema_version: 1`）。

| 指标 | 值 |
|---|---|
| **插件总数** | **2,252**（顶层键计数，排除 `$meta`） |
| 索引结构 | `{ "<author>/<plugin_name>": { author, name, version, repo, desc, display_name, download_url, logo, category, support_platforms, astrbot_version, updated_at, commit_sha, stars, download_count } }` |
| 索引文件大小 | ≈ 1.62 MB JSON |
| 索引版本戳 | `2026-09-24T07:00:21Z` |

**Stars Top 10**：

| stars | downloads | 插件 | 作者 | 仓库 |
|---|---|---|---|---|
| 593 | 1,859 | `astrbot_sowing_discord` | anka | https://github.com/anka-afk/astrbot_sowing_discord |
| 491 | 6,106 | `astrbot_plugin_qq_group_daily_analysis` | SXP-Simon | https://github.com/SXP-Simon/astrbot_plugin_qq_group_daily_analysis |
| 410 | 18,849 | `astrbot_plugin_self_learning` | NickMo, EterUltimate | https://github.com/NickCharlie/astrbot_plugin_self_learning |
| 398 | 16,706 | `meme_manager` | anka | https://github.com/anka-afk/astrbot_plugin_meme_manager |
| 395 | 10,904 | `astrbot_plugin_proactive_chat` | DBJD-CR | https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat |
| 370 | 7,574 | `astrbot_plugin_private_companion` | menglimi | https://github.com/menglimi/astrbot_plugin_private_companion |
| 349 | 10,774 | `astrbot_plugin_livingmemory` | lxfight | https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory |
| 276 | 4,711 | `astrbot_plugin_apis` | Zhalslar | https://github.com/Zhalslar/astrbot_plugin_apis |
| 252 | 4,345 | `astrbot_plugin_mnemosyne` | lxfight | https://github.com/lxfight/astrbot_plugin_mnemosyne |
| 217 | 1,496 | `steam_status_monitor_V3` | Maoer | https://github.com/Maoer233/astrbot_plugin_steam_status_monitor |

**分类分布**：其他 1094 / 工具 394 / 娱乐 393 / 三方集成 200 / 生活 82 / 长期记忆 32 / 知识库 23 / AI 增强 15 / 语音 3 /（少量英文分类）。

**`support_platforms` 使用分布（Top 10）**：aiocqhttp 575、qq_official 222、telegram 168、discord 128、lark 111、qq_official_webhook 94、wecom 83、dingtalk 79、kook 75、slack 61。

**生态主仓库群**：`AstrBotDevs/AstrBot`（本体）、`AstrBotDevs/astrbot-cloud`（市场后端）、`AstrBotDevs/astrbot_plugin_*`（官方插件）、`Soulter/helloworld`（官方模板）；社区高产作者 `Zhalslar`、`anka-afk`、`lxfight`、`SXP-Simon`、`MengLimi`。

---

## 十一、要在一个 Node.js 框架里跑起来必须提供什么

### 11.1 结论先行

**AstrBot 插件不可能在 Node.js 里原生执行。** 插件是 Python 源码，依赖 CPython 语义（装饰器、`super().__init_subclass__`、async generator `yield`、pydantic 模型、`inspect.signature` 参数解析）。因此只有两条现实路线：

| 路线 | 可行性 | 说明 |
|---|---|---|
| A. **Python sidecar 进程**（推荐） | 高 | Node 主进程 ↔ Python 子进程，通过 stdio/JSON-RPC 或本地 socket 通信；sidecar 内运行一个「迷你 AstrBot 运行时」，把 Node 的事件翻译成 `AstrMessageEvent` 派发给真实插件 |
| B. 纯 JS 重写 AstrBot API 并用 JS 重写插件 | 低 | 只能跑「为 JS 重写的插件」，不是「真实 AstrBot 插件」，不满足需求 |

**方案 A 是本任务唯一可行路线**，下述即其规格。

### 11.2 Sidecar 必须提供的 Python 侧 API 面

**A. 包结构（必须可 import 的模块树）**

```
astrbot/
  __init__.py                       # logger, __version__（真实插件会 importlib.metadata.version("AstrBot")
                                    #   或读 astrbot.core.config.VERSION 做版本探测，见 livingmemory）
  api/
    __init__.py                     # AstrBotConfig, BaseFunctionToolExecutor, FunctionTool, ToolSet,
                                    #   agent, html_renderer, llm_tool, logger, sp
    all.py
    message_components.py           # from astrbot.core.message.components import *
    web.py                          # Plugin Pages 后端（fastapi/starlette）
    event/__init__.py               # AstrMessageEvent, CommandResult, EventResultType,
                                    #   MessageChain, MessageEventResult, ResultContentType
    event/filter/__init__.py        # command, command_group, event_message_type, regex,
                                    #   permission_type, platform_adapter_type, custom_filter,
                                    #   llm_tool, on_* / after_message_sent, EventMessageType,
                                    #   PlatformAdapterType, PermissionType, *Filter
    star/__init__.py                # Context, Star, StarTools, register (+ core.star.config 的 * 导出)
    platform/__init__.py            # AstrBotMessage, AstrMessageEvent, Group, MessageMember,
                                    #   MessageType, Platform, PlatformMetadata,
                                    #   register_platform_adapter (+ message components *)
    provider/__init__.py            # LLMResponse, Personality, Provider, ProviderMetaData,
                                    #   ProviderRequest, ProviderType, STTProvider
    util/__init__.py                # SessionController, SessionWaiter, session_waiter
  core/
    config/astrbot_config.py        # AstrBotConfig  ← 真实插件直接 import
    message/components.py           # 组件类 + ComponentTypes  ← 真实插件直接 import
    star/filter/event_message_type.py   # EventMessageType  ← 真实插件直接 import
    star/filter/{command,command_group,custom_filter,permission,platform_adapter_type,regex}.py
    star/{star.py,star_handler.py,context.py,base.py,config.py,register/*,star_tools.py}
    platform/{astr_message_event.py,astrbot_message.py,message_session.py,message_type.py,
              platform.py,platform_metadata.py,register.py,sources/aiocqhttp/*}
    utils/session_waiter.py         # session_waiter, SessionController, SessionFilter
    agent/{tool.py,run_context.py,message.py}, astr_agent_context.py    # 若支持 Tool/Agent 生态
```

经验法则：**`astrbot.api.*` 是契约面，必须 1:1；`astrbot.core.*` 被真实插件当半公开面直接 import，至少要覆盖上面标了粗体的部分**（`message.components`、`config.astrbot_config.AstrBotConfig`、`star.filter.event_message_type.EventMessageType`、`platform.sources.aiocqhttp.*`）。

**B. 加载器（复刻 `star_manager` 语义）**

1. 扫描 `data/plugins/<dir>/`，要求 `main.py` 或 `<dir>.py`。
2. 以 `data.plugins.<dir>.<module>` 为全限定名 `importlib` 导入（需为 `data` 与 `data.plugins` 建包，或自行注册到 `sys.modules`）。`__init__` 不存在的目录要能工作（真实做法是 loader 造 `parent` 模块并设 `__path__`）。
3. 读 `metadata.yaml`/`.yml`，校验必需字段 `name/desc/version/author` 非空字符串；`description` → `desc` 回退。
4. 从 `star_map[module_path]` 取 `StarMetadata`，用 metadata.yaml 逐字段覆盖。
5. 校验 `astrbot_version`（PEP 440）与本 sidecar 声称的版本。
6. 若存在 `_conf_schema.json` → 构造 `AstrBotConfig(config_path=data/config/<dir>_config.json, schema=...)`。
7. 实例化：`cls(context=..., config=...)`，`TypeError` 回退 `cls(context=...)`。
8. 注入 `name` / `author` / `plugin_id` 类属性（`plugin_id = f"{author.lower()}/{name.lower()}"`）。
9. 把该模块所有 handler 的 `functools.partial(raw_handler, instance)` 重新绑定（**幂等**：先还原 raw，再绑定）。
10. 调 `await instance.initialize()`；卸载时 `await instance.terminate()`，并把该模块的 handler/tool 从注册表清除。

**C. 装饰器与注册表**

- 需要一个进程内全局 `star_registry: list[StarMetadata]` + `star_map: dict[module_path, StarMetadata]`（**按 `__module__` 索引**）。
- `Star.__init_subclass__` 必须实现，否则 `@filter.*` 注册的 handler 找不到宿主插件。
- `star_handlers_registry` 条目字段（兼容层内部数据模型）：

```python
@dataclass
class StarHandlerMetadata:
    event_type: EventType          # 16 个枚举值，见 §4.1
    handler_full_name: str         # f"{module}_{func.__name__}"
    handler_name: str              # 方法名
    handler_module_path: str       # 模块路径
    handler: Callable              # 绑定后的 partial
    event_filters: list[HandlerFilter]
    desc: str = ""                 # 默认取 __doc__，可被 desc= 覆盖
    extras_configs: dict = {}      # priority 等
    enabled: bool = True
```

- `HandlerFilter` 是 ABC，唯一方法 `filter(self, event, cfg) -> bool`。**自定义 filter 插件会继承它**（真实插件 `PassiveGroupCaptureFilter` 就是这么做的），所以要暴露该类路径，并支持 `@filter.custom_filter(MyFilterCls, raise_error)` 两种调用形态。

**D. 事件对象（`AstrMessageEvent` 必须是真正可实例化的类，不能是 Protocol）**

真实插件会做 `isinstance(event, AiocqhttpMessageEvent)`，所以需要为每个平台提供子类。基类必须提供 §5.1/§5.2 的**全部**字段与方法（含 `role`、`is_wake`、`is_at_or_wake_command`、`unified_msg_origin` 及其 setter、`session`、`get_extra/set_extra`、`stop_event` 的独立 `_force_stopped` 语义）。派发前 pipeline 必须写入：

- `event.role = "admin" | "member"`（决定 `permission_type(ADMIN)`）
- `event.is_wake` / `event.is_at_or_wake_command`（决定 `@filter.command` 是否触发）
- `message_obj.type`（`MessageType` 枚举，决定 `event_message_type`）
- `message_obj.group`（决定 `get_group_id()`）
- `platform_meta.name` / `.id`（决定 `platform_adapter_type` 与 `unified_msg_origin`）
- `event.set_extra("_session_isolated", ...)`（决定 `SHARED_GROUP_ADMIN`）

**E. 消息组件与结果类型**

- 组件类需要**可构造 + `toDict()`/`to_dict()` 可序列化到 JSON**（跨进程传输时用 `toDict()` 的 `{"type","data"}` 形式最稳）。
- `Image.fromFileSystem` 用 `Path(path).resolve(strict=False).as_uri()` 生成 `file://` URI；`File` 的 `file` property 在异步上下文里会告警返回 `""` —— 兼容层若在 async 环境取 `File.file` 会踩这个坑，应改用 `await File.get_file()`。
- `MessageChain` / `MessageEventResult` 必须是 dataclass，且 `MessageEventResult(MessageChain)` 的继承关系要保留（插件可能对 `event.make_result()` 结果直接改 `.chain`）。
- `event.image_result(x)` 按 `x.startswith("http")` 分流 url/file。
- Handler 产出三态：`MessageEventResult` / `str` / `None`；`str` 会被 `set_result` 包成 `MessageEventResult().message(str)`。

**F. `Context`**

按 §7.3 提供方法（打桩亦可，但**不能抛 AttributeError** —— 真实插件在 `__init__` 就会调 `context.get_platform_inst`、`context.provider_manager`、`StarTools.get_data_dir()`）。跨进程场景建议：

- `context.send_message(session, chain)` → 序列化 chain → RPC 给 Node → Node 发到平台。
- `context.llm_generate(...)` / `context.get_current_chat_provider_id(umo)` → RPC 给 Node 的模型层。
- `context.get_config(umo)` → 返回 sidecar 内持有的配置 dict。
- `StarTools` 需要 `initialize(context)` 的等价物（原版由 Core 在启动时调用），否则 `StarTools.send_message` 会抛 `ValueError("StarTools not initialized")`。

**G. 平台适配器接口（若插件注册平台适配器）**

插件可通过 `@register_platform_adapter(...)` + `class X(Platform)` 新增平台。兼容层需要实现 §7.4 的 `Platform` ABC 与 `PlatformMetadata`，并把事件队列接到 Node 侧。

### 11.3 Node ↔ Python 通信契约（建议）

```
Node（Jiuli 主进程）
  ├─ 发现/生命周期 RPC
  │    plugins.list() / plugins.load(dir) / plugins.reload(name) / plugins.unload(name)
  │    plugins.metadata(name) / plugins.config.get(name) / plugins.config.set(name, path, value)
  ├─ 事件下行（Node → Python）
  │    event.dispatch({ umo, platform:{name,id}, message:{type,message_id,session_id,group_id,
  │                     self_id,sender:{user_id,nickname},message:[{type,data}],message_str,
  │                     timestamp}, is_wake, is_at_or_wake_command, role, raw })
  ├─ 出站上行（Python → Node）
  │    message.send({ umo, chain:[{type,data}], use_t2i, use_markdown, type })
  │    message.send_proactive({ umo, chain })         ← context.send_message
  │    llm.generate({ provider_id, prompt, ... })     ← context.llm_generate
  │    platform.call({ platform_id, action, payload }) ← event.bot.api.call_action
  │    api.route.register({ route, methods }) / webapi.call
  └─ 日志/错误上报：plugin.log / plugin.error（含 traceback）
```

**编解码铁律**：只传 `components.toDict()` 的 `{"type","data"}` 结构（lossless JSON），**绝不传 Python/JS 活对象**；`raw_message`、`TraceSpan`、`AstrBotConfig` 实例等留在各自进程内，用 id 引用。

### 11.4 Sidecar 方案可行性分析

**可行，且是唯一路线。** 依据：

1. **运行时自洽**：AstrBot 本体就是「一个 Python 进程 + 一个全局插件注册表 + 一个事件队列」（`Context` 构造里直接吃 `event_queue: Queue`、`platform_manager`、`provider_manager`）。sidecar 只需实现「注册表 + 事件队列 + 平台/Provider 代理」，无需任何 AstrBot 内部服务（数据库、WebUI、LLM 真实调用都可通过 RPC 外置）。
2. **耦合点集中**：插件与宿主的耦合只有 4 个面 —— (§3) import 路径、(§4) 装饰器/注册表、(§5+§6) 事件与消息对象、(§7) Context/Star。没有插件会去碰 `astrbot/core/star/star_manager.py` 或 `main.py`（那是宿主启动逻辑）。
3. **已有先例的边界**：官方 `Plugin Pages`（`astrbot.api.web`，基于 FastAPI）是唯一强绑 Web 框架的部分，属于可选能力，一期可以不支持。

**必须正视的风险 / 成本**：

| 风险 | 影响 | 应对 |
|---|---|---|
| **真实插件直接 import `astrbot.core.*`**（实测 3/3 个头部插件都这么干） | 只实现 `astrbot.api` 会大面积 ImportError | 把 `astrbot.core.{config.astrbot_config, message.components, star.filter.*, utils.session_waiter, platform.sources.aiocqhttp}` 一并实现 |
| **`astrbot_version` 门槛会硬拦** | 插件声明 `>=4.24.1` 等，sidecar 谎报版本会误导插件内部逻辑（如 livingmemory 自己探测宿主版本） | 明确 sidecar 声称的兼容版本并对齐真实 AstrBot 版本号；提供 `ignore_version_check` 逃生口 |
| **`requirements.txt` 需要 pip 环境** | 用户机器无 Python/无 pip 直接不可用 | 捆绑嵌入式 Python（embeddable/uv venv）；首次加载装依赖；失败降级并报「该插件需依赖 X」 |
| **`PermissionType.ADMIN` 只读 `event.role`** | pipeline 未设置则管理员指令对所有人放行（安全性 bug） | 事件下行协议里 `role` 必填，sidecar 做默认拒绝 |
| **`stop_event()` 的 `_force_stopped` 与 `_result` 双通道** | 只实现一边会出现「插件以为停了但继续传播」 | 两个字段都实现，`is_stopped()` 优先看 `_force_stopped` |
| **handler 二次绑定非幂等** | 热重载后 handler 堆积、self 指向旧实例 | 复刻「先还原 raw_handler，再 partial 绑定」 |
| **`RegexFilter` 不受 wake_prefix 约束 / `CommandFilter` 受约束** | 触发条件错位，插件「不响应」或「乱响应」 | 严格按 §4.5 实现唤醒态判定 |
| **`File.file` 在 async 上下文返回空串** | 文件消息段静默丢失 | sidecar 内部统一走 `await get_file()` |
| **跨进程消息链序列化丢失 `file://` / 本地路径语义** | 图片/语音/视频发不出去 | 定义清晰的边界规则：sidecar 侧把本地文件注册成 HTTP 或 base64 再上行 |
| **`event.bot.api.call_action(...)` 直连协议端** | 插件绕过框架直接调 OneBot API（真实高频用法） | sidecar 必须暴露 `platform.call(platform_id, action, payload)`，并把 `event.bot` 做成 RPC 代理对象 |
| **pydantic v1/v2 双分支** | Python 3.14+ 行为差异 | sidecar 固定 Python 3.12/3.13 + `pydantic.v1` |

**建议的落地顺序（渐进式）**：
1. 一期：sidecar 骨架 + `astrbot.api.*`/`astrbot.core.{message,config,star.filter}` + 加载器 + `@filter.command` / `command_group` / `event_message_type` / `permission_type` / `regex` + `Plain`/`Image`/`At`/`Reply` + `context.send_message` + `event.plain_result/chain_result` + 主动消息 RPC。
2. 二期：`platform_adapter_type` / `custom_filter` / 全部 `on_*` 钩子 / `llm_tool` + `context.llm_generate` / `tool_loop_agent` / Provider 相关 / `Record`/`Video`/`File`/`Node`/`Nodes` / `event.bot` 代理 / `session_waiter`。
3. 三期：`register_platform_adapter`（插件自定义平台）、Plugin Pages（`astrbot.api.web`）、`skills/` 加载、i18n、`_conf_schema.json` 全类型 + WebUI 配置面板。

---

### 附：本报告的一手取证方式（可复现）

```powershell
# 1) 拉本体源码（本机 github.com:443 git 协议可用，实测成功）
git clone --depth 1 https://github.com/AstrBotDevs/AstrBot.git .tmp-astrbot-src
#    关键文件：astrbot/api/**、astrbot/core/star/**、astrbot/core/message/**、
#             astrbot/core/platform/**、astrbot/builtin_stars/**

# 2) 官方模板（raw.githubusercontent 可用）
#    https://raw.githubusercontent.com/Soulter/helloworld/master/{main.py,metadata.yaml}

# 3) 真实第三方插件（raw.githubusercontent 可用；直连 git clone 在本次环境中超时）
#    https://raw.githubusercontent.com/Zhalslar/astrbot_plugin_apis/main/main.py
#    https://raw.githubusercontent.com/lxfight/astrbot_plugin_livingmemory/master/main.py
#    https://raw.githubusercontent.com/SXP-Simon/astrbot_plugin_qq_group_daily_analysis/main/main.py

# 4) 插件市场索引
Invoke-WebRequest https://api.soulter.top/astrbot/plugins   # 2252 条
```

> 说明：`web_search` 工具在本次会话不可用（provider 返回 `configured web provider "deepseek-official" is registered but unavailable`），因此生态规模数据改为直接从官方市场索引 API 取全量 JSON 统计，比搜索结果更权威。
