# GsCore / gsuid_core / Sayu-Bot（早苗）插件体系 —— 精确 API 面清单

> 目的：供另一位工程师编写「让 Node.js 机器人框架兼容运行 GsCore 插件」的兼容层。
> 所有结论均来自一手源码/文档，标注了文件路径与 URL。源码快照：
> - `Genshin-bots/gsuid_core` @ `master`（本地 `D:\yunzaibot\JiuLi\_gsresearch\x\gsuid_core-master\`，commit tree `d3acf7f5`）
> - 真实插件仓库：`KimigaiiWuyi/GenshinUID` @ `v4`、`baiqwerdvd/StarRailUID` @ `master`、`KimigaiiWuyi/WzryUID` @ `main`、`ZZZure/ZZZeroUID` @ `master`
> - 文档：<https://docs.sayu-bot.com/CodePlugins/Start.html>、`/CodeAdapter/Protocol.html`、`/CodeAdapter/Pack.html`、`/InstallPlugins/PluginsList.html>
> - 官方插件索引：<https://docs.sayu-bot.com/plugin_list.json>

---

## 0. TL;DR —— 给兼容层作者的结论

1. **插件就是普通 Python 模块**，不是声明式配置。一个插件 = `gsuid_core/plugins/<Pkg>/` 目录，靠 `importlib` 在启动时 `exec_module`；**触发器是 import 的副作用**（模块级 `@sv.on_xxx` 装饰器）。
2. **没有任何 manifest 文件**。`pyproject.toml` 是可选的，只用于 (a) 自动 pip 装依赖，(b) 可选 `[tool.gsuid] kind="meta"` 标记基础设施插件。
3. 真正的「插件元数据」由框架在首次启动时**写盘**到 `data/plugins_configs/<PluginName>.json`（前缀、SV 开关、pm、黑白名单）。用户改的是它，改完发 `core重载插件<名>` 热重载。
4. 实测 API 面：**4 个真实插件仓库共 856 条 `gsuid_core.*` import 语句，覆盖 60 个模块路径**，另外 core 自带 `buildin_plugins` 还有 ~138 条。热门前 6 个模块就能覆盖绝大多数插件：
   `gsuid_core.logger`、`gsuid_core.models`、`gsuid_core.bot`、`gsuid_core.sv`、`gsuid_core.i18n`、`gsuid_core.utils.image.convert`。
5. **真正的不可移植点不是 API，而是运行时依赖**：
   - `convert_img` / `image_tools` = **Pillow（PIL）**，GenshinUID 一仓库 220 个 py 文件 / 41,931 行里有 **478 处 PIL 调用**；
   - 配置 = **msgspec.Struct**，DB = **SQLModel + SQLAlchemy async**，调度 = **APScheduler AsyncIOScheduler**；
   - 富媒体 = `MessageSegment` → `Message(type,data)`，通过 **WebSocket JSON** 与适配器通信（`/ws/{bot_id}`）。
6. 因此兼容层的两种现实形态：
   - **(A) Node 当适配器（推荐、成本最低）**：Node 作为 GsCore 协议端，连 `ws://core/ws/<bot_id>`，收发 `MessageReceive`/`MessageSend`。插件仍然由 Python 的 gsuid_core 宿主执行。Node 只需实现协议 + 平台 API。**这是官方支持的用法**（NoneBot2 / Hoshino / Koishi / Yunzai 都是这么接的）。
   - **(B) Node 宿主 + Python 插件侧车**：Node 负责事件/命令分发与平台对接，Python 侧车只加载并运行插件（提供 `gsuid_core` shim 包），通过本地 RPC 交互。可行，但必须把 PIL/SQLModel/APScheduler 留在 Python 侧。
   - **(C) 纯 JS 重写整个插件宿主**：成本极高（core 631 个 py / 153,865 行；PIL 绘图管线不可替代），**不建议**。
7. 如果只做最小可用集，必须先实现：`SV/Plugins` 注册 + 8 种触发器匹配语义、`Event` 全部字段、`Bot.send/receive_resp`、`logger`、`i18n.t`、`MessageSegment`、`StringConfig`、`scheduler`、`gs_subscribe`、`get_res_path`。**但一旦插件调用 `convert_img` 或 `gsuid_core.utils.image.*`，纯 JS 就断了。**

---

## 1. 插件是什么语言、放在哪、如何被发现和加载

### 1.1 语言与目录

- 语言：**Python 3.10+**（GenshinUID `requires-python = ">=3.10,<4.0"`；文档建议 3.11）。
- 目录：**`<gsuid_core>/gsuid_core/plugins/<PluginName>/`**（用户插件）与 **`<gsuid_core>/gsuid_core/buildin_plugins/`**（核心自带插件）。

```python
# gsuid_core/server.py:51-52
PLUGIN_PATH = Path(__file__).parent / "plugins"
BUILDIN_PLUGIN_PATH = Path(__file__).parent / "buildin_plugins"

# gsuid_core/utils/plugins_update/api.py:5-6
PLUGINS_PATH = Path(__file__).parents[2] / "plugins"
CORE_PATH = Path(__file__).parents[3]
```

`gs_test.py` 这类**单文件插件**也支持（`plugins/gs_test.py`）。

### 1.2 扫描与加载流程（`server.py`）

`load_plugins()` 是入口（`server.py:530`）：

```python
# gsuid_core/server.py:539-543
plug_path_list = [
    p
    for p in list(BUILDIN_PLUGIN_PATH.iterdir()) + list(PLUGIN_PATH.iterdir())
    if p.is_dir() or (p.is_file() and p.suffix == ".py")
]
```

三阶段（源码注释原文）：① 发现插件 + 收集缺失依赖；② `flush_pending_installs()` 一次性 pip 安装；③ 先 import meta 插件再 import 常规插件。

`load_plugin()`（`server.py:372-451`）决定「哪些文件是入口」，**目录内约定文件决定加载模式**：

| 目录内存在的文件 | 加载模式 | 生成的模块名 |
|---|---|---|
| `__full__.py` | `load_dir_plugins(plugin, parent)`：加载 `__init__.py` **以及**所有含 `__init__.py` 的直接子包 | `{parent}.{Name}.{Name}` 和 `{parent}.{Name}.{sub}` |
| `__nest__.py` | `load_dir_plugins(nest_path.parent/Name, parent, nest=True)`：多一层嵌套，即代码在 `<Pkg>/<Pkg>/` 里 | `{parent}.{Name}.{Name}.{sub}` |
| 仅 `__init__.py` | 单个插件包 | `{parent}.{Name}` |
| 单 `.py` 文件 | 单文件插件 | `{parent}.{stem}` |

```python
# gsuid_core/server.py:404-447（节选）
plugin_path = plugin / "__init__.py"
plugins_path = plugin / "__full__.py"
nest_path = plugin / "__nest__.py"
src_path = plugin / plugin.stem

if plugins_path.exists():
    module_list = self.load_dir_plugins(plugin, plugin_parent, dev_mode=dev_mode)
elif nest_path.exists() or src_path.exists():
    path = nest_path.parent / plugin.name.removesuffix("-dev")
    if path.exists():
        module_list = self.load_dir_plugins(path, plugin_parent, True, dev_mode=dev_mode)
elif plugin_path.exists():
    module_list = [(f"{plugin_parent}.{plugin.name}", plugin_path, "plugin")]
elif plugin.suffix == ".py":
    module_list = [(f"{plugin_parent}.{plugin.name[:-3]}", plugin, "single")]
```

**真实插件全部使用 `__nest__.py` + 内层 `__full__.py`**（已实测）：

| 仓库 | 根目录 | 内层包 | 内层标记 |
|---|---|---|---|
| GenshinUID (v4) | `__init__.py`(空) + `__nest__.py`(空) | `GenshinUID/GenshinUID/` | `__full__.py` |
| StarRailUID | 同上 | `StarRailUID/StarRailUID/` | `__full__.py` |
| ZZZeroUID | 同上 | `ZZZeroUID/ZZZeroUID/` | `__full__.py` |
| WzryUID | 同上 | `WzryUID/WzryUID/` | `__full__.py` |

所以运行时模块名形如 `plugins.GenshinUID.GenshinUID.genshinuid_signin`。

**实际 import 细节**（`server.py:467-481`）：

```python
spec = importlib.util.spec_from_file_location(module_name, filepath)
module = importlib.util.module_from_spec(spec)
sys.modules[module_name] = module          # 先放入，处理循环导入
spec.loader.exec_module(module)            # ← 触发器在此刻注册
```

导入失败只 `logger.exception` 并继续（`_import_module_list`, `server.py:501-506`）——**单个插件坏了不影响其他插件**。

`should_load_plugin()`（`server.py:113-119`）：`--dev` 模式下只加载 `*-dev` 命名的普通插件，`__meta_plugin__.py` / `[tool.gsuid] kind="meta"` 的基础设施插件始终加载。

`_is_plugin()`（`utils/plugins_update/_plugins.py`）：目录且名字不是 `__pycache__` / `core_command` 即视为插件——用于 `core安装插件` 的本地列举。

### 1.3 是否有 manifest / 元数据

**没有 manifest 文件。** 有三类元数据来源：

1. **`pyproject.toml`（可选）** — 声明 pip 依赖，框架自动安装：
   ```toml
   # GenshinUID/pyproject.toml（实测原文）
   [project]
   name = "GenshinUID"
   version = "7.0.0"
   requires-python = ">=3.10,<4.0"
   dependencies = ["httpx>=0.23.0", "beautifulsoup4>=4.11.1", "lxml>=4.9.2"]
   ```
   以及可选的 meta 标记（`server.py:81-110`）：
   ```toml
   [tool.gsuid]
   kind = "meta"
   provides = "some.service"
   ```
   或直接放一个空文件 `__meta_plugin__.py`。

2. **`Plugins(...)` 调用（插件内代码）** — 声明插件名前缀/别名，见 §4.1：

   ```python
   # GenshinUID/GenshinUID/__init__.py（实测原文，全文仅 8 行）
   from gsuid_core.sv import Plugins

   Plugins(
       name="GenshinUID",
       force_prefix=["gs"],
       allow_empty_prefix=False,
       alias=["gsuid"],
   )
   ```

3. **框架写盘的运行时元数据** — `data/plugins_configs/<PluginName>.json`（见 §7），由用户在网页控制台改。

**插件名 = 目录名。** `SV.__init__` 用调用栈反推（`sv.py:144-153`）：

```python
stack = traceback.extract_stack()
file = stack[-2].filename
parts = Path(file).parts
if "plugins" in parts:
    i = parts.index("plugins")
else:
    i = parts.index("buildin_plugins")
self.self_plugin_name = plugins_name = parts[i + 1]
```

> **兼容层要点**：这个「按路径含 `plugins`/`buildin_plugins` 段反推插件名」的机制意味着插件目录**必须**叫 `<PluginName>` 且在 `plugins/` 下，否则报错。

### 1.4 是否需要重新加载指令

**需要。** 修改插件代码后必须重载。两类指令：

```python
# gsuid_core/buildin_plugins/core_command/core_update/__init__.py:25-38
sv_core_config = SV("Core管理", pm=0)

@sv_core_config.on_prefix(("手动重载插件", "重载插件"))
async def send_core_reload_msg(bot: Bot, ev: Event):
    plugin_name = ev.text.strip()
    ...
    plugin_name = await resolve_plugin_name(plugin_name)   # 支持别名 / 大小写不敏感
    retcode = reload_plugin(plugin_name)
    await bot.send(retcode)
```

对用户可见的形式：`core重载插件genshinuid`、`core更新插件<名>`、`core安装插件<名>`。
安装/卸载指令（`buildin_plugins/core_command/install_plugins/__init__.py:16,44,58,68`）：
`卸载插件` / `安装插件` / `刷新插件列表` / `更新插件`。

`reload_plugin` 实现：`gsuid_core/utils/plugins_update/reload_plugin.py`（清理旧 SV / `sys.modules` / 定时任务 / 路由，再重新 `load_plugin`）。
说明（`_plugins.py:533-536` 注释原文）：*"reload_plugin 对从未加载过的插件等价于「首次加载」"*。

插件列表来自远端 JSON（`utils/plugins_update/api.py:3`）：

```python
plugins_lib = "https://docs.sayu-bot.com/plugin_list.json"
```

---

## 2. 最小插件：完整可运行代码

### 2.1 文档版最小插件（天气插件，含命令 + 前缀 + 后缀）

来源：<https://docs.sayu-bot.com/CodePlugins/CookBook.html>（`gsuid_core/plugins/gs_weather/__init__.py`）

```python
from gsuid_core.sv import SV
from gsuid_core.bot import Bot
from gsuid_core.models import Event

gs_weather_info = SV('天气信息查询')


@gs_weather_info.on_suffix('天气', block=True)
@gs_weather_info.on_command('天气', block=True)
async def send_weather_msg(bot: Bot, ev: Event):
    text = ev.text.strip()
    if not text:
        return await bot.send('请输入城市名称！')
    ...
    await bot.send(text)
```

配套 `database.py`（同页文档）：

```python
from typing import Optional
from sqlmodel import Field
from gsuid_core.utils.database.base_models import Bind


class WeatherBind(Bind, table=True):
    uid: Optional[str] = Field(default=None, title='城市')
```

`__init__.py` 里 `from .database import WeatherBind`，然后：

```python
@gs_weather_info.on_command('tq绑定城市')
async def bind_city(bot: Bot, ev: Event):
    ...
    await WeatherBind.insert_uid(ev.user_id, ev.bot_id, uuid, ev.group_id)
```

### 2.2 框架自带的最小可运行插件（**推荐作为兼容层第一个回归测试**）

来源：`gsuid_core/buildin_plugins/gs_test.py`（真实源码，节选，展示了全部触发器种类）

```python
import asyncio

from async_timeout import timeout

from gsuid_core.sv import SL, SV
from gsuid_core.bot import Bot
from gsuid_core.logger import logger
from gsuid_core.models import Event
from gsuid_core.segment import MessageSegment
from gsuid_core.subscribe import gs_subscribe
from gsuid_core.message_models import Button

sv_switch = SV("测试开关")


@sv_switch.on_prefix(("关闭", "开启"))
async def get_switch_msg(bot: Bot, ev: Event):
    name = ev.text
    if not name:
        return
    await bot.send(await bot.t("正在进行[关闭/开启开关]"))
    if name in SL.lst:
        if ev.command == "关闭":
            SL.lst[name].disable()
            await bot.send(await bot.t("关闭成功！"))
        else:
            SL.lst[name].enable()
            await bot.send(await bot.t("开启成功！"))
    else:
        await bot.send(await bot.t("未找到该服务..."))


@sv_switch.on_fullmatch("全匹配测试")
async def get_fullmatch_msg(bot: Bot, ev: Event):
    await bot.send(await bot.t("正在进行[全匹配测试]"))
    await asyncio.sleep(2)
    await bot.send(await bot.t("[全匹配测试]校验成功！"))


@sv_switch.on_fullmatch("开始游戏")
async def get_resp_msg(bot: Bot, ev: Event):
    await bot.send(await bot.t("正在进行[开始游戏测试]"))
    while True:
        resp = await bot.receive_resp(
            "请选择一个选项!",
            ["🎨可爱的丛林", "🚀遥远的星空", "📝不如在家写作业", "✨或者看星星", "🚧这里是维护选项"],
        )
        if resp is not None:
            await bot.send(await bot.t("你输入的是{p0}", p0=resp.text))


@sv_switch.on_regex(r"这是一个(?P<name>正则|数字)测试！(?P<int>[\d]+)")
async def get_regex_msg(bot: Bot, ev: Event):
    await bot.send(
        await bot.t("[正则测试]校验成功！{p0}你输入的是{p1}",
                    p0=ev.regex_dict["name"], p1=ev.regex_dict["int"])
    )


@sv_switch.on_fullmatch("按钮模板")
async def send_temp_button_msg(bot: Bot, ev: Event):
    ab = Button("🏝️野外探索", "野外探索")
    ...
    buttons = [ab, bb, cb, db, eb, fb, gb, hb, ib, jb]
    await bot.send_option(await bot.t("测试"), buttons)


@sv_switch.on_fullmatch("订阅测试")
async def handle_subscribe(bot: Bot, ev: Event):
    await gs_subscribe.add_subscribe("single", "订阅测试", ev, extra_message="测试")
    data = await gs_subscribe.get_subscribe("订阅测试")
    logger.info(data)
    await bot.send(await bot.t("订阅成功！"))
```

### 2.3 野外真实最小模块（WzryUID，完整文件）

来源：`WzryUID/WzryUID/wzryuid_help/__init__.py`（真实仓库原文，全文）

```python
from PIL import Image
from gsuid_core.sv import SV
from gsuid_core.bot import Bot
from gsuid_core.models import Event
from gsuid_core.logger import logger
from gsuid_core.help.utils import register_help

from .get_help import ICON, get_wzry_core_help

sv_wzry_help = SV('王者帮助')


@sv_wzry_help.on_fullmatch(('王者帮助', '王者荣耀帮助'))
async def send_help_img(bot: Bot, ev: Event):
    logger.info('开始执行[王者帮助]')
    im = await get_wzry_core_help()
    await bot.send(im)


register_help('WzryUID', '王者帮助', Image.open(ICON))
```

注意最后一行：**`register_help` 在模块级被调用，并向框架注册一个 PIL `Image` 对象**——这是 import 副作用驱动注册的典型例子。

---

## 3. import 清单（按模块分组，来自真实源码）

### 3.1 方法

下载 4 个真实插件仓库（zipball over HTTPS），对全部 `*.py` 用正则
`^\s*(from\s+gsuid_core[\w\.]*\s+import\s+.+|import\s+gsuid_core[\w\.]*)` 穷举统计。

结果：**856 条语句，60 个不同模块路径**（另有 core 自带 `buildin_plugins` 的 138 条，含大量内部模块）。

### 3.2 热门前 30（跨插件 + buildin 计数）

```
 144  from gsuid_core.logger import logger
 138  from gsuid_core.models import Event
  99  from gsuid_core.bot import Bot
  87  from gsuid_core.sv import SV
  73  from gsuid_core.i18n import t
  46  from gsuid_core.utils.image.convert import convert_img
  25  from gsuid_core.utils.database.models import GsBind
  25  from gsuid_core.ai_core.trigger_bridge import ai_return
  20  from gsuid_core.utils.error_reply import get_error
  18  from gsuid_core.aps import scheduler
  15  from gsuid_core.utils.database.api import get_uid
  13  from gsuid_core.subscribe import gs_subscribe
  11  from gsuid_core.sv import get_plugin_available_prefix
  10  from gsuid_core.utils.error_reply import get_error_img
   9  from gsuid_core.utils.database.models import GsBind, GsUser
   9  from gsuid_core.data_store import get_res_path
   9  from gsuid_core.segment import MessageSegment
   7  from gsuid_core.utils.image.image_tools import draw_pic_with_ring
   6  from gsuid_core.utils.fonts.fonts import core_font
   5  from gsuid_core.utils.plugins_config.models import (...)
   5  from gsuid_core.utils.database.models import GsUser
   4  from gsuid_core.utils.image.image_tools import get_avatar_with_ring
   4  from gsuid_core.server import on_core_start
   4  from gsuid_core.sv import Plugins
   4  from gsuid_core.help.model import PluginHelp
   4  from gsuid_core.help.utils import register_help
   4  from gsuid_core.gss import gss
   4  from gsuid_core.utils.api.ambr.request import (...)
   4  from gsuid_core.utils.image.image_tools import crop_center_img
   4  from gsuid_core.message_models import Button
   4  from gsuid_core.utils.plugins_config.gs_config import StringConfig
```

### 3.3 完整模块路径清单（60 个，仅 4 个真实插件仓库）

格式：`` `模块路径` (语句数) ← 被导入的名字 ``

```
gsuid_core.ai_core.models                  (3)   ← ToolContext
gsuid_core.ai_core.rag                     (1)   ← query_knowledge
gsuid_core.ai_core.register                (4)   ← ai_tools, ai_alias, ai_entity
gsuid_core.ai_core.trigger_bridge          (25)  ← ai_return
gsuid_core.aps                             (15)  ← scheduler
gsuid_core.bot                             (86)  ← Bot, call_bot, _Bot, message_list_to_str
gsuid_core.data_store                      (7)   ← get_res_path
gsuid_core.gss                             (2)   ← gss
gsuid_core.help.draw_new_plugin_help       (3)   ← get_new_help
gsuid_core.help.draw_plugin_help           (1)   ← get_help
gsuid_core.help.model                      (4)   ← PluginHelp
gsuid_core.help.utils                      (4)   ← register_help
gsuid_core.i18n                            (63)  ← t, t as i18n_t
gsuid_core.logger                          (130) ← logger
gsuid_core.message_models                  (2)   ← Button
gsuid_core.meta_plugins                    (1)   ← import_api
gsuid_core.models                          (124) ← Event, Message
gsuid_core.pool                            (3)   ← to_thread
gsuid_core.segment                         (8)   ← MessageSegment
gsuid_core.server                          (4)   ← on_core_start
gsuid_core.status.plugin_status            (1)   ← register_status
gsuid_core.subscribe                       (14)  ← gs_subscribe, Subscribe
gsuid_core.sv                              (93)  ← SV, Plugins, SL, get_plugin_available_prefix
gsuid_core.utils.api.ambr.api              (2)   ← AMBR_BASE_URL, AMBR_ICON_URL
gsuid_core.utils.api.ambr.request          (8)   ← get_ambr_icon, get_ambr_event_info, ...
gsuid_core.utils.api.enka.models           (2)   ← EnkaData
gsuid_core.utils.api.enka.request          (1)   ← get_enka_info
gsuid_core.utils.api.hakush.request        (1)   ← (...)
gsuid_core.utils.api.minigg.exception      (1)   ← MiniggNotFoundError
gsuid_core.utils.api.minigg.models         (1)   ← CharacterTalents
gsuid_core.utils.api.minigg.request        (2)   ← get_map_data, (...)
gsuid_core.utils.api.mys_api               (3)   ← _MysApi, mys_api
gsuid_core.utils.api.mys.api               (6)   ← ApiEndpoint, BBS_URL, GET_GACHA_LOG, GS_BASE/RECORD_BASE, (...)
gsuid_core.utils.api.mys.base_request      (1)   ← RECOGNIZE_SERVER
gsuid_core.utils.api.mys.models            (18)  ← IndexData, MihoyoAvatar, MihoyoWeapon, ReliquarySet,
                                                   MihoyoReliquary, MysGame, Act, FixedAct, AbyssBattleAvatar,
                                                   Offering, RoundData, Stats, WorldExploration,
                                                   WidgetResin, DailyNoteData, SeasonPostData, (...)
gsuid_core.utils.api.mys.tools             (2)   ← (...)
gsuid_core.utils.api.utils                 (2)   ← _HEADER, cache_data
gsuid_core.utils.backup.backup_files       (1)   ← clear_path_all_file
gsuid_core.utils.cache                     (3)   ← CACHE, gs_cache
gsuid_core.utils.database.api              (15)  ← get_uid
gsuid_core.utils.database.base_models      (3)   ← Bind, User, Push, BaseIDModel, with_session
gsuid_core.utils.database.models           (42)  ← GsBind, GsUser, CoreUser, CoreGroup, Subscribe
gsuid_core.utils.download_resource.download_core  (3) ← download_all_file
gsuid_core.utils.download_resource.download_file  (3) ← download
gsuid_core.utils.download_resource.download_image (3) ← get_image
gsuid_core.utils.error_reply               (37)  ← get_error, get_error_img, ERROR_CODE,
                                                   CK_HINT, UID_HINT, CHAR_HINT, (...)
gsuid_core.utils.fonts.fonts               (6)   ← core_font, core_font as cf
gsuid_core.utils.html_render               (3)   ← render_html_to_bytes, _ensure_renderer
gsuid_core.utils.image.convert             (45)  ← convert_img
gsuid_core.utils.image.image_tools         (24)  ← crop_center_img, CustomizeImage, get_event_avatar,
                                                   draw_pic_with_ring, get_color_bg, draw_text_by_line,
                                                   get_avatar_with_ring, get_pic, (...)
gsuid_core.utils.image.mys.bbs             (1)   ← get_post_img
gsuid_core.utils.message                   (1)   ← send_diff_msg, send_msg_to_master
gsuid_core.utils.path_safety               (1)   ← PathEscapeError, safe_join, is_safe_filename
gsuid_core.utils.plugins_config.gs_config  (3)   ← StringConfig
gsuid_core.utils.plugins_config.models     (3)   ← GsStrConfig, GsBoolConfig, GsListStrConfig, GSC, (...)
gsuid_core.utils.sign.sign                 (3)   ← sign_in
gsuid_core.version                         (1)   ← __version__
gsuid_core.webconsole                      (2)   ← site
gsuid_core.webconsole.mount_app            (3)   ← PageSchema, GsAdminModel, site
gsuid_core.webconsole.plugin_page          (2)   ← register_plugin_page, (...)
```

> 说明：`buildin_plugins` 另外引入了少量内部模块（`gsuid_core.config`、`gsuid_core.handler`、`gsuid_core.ai_core.*` 深处的内部工具等）。普通第三方插件**不需要**这些。

### 3.4 第三方依赖（插件声明的，非框架）

| 依赖 | 出现处 | 用途 |
|---|---|---|
| `Pillow` (PIL) | 所有绘图插件（隐式，由 core 带入） | 图片合成/绘制 |
| `httpx` | GenshinUID `pyproject.toml` | 异步 HTTP |
| `beautifulsoup4`, `lxml` | GenshinUID `pyproject.toml` | HTML 解析 |
| `sqlmodel` | 自定义表的插件 | ORM 声明 |
| `async_timeout` | `gs_test.py` | 超时上下文（`receive_mutiply_resp` 计时） |
| `msgspec` | core 自身（Config/Message/Button） | 高性能序列化 |
| `apscheduler` | core 自身（`gsuid_core.aps`） | 定时任务 |
| `playwright` | SayuStock 等 | 无头浏览器渲染 |

`from PIL import Image` 在插件里的**引用密度**（实测，非行数占比）：

| 仓库 | py 文件 | 行数 | PIL 引用 | MsgSegment | 触发器 | 定时任务 |
|---|---|---|---|---|---|---|
| GenshinUID (v4) | 220 | 41,931 | **478** | 10 | 98 | 19 |
| StarRailUID | 77 | 9,272 | 235 | 1 | 40 | 4 |
| ZZZeroUID | 82 | 9,801 | 198 | 0 | 35 | 6 |
| WzryUID | 24 | 1,573 | 54 | 0 | 8 | 2 |
| **core 本体** | **631** | **153,865** | — | — | — | — |

---

## 4. API 签名清单

### 4.1 `gsuid_core.sv` —— SV / Plugins / SL

**`SV`**（`sv.py:186-197`；文档 `/CodePlugins/Class.html`）

```python
class SV:
    def __new__(cls, *args, **kwargs):   # 同名 SV 是单例，跨文件共享
        ...
    def __init__(
        self,
        name: str = "",
        pm: int = 6,
        priority: int = 5,
        enabled: bool = True,
        area: Literal["GROUP", "DIRECT", "ALL"] = "ALL",
        black_list: List = [],
        white_list: List = [],
    ):
```

| 参数 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `name` | `str` | — | 服务名（同名单例） |
| `pm` | `int` | `6` | 权限阈值：`0`=主人，`1`=超级用户，`2`=群主，`3`=管理员，`6`=普通。判定为 `user_pm > sv.pm → 拒绝` |
| `priority` | `int` | `5` | 越小越先执行 |
| `enabled` | `bool` | `True` | 开关（`SL.lst['x'].disable()/enable()`） |
| `area` | `Literal` | `"ALL"` | 作用范围 |
| `black_list` / `white_list` | `List` | `[]` | 群号/用户 ID |

实例属性/方法：`self.name`、`self.TL: Dict[str, Dict[str, Trigger]]`、`self.plugins: Plugins`、`self.self_plugin_name`、`set(**kwargs)`、`enable()`、`disable()`。

**`SVList` / `SL`**（`sv.py:22-34`）

```python
class SVList:
    def __init__(self):
        self.lst: Dict[str, SV] = {}
        self.plugins: Dict[str, Plugins] = {}
        self.detail_lst: Dict[Plugins, List[SV]] = {}

    @property
    def get_lst(self): return self.lst

SL = SVList()      # 全局服务注册表
```

**`Plugins`**（`sv.py:109-172`）

```python
class Plugins:
    def __init__(
        self,
        name: str = "",
        pm: int = 6,
        priority: int = 5,
        enabled: bool = True,
        area: Literal["GROUP", "DIRECT", "ALL", "SV"] = "SV",
        black_list: List = [],
        white_list: List = [],
        sv: Dict = {},
        prefix: Union[List[str], str] = [],
        force_prefix: List[str] = [],
        disable_force_prefix: bool = False,
        allow_empty_prefix: Optional[bool] = None,
        force: bool = False,
        alias: List[str] = [],
    ):
```

**模块级辅助函数**（`sv.py:1053-1090`）

```python
def get_plugin_prefixs(plugin_name: str) -> List[str]
def get_plugin_prefix(plugin_name: str) -> str
def get_plugin_force_prefixs(plugin_name: str) -> List[str]
def get_plugin_force_prefix(plugin_name: str) -> str
def get_plugin_available_prefix(plugin_name: str) -> str   # 最常用的一个
```

### 4.2 触发器全集（9 种）与精确匹配语义

**签名**（`sv.py:334-500`，`on_*` 全部转发到 `self._on(...)`）

```python
def _on(self, type, keyword, block=False, to_me=False, prefix=True,
        to_ai="", covers=None, aliases=None) -> Callable

def on_fullmatch(self, keyword: Union[str, Tuple[str, ...]], block: bool = False,
                 to_me: bool = False, prefix: bool = True, to_ai: str = "",
                 covers: list[str] | None = None, aliases: list[str] | None = None) -> Callable
def on_prefix    (self, keyword, block=False, to_me=False, prefix=True, to_ai="", covers=None, aliases=None)
def on_suffix    (self, keyword, block=False, to_me=False, prefix=True, to_ai="", covers=None, aliases=None)
def on_keyword   (self, keyword, block=False, to_me=False, prefix=True, to_ai="", covers=None, aliases=None)
def on_command   (self, keyword, block=False, to_me=False, prefix=True, to_ai="", covers=None, aliases=None)
def on_file      (self, file_type: str, block=False, to_me=False, prefix=True, to_ai="", covers=None, aliases=None)
def on_regex     (self, keyword, block=False, to_me=False, prefix=True, to_ai="", covers=None, aliases=None)
def on_message   (self, unique_id: Optional[str] = None, block=False, to_me=False,
                  prefix=True, to_ai="", covers=None, aliases=None)   # unique_id 缺省为 uuid4
def on_meta      (self, event_name: Union[str, Tuple[str, ...]], block: bool = False)
```

> ⚠️ **没有 `on_ai` / `on_button`**。`to_ai` 是「把该触发器注册为 AI 工具」的**字符串 docstring**，不是类型。
> `covers` / `aliases` 目前只透传给 AI 工具注册，不影响文本匹配。

**匹配算法**（`trigger.py:127-311`，这是兼容层最需要逐行复刻的部分）

```python
class Trigger:
    def __init__(self, type, keyword, func, prefix="", block=False, to_me=False):
        self.type = type
        self.prefix = prefix
        self.keyword = keyword
        self.func = func                # async (Bot, Event)
        self.block = block
        self.to_me = to_me
        self._head = prefix + keyword
        self._flex_gap = _needs_flex_gap(keyword)
        self._probe = prefix[:1] if prefix else (keyword[:1] if self._flex_gap else "")
```

判定分支（`raw_text` 为输入）：

| type | 判定 |
|---|---|
| `command` | `msg.startswith(prefix+keyword)`，**无参数也触发**（= fullmatch + prefix） |
| `fullmatch` | `msg == prefix+keyword`（含 CJK/ASCII 边界处空格弹性） |
| `prefix` | `startswith(head)` **且** `len(msg) > len(head)` **且** 下一字符不属于 `_CMD_GAP`，即**必须带参数** |
| `suffix` | 以关键字结尾，且 `rest != suffix`（必须带前缀内容） |
| `keyword` | `keyword in msg`（含 strip 变体） |
| `regex` | `re.findall(pattern, rest)` 非空；`rest` = 去掉插件前缀后的文本 |
| `file` | `ev.file and ev.file_name.split(".")[-1] == file_type` |
| `meta` | `ev.meta_event_type == event_name`（`user_join_group` / `user_exit_group` / `poke`） |
| `message` | **恒为 True**（每条消息都触发） |

`_CMD_GAP = " \t\u3000\u00a0"`（半角/全角空格、Tab、NBSP）。`_is_cjk` / `_script_boundary` 实现了「中英交界处空格可有可无」（`trigger.py:11-21`）——**兼容层必须复刻，否则 `gs查询` / `gs 查询` 行为不一致**。

**前缀展开**（`sv.py:349-390`）：注册时就把 `Plugins.prefix + force_prefix + [""]`（若 `allow_empty_prefix`）展开成 N 个 `Trigger` 副本，`_PREFIXLESS_TYPES = {"file", "meta", "message"}` 不展开前缀。

**`ev.command` / `ev.text` 的填充**（`trigger.py:288-311`）

```python
async def get_command(self, msg: Event) -> Event:
    if self.type != "regex":
        msg.command = self.keyword
        rest = self._after_prefix(msg.raw_text)
        end = _consume_keyword(rest, self.keyword)
        if end is not None:
            msg.text = rest[end:].strip(_CMD_GAP)
        else:
            msg.text = rest.replace(self.keyword, "", 1).strip(_CMD_GAP)
    else:
        rest = self._after_prefix(msg.raw_text)
        command_group = re.search(self.keyword, rest)
        if command_group:
            msg.regex_dict = command_group.groupdict()
            msg.regex_group = command_group.groups()
            msg.command = "|".join([i if i is not None else "" for i in list(msg.regex_group)])
        text_list = re.split(self.keyword, msg.raw_text)
        msg.text = "|".join([i if i is not None else "" for i in text_list])
    return msg
```

### 4.3 分发与鉴权（`gsuid_core/handler.py`）

**入口**：`async def handle_event(ws: _Bot, msg: MessageReceive, is_http: bool = False)`（`handler.py:386`）

流程（`handler.py:390-645`）：

```python
# 0) meta 事件最优先拦截，走独立路径
if _extract_meta_segment(msg) is not None:
    return await handle_meta_event(ws, msg)

# 1) 用户权限（越小越高）
msg.user_pm = user_pm = await get_user_pml(msg)
event = await msg_process(msg)
event.WS_BOT_ID = ws.bot_id

# 2) command_start 前缀剥离（如 "#" / "/"）
# 3) 全局黑名单
valid_event: Dict[Trigger, int] = {}
if msg.group_id not in black_list and msg.user_id not in black_list:
    for _sv_name in SL.lst:
        _sv = SL.lst[_sv_name]
        if not _sv_authorized(_sv, event, user_pm):
            continue
        _priority = _sv.priority
        for _trigger_dict in _sv.TL.values():
            for _trigger in _trigger_dict.values():
                try:
                    if _trigger.check_command(event):
                        valid_event[_trigger] = _priority
                except Exception:
                    logger.exception(...)

# 4) on_message 单独先派发（不记统计、不挂 trace）
message_triggers = {t: p for t, p in valid_event.items() if t.type == "message"}
for trigger in message_triggers:
    _event = deepcopy(event); _event.task_id = str(uuid4())
    bot = Bot(ws, _event); coro = trigger.func(bot, _event)
    ws.queue.put_nowait(TaskContext(coro=coro, name=..., priority=_event.user_pm))

# 5) 命令类触发器按 (not trigger.prefix, sv_priority) 排序后顺序派发
if len(command_triggers) >= 1:
    sorted_event = sorted(command_triggers.items(), key=lambda x: (not x[0].prefix, x[1]))
    for trigger, _ in sorted_event:
        _event = deepcopy(event)
        message = await trigger.get_command(_event)
        _event.task_id = str(uuid4())
        bot = Bot(ws, _event)
        await count_data(event, trigger)
        coro = trigger.func(bot, message)
        ws.queue.put_nowait(TaskContext(coro=coro, name=..., priority=_event.user_pm, trace_context=trace_ctx))
        if _event.task_event:                       # HTTP 模式
            return await ws.wait_task(_event.task_id, _event.task_event)
        if trigger.block:                           # ← block 语义：停止后续触发器
            break
else:
    # 6) 无任何命令触发器命中 → 交给 AI（若启用）
```

**`block=True` 的精确语义**：在按优先级排序的派发循环里 `break`，**阻止同一条消息继续传给后续（更低优先级）触发器**。对 `on_message` 不生效（后者单列循环）。

**鉴权级联**（`handler.py:270-310`，原样复刻）

```python
def _sv_authorized(_sv: SV, event: Event, user_pm: int) -> bool:
    _plugins = _sv.plugins
    if not _plugins.enabled:                                                     return False
    if user_pm > _plugins.pm:                                                    return False
    if event.group_id in _plugins.black_list or event.user_id in _plugins.black_list: return False
    _plugins_area = _plugins.area
    if not (_plugins_area == "SV" or _plugins_area == "ALL"
            or (event.user_type == "group"  and _plugins_area == "GROUP")
            or (event.user_type == "direct" and _plugins_area == "DIRECT")):
        return False
    if _plugins.white_list and _plugins.white_list != [""]:
        if event.user_id not in _plugins.white_list and event.group_id not in _plugins.white_list:
            return False
    if not _sv.enabled:                                                          return False
    if user_pm > _sv.pm:                                                         return False
    if event.group_id in _sv.black_list or event.user_id in _sv.black_list:      return False
    if not (_sv.area == "ALL" or _plugins_area == "ALL"
            or (event.user_type == "group"  and _sv.area == "GROUP")
            or (event.user_type == "direct" and _sv.area == "DIRECT")):
        return False
    if _sv.white_list and _sv.white_list != [""]:
        if event.user_id not in _sv.white_list and event.group_id not in _sv.white_list:
            return False
    return True
```

**权限来源**（`handler.py:768-777`）

```python
async def get_user_pml(msg: MessageReceive) -> int:
    config_masters: List[str] = core_config.get_config("masters")
    config_superusers = core_config.get_config("superusers")
    if msg.user_id in config_masters:        return 0
    elif msg.user_id in config_superusers:   return 1
    else: return msg.user_pm if msg.user_pm >= 1 else 2
```

### 4.4 `gsuid_core.models` —— Event / Message / MessageReceive / MessageSend

来源：`gsuid_core/models.py`（msgspec `Struct`，全字段见下）

```python
class Message(Struct):
    type: Optional[str] = None
    data: Optional[Any] = None


class MessageReceive(Struct):
    bot_id: str = "Bot"
    bot_self_id: str = ""
    msg_id: str = ""
    user_type: Literal["group", "direct", "channel", "sub_channel"] = "group"
    group_id: Optional[str] = None
    user_id: str = ""
    sender: Dict[str, Any] = {}
    user_pm: int = 6
    content: List[Message] = []


class Event(MessageReceive):
    WS_BOT_ID: Optional[str] = None
    task_id: str = ""
    task_event: Optional[asyncio.Event] = None
    real_bot_id: str = ""
    raw_text: str = ""
    command: str = ""
    text: str = ""
    image: Optional[str] = None
    image_list: List[Any] = []
    image_id: Optional[str] = None
    image_id_list: List[str] = []
    audio_id: Optional[str] = None
    audio_id_list: List[str] = []
    video_id: Optional[str] = None
    video_id_list: List[str] = []
    at: Optional[str] = None
    at_list: List[Any] = []
    is_tome: bool = False
    reply: Optional[str] = None
    reply_id: Optional[str] = None
    node: Optional[List[Message]] = None
    file_name: Optional[str] = None
    file: Optional[str] = None
    file_type: Optional[Literal["url", "base64"]] = None
    regex_group: Tuple[str, ...] = ()
    regex_dict: Dict[str, str] = {}
    meta_event_type: Optional[str] = None
    meta_event_data: Dict[str, Any] = {}

    @property
    def session_id(self) -> str:
        """{WS_BOT_ID}:{bot_id}:{bot_self_id}:group:{group_id}
           或 ...:private:{user_id}"""

    def get_meta(self, key: str, default: Any = None) -> Any


class MessageSend(Struct):
    bot_id: str = "Bot"
    bot_self_id: str = ""
    msg_id: str = ""
    target_type: Optional[str] = None
    target_id: Optional[str] = None
    content: Optional[List[Message]] = None
    echo: Optional[str] = None
```

**Event 字段填充顺序**（`handler.py:780-867`，`msg_process`）

```python
event = Event(bot_id, msg.bot_self_id, msg.msg_id, msg.user_type,
              msg.group_id, msg.user_id, msg.sender, msg.user_pm,
              real_bot_id=msg.bot_id)
if msg.user_type == "direct":
    event.is_tome = True
for _msg in msg.content:
    if   _msg.type == "text":      event.raw_text += text; event.text += text
    elif _msg.type == "at":        若 == bot_self_id → is_tome=True
                                   否则 event.at = str(data); at_list.append(...)
    elif _msg.type == "image":     event.image = data; image_list.append(data)
                                   image_id = RM.register(data); image_id_list.append(...)
    elif _msg.type == "record":    audio_id / audio_id_list
    elif _msg.type == "video":     video_id / video_id_list
    elif _msg.type == "reply":     event.reply = data
    elif _msg.type == "reply_id":  event.reply_id = str(data)
    elif _msg.type == "node":      event.node = normalize_node_items(data)
    elif _msg.type == "file":      event.file_name, event.file = data.split("|")
                                   file_type = "url" if file.startswith(("http","https")) else "base64"
    elif _msg.type.startswith("meta-"): meta_event_type = type[5:]; meta_event_data = data
event.content = _content
```

> `bot_id` 处理：`if ":" in msg.bot_id: bot_id = msg.bot_id.split(":")[0]`，而 `real_bot_id = msg.bot_id`（完整值）——**`real_bot_id` 才是平台判定用的键**（按钮/MD 能力表都用它）。

### 4.5 `gsuid_core.bot` —— Bot 对象

`bot.py` 里有两个类：`_Bot`（每 WS 连接一个，管队列/发送）与 `Bot`（每次事件一个，给插件用）。

```python
class Bot:
    instances: Dict[str, "Bot"] = {}          # receive_tag=True 的会话 → Bot（单步会话）
    mutiply_instances: Dict[str, "Bot"] = {}
    mutiply_map: Dict[str, str] = {}

    def __init__(self, bot: _Bot, ev: Event):
        self.uid = ev.user_id or "0"
        self.temp_gid = ev.group_id if ev.user_type != "direct" else self.uid
        self.bid = ev.bot_id or "0"
        self.session_id = f"{self.bid}%%%{self.temp_gid}%%%{self.uid}"
        self.bot = bot            # _Bot 实例
        self.ev = ev              # ← 插件里 ev 就是它
        self.logger = bot.logger  # GsLogger，向 Bot 端推日志
        self.bot_id = ev.bot_id
        self.bot_self_id = ev.bot_self_id
        self.resp: List[Event] = []
        self.receive_tag = False
        self.mutiply_tag = False
        self.mutiply_resp: List[Event] = []
```

**方法签名**（`bot.py`）

```python
async def send(self, message: Union[Message, List[Message], str, bytes, List[str]],
               at_sender: bool = False,
               extra_metadata: Optional[Dict[str, Any]] = None,
               wait_recall: bool = False) -> Optional[List[str]]

async def receive_resp(self, reply=None, option_list: Optional[ButtonType] = None,
                       unsuported_platform: bool = False,
                       is_mutiply: bool = False, is_recive: bool = True,
                       timeout: float = 60, sep: str = "\n",
                       command_tips: str = "请输入以下命令之一:",
                       command_start_text: str = "", at_sender: bool = False) -> Optional[Event]

async def receive_mutiply_resp(self, reply=None, option_list=None,
                               unsuported_platform: bool = False, timeout: float = 60,
                               sep="\n", command_tips="请输入以下命令之一:",
                               command_start_text: str = "")

async def send_option(self, reply=None, option_list=None, unsuported_platform=False,
                      sep="\n", command_tips="请输入以下命令之一:",
                      command_start_text="", at_sender: bool = False)

async def target_send(self, message, target_type: Literal["group","direct","channel","sub_channel"],
                      target_id: Optional[str], at_sender: bool = False,
                      sender_id: str = "", send_source_group: Optional[str] = None,
                      wait_recall: bool = False) -> Optional[List[str]]

async def ban(self, user_id, group_id, duration: int, target_type=None, target_id=None) -> None
async def unsend(self, message_id, target_type=None, target_id=None) -> None
async def wait_for_key(self, timeout: float) -> Optional[Event]
def set_event(self) / def set_mutiply_event(self)
async def get_lang(self) -> str
async def t(self, key: str, /, **params: Any) -> str        # 按用户语言 i18n
```

**`_Bot.target_send` 完整签名**（`bot.py`，`Bot.send` 最终转发到这里）

```python
async def target_send(
    self,
    message: Union[Message, List[Message], List[str], str, bytes],
    target_type: Literal["group", "direct", "channel", "sub_channel"],
    target_id: Optional[str],
    bot_id: str,
    bot_self_id: str,
    msg_id: str = "",
    at_sender: bool = False,
    sender_id: Optional[str] = "",
    group_id: Optional[str] = None,
    task_id: str = "",
    task_event: Optional[asyncio.Event] = None,
    extra_metadata: Optional[Dict[str, Any]] = None,
    wait_recall: bool = False,
) -> Optional[List[str]]:
```

**`call_bot()`**（`bot.py`，任意位置取当前 Bot 实例，靠遍历调用栈）

```python
def call_bot():
    frame = inspect.currentframe()
    while frame:
        args, _, _, values = inspect.getargvalues(frame)
        for arg in args:
            value = values[arg]
            if isinstance(value, Bot):
                return value
        frame = frame.f_back
    raise ValueError(t("[GsCore] 当前Session中未找到可用Bot实例..."))
```

**`Bot.send` 内部行为**（关键，兼容层必须一致）：`target_send` → 记录到 `message_history` → `convert_message()` 归一化 → 若 `bot_id in enable_markdown_platform` 则 `to_markdown()` → 处理 `node`（按 `EnableForwardMessage` 配置拆分/合并）→ `at_sender` 时插入/追加 `MessageSegment.at(sender_id)` → 组装 `MessageSend` → `msgjson.encode` → 串行化 WebSocket 发送队列。

**多步会话语义**（文档 `/CodePlugins/Resp.html`）：

| 方法 | 说明 |
|---|---|
| `bot.send_option(...)` | 发按钮/选项提示，**不等待**回复 |
| `bot.receive_resp(...)` | 发可选消息，等待**触发命令用户**的下一条消息 |
| `bot.receive_mutiply_resp(...)` | 发可选消息，等待**群内任意用户**的后续消息 |

`receive_resp` 靠 `Bot.instances[self.session_id]` 注册，`receive_mutiply_resp` 靠 `mutiply_instances` + `mutiply_map`；`sv.modify_func` 的 wrapper 在 `finally` 里清理这两个表（`sv.py:38-56`）。

### 4.6 `gsuid_core.segment` —— MessageSegment / convert_message / to_markdown

**全部方法签名**（`segment.py:89-264`）

```python
class MessageSegment:
    def __add__(self, other): return [self, other]

    @staticmethod
    def image(img: Union[str, Image.Image, bytes, Path]) -> Message
    @staticmethod
    def text(content: str) -> Message
    @staticmethod
    def buttons(buttons: Optional[Union[List[Button], List[List[Button]]]] = None) -> Message
    @staticmethod
    def template_buttons(template_id: str) -> Message
    @staticmethod
    def markdown(content: str,
                 buttons: Optional[Union[List[Button], List[List[Button]]]] = None) -> List[Message]
    @staticmethod
    def template_markdown(template_id: str, para: Dict[str, str],
                          buttons=None) -> List[Message]
    @staticmethod
    def image_size(size: Tuple[int, int]) -> Message
    @staticmethod
    def at(user: str) -> Message
    @staticmethod
    def node(content_list: Union[List[Message], List[str], List[bytes]]) -> Message
    @staticmethod
    def record(content: Union[str, bytes, Path]) -> Message
    @staticmethod
    def file(content: Union[Path, str, bytes], file_name: str) -> Message
    @staticmethod
    def video(content: Union[str, bytes, Path]) -> Message
    @staticmethod
    def log(type: Literal["INFO", "WARNING", "ERROR", "SUCCESS"], content: str) -> Message
```

**`data` 的确切形状**

| type | data |
|---|---|
| `text` | `str` |
| `image` | `"base64://<b64>"` ；URL 输入 → `"link://<url>"`；`file://...` 原样透传 |
| `image_size` | `Tuple[int, int]` |
| `at` | `str`(user id) |
| `buttons` | `List[Button]` 或 `List[List[Button]]`，经 `msgspec.to_builtins` 序列化 |
| `template_buttons` | `str`(template_id) |
| `markdown` | `str`（返回 `List[Message]`，第二元素可选 buttons） |
| `template_markdown` | `{"template_id": str, "para": Dict[str,str]}` |
| `node` | `List[Message]`（不允许嵌套 node） |
| `record` / `video` | `"base64://<b64>"` |
| `file` | `f"{file_name}\|{b64}"` 或 `f"{file_name}\|link://{url}"` |
| `log_INFO/WARNING/ERROR/SUCCESS` | `str`（仅存在于 `MessageSend`） |

`MessageSegment.image` 原码（`segment.py:93-124`）明确处理了 5 种输入：`Image.Image` → PNG bytes → base64；`bytes`；`Path`；`str`（http / `file://` / `base64://` / 本地路径）。

**`convert_message` / `to_markdown` / `markdown_to_template_markdown`**

```python
async def convert_message(message: Union[Message, str, bytes], bot_id, bot_self_id) -> List[Message]   # segment.py:401
async def markdown_to_template_markdown(...)                                                           # segment.py:423
async def to_markdown(...)                                                                             # segment.py:483
async def check_same_buttons(a: List[Button], b: List[Button]) -> bool                                 # segment.py:534
def process_buttons(buttons: ButtonList) -> ButtonList                                                 # segment.py:59
```

**`Button`**（`message_models.py` 全文）

```python
class Button(Struct):
    text: str
    data: str                                                   # 具体数据
    pressed_text: Optional[str] = None                          # 按下之后显示的值
    style: Literal[0, 1] = 1                                    # 0灰色线框, 1蓝色线框
    action: Literal[-1, 0, 1, 2] = -1                           # 0跳转, 1回调, 2命令, -1自适应
    permisson: Literal[0, 1, 2, 3] = 2                          # 0指定用户,1管理者,2所有人,3指定身份组
    specify_role_ids: List[str] = []                            # 仅限频道可用
    specify_user_ids: List[str] = []                            # 指定用户
    unsupport_tips: str = "您的客户端暂不支持该功能, 请升级后适配..."
    prefix: str = ""                                            # 命令前缀，继承重写
    _edited: bool = False                                       # 是否编辑过

ButtonType = Union[List[str], List[T], List[List[str]], List[List[T]]]
ButtonList = Union[List[T], List[List[T]]]
```

> 注意拼写：字段名是 **`permisson`**（少一个 i），兼容层必须照抄。

**平台能力开关**（`bot.py` 顶部，来自 `bm_config`）

```python
button_row_num: int = bm_config.get_config("ButtonRow").data
ism: List = bm_config.get_config("SendMDPlatform").data
isb: List = bm_config.get_config("SendButtonsPlatform").data
isc: List = bm_config.get_config("SendTemplatePlatform").data
istry: List = bm_config.get_config("TryTemplateForQQ").data
enable_forward: str = sp_config.get_config("EnableForwardMessage").data
command_semaphore: int = sp_config.get_config("CommandSemaphore").data
```

`EnableForwardMessage` 取值：`"禁止(不发送任何消息)"` / `"允许"` / `"全部拆成单独消息"` / `"合并为一条消息"` / 数字字符串（前 N 条）——见 `bot.py` 中 `target_send` 的 `node` 处理分支。

### 4.7 图片工具（**纯 JS 的最大障碍**）

```python
# gsuid_core/utils/image/convert.py
async def convert_img(img: Image.Image, is_base64: bool = False) -> bytes   # overload
async def convert_img(img: Image.Image, is_base64: bool = True)  -> str
async def convert_img(img: bytes,       is_base64: bool = False) -> str
async def convert_img(img: Path,        is_base64: bool = False) -> str
```

```python
# gsuid_core/utils/image/image_tools.py（签名实测）
def image_to_base64(image: ImageInput) -> str
async def change_ev_image_to_bytes(img) -> bytes
def tint_image(input_image: Image.Image, color: Tuple[int,int,int])
def get_font_x(font: ImageFont.FreeTypeFont, text: str)
def get_div()
def draw_color_badge(...)
def get_status_icon(status) -> Image.Image
def get_v4_footer() / def add_footer(...) / def get_v4_bg(w, h, is_dark=False, is_blur=False)
async def get_event_avatar(ev: Event, avatar_path: Optional[Path] = None) -> Image.Image
async def get_avatar_with_ring(...)
async def shift_image_hue(img: Image.Image, angle: float = 30) -> Image.Image
async def get_pic(url, size: Optional[Tuple[int,int]] = None) -> Image.Image
def draw_center_text_by_line(...) / def draw_text_by_line(...)
def easy_paste(im, im_paste, pos=(0,0), direction="lt")
def easy_alpha_composite(im, im_paste, pos=(0,0), direction="lt") -> Image.Image
async def get_qq_avatar(...) / async def get_qqgroup_avatar(...)
async def draw_pic_with_ring(...)
def crop_center_img(img: Image.Image, based_w: int, based_h: int) -> Image.Image
async def get_color_bg(...)
class CustomizeImage: ...
```

```python
# gsuid_core/utils/fonts/fonts.py
core_font(...)          # 字体对象，绘图用

# gsuid_core/utils/html_render
async def render_html_to_bytes(...)
def _ensure_renderer(...)
```

**结论**：这些 API 全部返回/接收 PIL `Image.Image`。Node 侧无法在进程内提供 PIL 对象；只能 (a) 保留 Python 执行这些模块，(b) 通过 RPC 把 PIL 对象留在 Python 侧、只把 bytes 过界，或 (c) 放弃这类插件。

### 4.8 配置 API

```python
# gsuid_core/utils/plugins_config/models.py（全部 GsConfig 类型，实测）
class GsConfig(msgspec.Struct, tag=True):
    title: str
    desc: str

GsStrConfig(GsConfig, tag=True):        data: str; options: List[str] = []; regex: Optional[str]=None; details: Optional[dict]=None; secret: bool=False
GsBoolConfig(GsConfig, tag=True):       data: bool; secret: bool=False
GsDictConfig(GsConfig, tag=True):       data: Dict[str, List]; secret: bool=False
GsListStrConfig(GsConfig, tag=True):    data: List[str]; options: List[str]=[]; secret: bool=False
GsListConfig(GsConfig, tag=True):       data: List[int]; secret: bool=False
GsIntConfig(GsConfig, tag=True):        data: int; max_value: Optional[int]=None; options: List[int]=[]; secret: bool=False
GsFloatConfig(GsConfig, tag=True):      data: float; min_value/max_value: Optional[float]; secret: bool=False
GsImageConfig(GsConfig, tag=True):      data: str; upload_to: str; filename: str; suffix: str="jpg"; secret: bool=False
GsTimeRConfig(GsConfig, tag=True):      data: Tuple[int, int]; secret: bool=False
GsDivider(GsConfig, tag=True):          data: Optional[str]=None
GsFileUploadConfig(GsConfig, tag=True): data: str; upload_to: str; filename: str; suffix: str="html"; secret: bool=False
GsFilesUploadConfig(GsConfig, tag=True):data: str; suffix: str="html"; secret: bool=False
GsDateConfig(GsConfig, tag=True):       data: datetime.date; secret: bool=False
GsTimeRangeConfig(GsConfig, tag=True):  data: Tuple[Tuple[int,int], Tuple[int,int]]; secret: bool=False
GsColorConfig(GsConfig, tag=True):      data: str
GsRepeatGroupConfig(GsConfig, tag=True):data: List[Dict[str,"GSC"]]; template: Dict[str,"GSC"]; secret: bool=False
GsTimeConfig(GsConfig, tag=True):       data: str; secret: bool=False

GSC = Union[...]
```

> 注意：`GsDivider` / `GsFloatConfig` / `GsFileUploadConfig` / `GsFilesUploadConfig` / `GsDateConfig` / `GsTimeRangeConfig` / `GsColorConfig` / `GsRepeatGroupConfig` / `GsTimeConfig` **在文档里没有**，只有源码有。文档只列了 8 种。

```python
# gsuid_core/utils/plugins_config/gs_config.py:104-174
class StringConfig:
    def __new__(cls, *args, **kwargs):        # 同名配置是单例（all_config_list）
    def __init__(self, config_name: str,
                 CONFIG_PATH: Union[Path, List[Path]],
                 config_list: Dict[str, GSC]) -> None:
    def __len__(self) / __iter__(self) / __getitem__(self, key) -> GSC
    def get_raw_config(self) -> Dict
    def sort_config(self)
    def write_config(self)
    def repair_config(self)
    def update_config(self)
    def get_config(self, key: str, default_value: Any = None) -> Any
    def set_config(self, key: str, value: Union[str, List, bool, Dict, int]) -> bool
    def migrate_from(self, old_configs) -> ...

class ConfigSetManager(ABC):
    def get_config(self, config_name: str) -> StringConfig
    def list_available(self) -> List[str]
    def get_all_configs(self) -> Dict[str, StringConfig]
    def exists(self, config_name: str) -> bool
    def create_default(self, config_name: str) -> bool
    def delete(self, config_name: str) -> bool
    def clear_cache(self) -> None
    def _get_config_path(self, config_name: str) -> Path
    def _create_string_config(self, config_name: str) -> StringConfig
```

插件侧用法（文档 + 实测）：

```python
# 声明（插件开发者）
from gsuid_core.utils.plugins_config.models import GSC, GsStrConfig, GsBoolConfig, GsListStrConfig
from gsuid_core.data_store import get_res_path
from gsuid_core.utils.plugins_config.gs_config import StringConfig

CONIFG_DEFAULT: Dict[str, GSC] = {
    'SignTime': GsListStrConfig('每晚签到时间设置', '每晚米游社签到时间设置（时，分）', ['0', '38']),
    'SignReportSimple': GsBoolConfig('简洁签到报告', '开启后可以大大减少每日签到报告字数', True),
}
CONFIG_PATH = get_res_path() / 'StarRailUID' / 'config.json'
srconfig = StringConfig('StarRailUID', CONFIG_PATH, CONIFG_DEFAULT)

# 读取
SignTime: List[str] = srconfig.get_config('SignTime').data
```

### 4.9 数据库 API

三级基类（`utils/database/base_models.py`，实测行号）：

```python
class BaseIDModel(SQLModel):            # line 598
    id: int = Field(default=None, primary_key=True, title="序号")

class BaseBotIDModel(BaseIDModel):      # line 892
    bot_id: str = Field(title="平台")

class BaseModel(BaseBotIDModel):        # line 1039
    user_id: str = Field(title="账号")

class Bind(BaseModel):                  # line 1227
    group_id: Optional[str] = Field(title="群号")

class User(BaseModel):                  # line 1596
    cookie: str = Field(default=None, title="Cookie")
    stoken: Optional[str] = Field(default=None, title="Stoken")
    status: Optional[str] = Field(default=None, title="状态")
    push_switch: str = Field(default="off", title="全局推送开关")
    sign_switch: str = Field(default="off", title="自动签到")

class Cache(BaseIDModel):               # line 1997
    cookie: str = Field(default=None, title="Cookie")

class Push(BaseBotIDModel):             # line 2069
    ...
```

装饰器：`with_session` / `with_read_session`（`base_models.py:439-548`）。文档 `/CodePlugins/PluginsDataBase.html` 原文规则：

> - **必须是 `classmethod`** 且 **`async def`**
> - `session: AsyncSession` 必须是第二个参数（紧跟 `cls`）
> - 装饰器自动 commit，异常自动回滚
> - **不要**在方法内手动 `await session.commit()`

**方法清单（实测行号，节选最常用）**

`BaseIDModel`：`get_distinct_list`(603)、`batch_insert_data`(613)、`batch_insert_data_with_update`(633)、`update_data_by_data`(690)、`get_gameid_name`(731)、`full_insert_data`(775)、`delete_row`(798)、`select_rows`(819)、`base_select_data`(853)、`data_exist`(875)

`BaseBotIDModel`：`update_data_by_uid_without_bot_id`(897)、`update_data_by_xx`(936)、`update_data_by_uid`(974)、`get_all_data`(1030)

`BaseModel`：`select_data_list`(1048)、`select_data`(1083)、`insert_data`(1113)、`delete_data`(1156)、`update_data`(1188)

`Bind`：`get_uid_list_by_game`(1234)、`get_uid_by_game`(1279)、`bind_exists`(1314)、**`insert_uid`(1325)**、`delete_uid`(1411)、`get_all_uid_list_by_game`(1470)、`switch_uid_by_game`(1508)、`get_bind_group_list`(1576)、`get_bind_group`(1582)、`get_group_all_uid`(1589)

`User`：`select_data_by_uid`(1605)、`get_user_all_data_by_user_id`(1638)、`get_user_attr`(1661)、`get_user_attr_by_uid`(1694)、`get_user_attr_by_user_id`(1708)、`mark_invalid`(1722)、`get_user_cookie_by_uid`(1732)、`get_user_stoken_by_uid`(1748)、`cookie_validate`(1764)、`get_switch_open_list`(1777)、`get_all_user`(1809)、`get_all_cookie`(1842)、`get_all_push_user_list`(1863)、`get_all_sign_user_list`(1869)、`user_exists`(1897)、`get_random_cookie`(1904)、`delete_user_data_by_uid`(1985)

`Cache`：`select_cache_cookie`(2002)、`delete_error_cache`(2016)、`delete_all_cache`(2033)、`refresh_cache`(2055)、`insert_cache_data`(2062)

**框架级模型**（`utils/database/models.py`，插件最常 import 的）：

```python
from gsuid_core.utils.database.models import GsBind, GsUser, CoreUser, CoreGroup, Subscribe
```

`GsBind` / `GsUser` 是「游戏绑定 / 游戏账号」的框架默认表（各插件共用一张表，靠 `bot_id` 区分）。`CoreUser` / `CoreGroup` 是核心用户/群表。
`from gsuid_core.utils.database.api import get_uid`（15 次引用）——游戏插件取当前用户 UID 的标准入口。

**自定义表示例**（WzryUID 真实源码 `WzryUID/utils/database/models.py`，文档同款）

```python
from typing import Optional
from sqlmodel import Field
from gsuid_core.utils.database.base_models import Bind, User


class WzryBind(Bind, table=True):
    uid: Optional[str] = Field(default=None, title='王者荣耀UID')


class WzryUser(User, table=True):
    uid: Optional[str] = Field(default=None, title='王者荣耀UID')
```

用法：

```python
await WzryBind.insert_uid(qid, ev.bot_id, uid, ev.group_id)
```

### 4.10 定时任务 / 订阅 / 启动钩子 / 其它

**调度器**（`gsuid_core/aps.py`）

```python
from apscheduler.schedulers.asyncio import AsyncIOScheduler

executor = ThreadPoolExecutor(max_workers=10)
job_defaults = {"misfire_grace_time": misfire_grace_time, "coalesce": True}
options = {"executor": executor, "job_defaults": job_defaults, "timezone": "Asia/Shanghai"}

class _GsScheduler(AsyncIOScheduler):
    def scheduled_job(self, *args, **kwargs):
        kwargs.pop("replace_existing", None)      # 强制禁止 replace_existing
        return super().scheduled_job(*args, **kwargs)

scheduler = _GsScheduler()
scheduler.configure(options)

async def start_scheduler() / async def shutdown_scheduler()
def remove_repeat_job()
def get_all_aps_job() -> List[Job]
def _get_trigger_description(trigger: Any) -> str
async def add_scheduled_job(...)
```

插件用法（文档 `/CodePlugins/Scheduler.html`）：

```python
from gsuid_core.aps import scheduler
from gsuid_core.gss import gss

@scheduler.scheduled_job('cron', minute='*/30')
async def notice_job():
    for BOT_ID in gss.active_bot:
        bot = gss.active_bot[BOT_ID]
        await bot.target_send(msg, 'direct', target_id, bot_id, '', '', False, '')
```

**注意**：job store 是**内存**（无持久化配置），进程重启后定时任务靠模块重新 import 时重新注册。

**订阅**（`gsuid_core/subscribe.py`）

```python
class GsCoreSubscribe:
    async def add_subscribe(self, subscribe_type: Literal['session','single'],
                            task_name: str, event: Event,
                            extra_message: Optional[str] = None) -> ...
    async def get_subscribe(self, task_name: str) -> ...
    async def delete_subscribe(self, subscribe_type, task_name: str, event: Event) -> ...
    async def update_subscribe_message(...)
    async def update_subscribe_data(...)
    async def muti_task(...)

gs_subscribe = GsCoreSubscribe()
```

订阅类型：`"session"` 同群/私聊只保留一条；`"single"` 同群可多条。返回对象的 `sub.send(msg)` 自动识别平台/Bot/目标会话；`sub.extra_message` 读附加信息。

**启动钩子**（`gsuid_core/server.py:162-270`）

```python
from gsuid_core.server import on_core_start, on_core_start_before, on_core_shutdown

@on_core_start_before                       # WS 启动前阻塞执行
async def h(): ...

@on_core_start_before(priority=5)           # 数字越小越先执行
async def h2(): ...

@on_core_start                              # WS 启动后后台异步
async def h3(): ...
```

启动顺序（文档 `/CodePlugins/Start.html` 原文）：

```
main()
  ├── init_database()
  ├── load_gss()                          # 插件加载（注册钩子，不执行）
  ├── uvicorn.Server.serve()              # WS 服务启动
  └── lifespan:
        ├── await core_start_before_execute()
        ├── asyncio.create_task(core_start_execute())
        ├── _setup_frontend()
        ├── start_scheduler()
        └── yield
```

**资源目录**（`gsuid_core/data_store.py`）

```python
def get_res_path(_path: Optional[Union[str, List[str], Path]] = None) -> Path
    # None → data/；str → data/<str>/；List[str] → data/a/b/；Path → 原样使用
    # 路径不存在会自动 mkdir(parents=True)

core_path = Path(__file__).parent
gs_data_path = Path(__file__).parents[1] / "data"
RES = get_res_path()
PLUGINS_CONFIGS_PATH = get_res_path("plugins_configs")
CONFIGS_PATH = get_res_path("configs")
```

**日志 / i18n / 错误 / 缓存 / 线程池**

```python
# gsuid_core/logger.py
from gsuid_core.logger import logger        # loguru 风格：logger.info/debug/trace/success/error/exception/warning

# gsuid_core/i18n.py:318
def t(key: str, /, lang: Optional[str] = None, **params: object) -> str
# 缺 key 回落 key 本身；插件词条来自 plugins/<Name>/locales/，import 前自动摄入

# gsuid_core/utils/error_reply.py
UID_HINT / MYS_HINT / CK_HINT / CHAR_HINT / VERIFY_HINT / SK_HINT / UPDATE_HINT
ERROR_CODE: Dict[...]
async def get_error(retcode: int, game_name: str = "", ...) -> str      # 实测存在
async def get_error_img(retcode: int, ...) -> bytes / Image

# gsuid_core/utils/cache.py
CACHE: Dict[float, Dict[str, Union[Path, str]]] = {}
def wrapper(func)                      # 缓存装饰器
# 另导出 gs_cache

# gsuid_core/pool.py
def to_thread(func)                    # 线程池执行同步函数
# ThreadPoolExecutor / ProcessPoolExecutor 已配置

# gsuid_core/status/plugin_status.py
def register_status(...)               # 往网页控制台注册状态项

# gsuid_core/utils/message.py
async def send_msg_to_master(msg, ...) # 给主人发消息
async def send_diff_msg(...)

# gsuid_core/gss.py（全文）
from gsuid_core.aps import remove_repeat_job
from gsuid_core.server import GsServer
gss = GsServer()

async def load_gss(dev_mode: bool = False):
    if not gss.is_load:
        gss.is_load = True
        await gss.load_plugins(dev_mode)
        remove_repeat_job()
```

`GsServer`（`server.py:284-300`，单例）持有 `active_ws: Dict[str, WebSocket]`、`active_bot: Dict[str, _Bot]`。

**帮助系统**（`help/utils.py` 全文关键部分）

```python
from gsuid_core.help.utils import register_help
def register_help(name: str, help: str, icon: Optional[Image.Image] = None)
# name=插件名, help=帮助命令关键字, icon=PIL Image（缺省用 core ICON.png）

from gsuid_core.help.model import PluginHelp      # TypedDict
class PluginSV(TypedDict):
    name: str; desc: str; eg: str; highlight: int
    need_ck: bool; need_sk: bool; need_admin: bool
class PluginHelp(TypedDict):
    desc: str
    data: List[PluginSV]

from gsuid_core.help.draw_new_plugin_help import get_new_help
from gsuid_core.help.draw_plugin_help import get_help
from gsuid_core.help.draw_core_help import draw_core_help
```

**网页控制台挂载**（`webconsole/mount_app.py`）

```python
from gsuid_core.webconsole import site
from gsuid_core.webconsole.mount_app import PageSchema, GsAdminModel, site

@site.register_admin                              # 必须携带，否则无需管理员也能看到并改表
class WzryBindadmin(GsAdminModel):
    pk_name = 'id'
    page_schema = PageSchema(label='王者绑定管理', icon='fa fa-users')
    model = WzryBind

from gsuid_core.webconsole.plugin_page import register_plugin_page
```

### 4.11 AI Core 相关（`to_ai` / `ai_return`）

```python
from gsuid_core.ai_core.trigger_bridge import ai_return     # 25 次引用，最常用的 AI 接口

@sv.on_command("个股", to_ai="""
查询指定股票或ETF的K线图或分时图。
当用户询问某只股票/ETF走势时调用。

Args:
    text: 股票名称或代码，可加前缀 "日k"/"周k"/"月k"，多个以空格分隔
""")
async def send_stock_img(bot: Bot, ev: Event):
    ai_return("错误：未提供股票代码")     # 普通用户触发时静默；AI 调用时作为工具返回值
    ...
```

其它：`from gsuid_core.ai_core.register import ai_tools, ai_alias, ai_entity`、`from gsuid_core.ai_core.gs_agent import create_agent`、`from gsuid_core.ai_core.models import ToolContext`、`from gsuid_core.ai_core.rag import query_knowledge`。

---

## 5. 适配器 ↔ Core 的 WebSocket 协议

来源：<https://docs.sayu-bot.com/CodeAdapter/Protocol.html>、`/CodeAdapter/Pack.html`、`gsuid_core/models.py`、`gsuid_core/bot.py`

- 连接：`ws://<core>/ws/{bot_id}`。
- ⚠️ **勘误（源码为准）**：文档 `/CodeAdapter/Protocol.html` 说「text 类型的 UTF-8 JSON」，但**源码用的是 binary 帧**：
  ```python
  # gsuid_core/core.py:117,162-163
  @app.websocket("/ws/{bot_id}")
  ...
  data = await asyncio.wait_for(websocket.receive_bytes(), timeout=1.0)
  msg = msgjson.decode(data, type=MessageReceive)
  ```
  发送侧同样是二进制：`body = msgjson.encode(send)` → `await self.bot.send_bytes(body)`（`bot.py:506,512`；`gs_logger.py:25`）。
  **兼容层必须用二进制帧发 JSON 字节**（gsuid_core 自带的适配器示例也确认了这点：`.agents/skills/gscore-adapter-development/references/01-protocol-overview.md:25-41` 明确说明协议文档的 "text frame" 描述是错的）。
- 鉴权：路由参数 `bot_id` 是**连接/路由 ID**（会写入 `Event.WS_BOT_ID`）。`core.py:118-151`：被封 IP → close 1008；`TRUSTED_IPS`（默认 `["localhost","::1","127.0.0.1"]`）跳过 token；否则 `WS_TOKEN` 必须非空且 `secrets.compare_digest(token, WS_SECRET_TOKEN)` 通过，失败 close 1008。适配器示例连接串：`ws://{IP}:{PORT}/ws/Nonebot?token={WS_TOKEN}`（`client.py:27`），`max_size=2**25, open_timeout=30`。
- 上报：适配器 → core 发 **`MessageReceive`**。
- 下发：core → 适配器发 **`MessageSend`**。
- 入站并发限流：每个连接 `asyncio.Semaphore(_INBOUND_SLOTS)`，`_INBOUND_SLOTS = 32`、`_INBOUND_SLOT_WAIT_S = 1.0`、`_INBOUND_BUDGET_S = 30.0`（`handler.py:38-40`）；拿不到槽位或超 30s **只丢这一条消息**（`handler.py:69-93`）。

**`Message` 段类型全集**（文档 + 源码）：

```
text, markdown, template_markdown, buttons, template_buttons, image, image_size,
file, at, reply, reply_id, record, video, node,
log_INFO, log_WARNING, log_ERROR, log_SUCCESS,
meta-user_join_group, meta-user_exit_group, meta-poke,
excute_ban_user, excute_delete_message, recall_message_id, group
```

`data` 形状见 §4.6；文档补充：

- `text` / `markdown` → `str`
- `buttons` → `Button[]` 或 `List[Button]`（按行）
- `image`：
  - `MessageReceive` 中一般是 url 字符串
  - `MessageSend` 中为 `base64://...`；若以 `link://` 开头则为 url
- `file` → `"{文件名}|{文件base64}"`
- `node` → `Message[]`（不允许嵌套 node）
- `reply` → 消息 id；`at` → 被提及人 id
- `video` / `record` → `"base64://{b64}"`

**`user_pm` 映射建议**（文档原文）：

| 场景 | 值 |
|---|---|
| master | `0`（core 侧 `get_user_pml` 决定，来自 `config.json` 的 `masters`） |
| superuser | `1`（来自 `superusers`） |
| 群主 | `2` |
| 群管理员 | `3` |
| 普通群员 | `6` |
| direct 非超管 | `6` |

频道：频道主 `2`，当前频道主 `3`，频道管理员 `4`，当前频道管理员 `5`，普通成员 `6`。
无强关联平台（如 Koishi）：最高 `1`，普通 `6`。

---

## 6. 配置系统：用户如何改配置

三个层次，**没有 `plugins.toml`**：

| 层 | 文件 | 谁写 | 内容 |
|---|---|---|---|
| Core 配置 | `data/config.json`（`config.py:13 CONFIG_PATH = get_res_path() / "config.json"`） | 框架 + 网页控制台 | `masters`、`superusers`、`sv`（旧全局 SV 表）、`misfire_grace_time` 等 |
| **插件框架级配置** | **`data/plugins_configs/<PluginName>.json`** | 框架首次启动时写，用户/网页控制台改 | `name, pm, priority, enabled, area, black_list, white_list, prefix, force_prefix, disable_force_prefix, allow_empty_prefix, alias, sv{...}` |
| 插件自定义配置 | `data/<PluginName>/config.json`（插件自己用 `StringConfig` 指定路径） | 插件开发者声明默认值，用户改 | 插件业务参数（如 `SignTime`） |

`PluginConfigStore` 源码注释（`config.py:268-273`）原文：

> 每个插件的配置存储为 `data/plugins_configs/<plugin_name>.json`，替代原先 `config.json["plugins"]` 的大字典模式。

```python
class PluginConfigStore:
    def get_all(self) -> Dict[str, dict]
    def get(self, plugin_name: str) -> dict
    def set(self, plugin_name: str, data: dict) -> None
    def mark_dirty(self, plugin_name: str) -> None      # 懒写
    def save(self, plugin_name: str) -> None
    def save_dirty(self) -> None
    def save_all(self) -> None
    def _migrate_from_config(self) -> None              # 旧 config.json["plugins"] 迁移 + 备份 config_backup.json

plugin_config_store: PluginConfigStore = PluginConfigStore()
```

`config.py:122 plugins_sample` 是**新插件的默认模板**（`Plugins(...)` 的初值来源）。`Plugins.set()` / `SV.set()` 会把值写进该插件 JSON 并 `mark_dirty`。

**重要行为**（文档 `/CodePlugins/PluginsPrefix.html` 警告原文）：

> `Plugins` 类中的大多数参数将会在首次启动后写入 `data/plugins_configs/<plugin_name>.json`……之后如果你再次修改该值，则**只会影响**首次安装你插件的用户，已安装用户更新插件之后**不会有任何变化**。

配置的读写走 `StringConfig`（§4.8）与 `core_config`：

```python
class CoreConfig:  # config.py
    def get_config(self, key: str) -> Union[str, Dict, List, int, bool]
    def set_config(self, key: str, value) -> bool
    def lazy_write_config(self) / def lazy_set_config(self, key, value)
```

---

## 7. 定时任务 / 数据库 / Web 服务接入

### 7.1 定时任务

见 §4.10。触发方式（文档）：

| 触发 | 示例 |
|---|---|
| `cron` | `@scheduler.scheduled_job('cron', hour=8, minute=30)` |
| `interval` | `@scheduler.scheduled_job('interval', minutes=30)` |
| `date` | `scheduler.add_job(func, trigger='date', run_date=...)` |

`_GsScheduler.scheduled_job` 会 `kwargs.pop("replace_existing", None)`——**热重载时避免 `ConflictingIdError`**（`server.py:457-462` 注释说明了同一原因：已在 `sys.modules` 的模块不重复 exec，防止 `scheduler.add_job` 重复执行）。

### 7.2 数据库

- ORM：**SQLModel**（`SQLModel` 基类）+ **SQLAlchemy async**（`AsyncSession`）。
- 表创建：任务开始前 `init_database()`（启动流程第 1 步）；不是 alembic 迁移——插件升级用 `@on_core_start_before` 自行 `ALTER TABLE`（文档推荐）。
- DB 文件：`data/` 下（`GsData.db`，见文档标题「插件获取/调用/建立数据库(GsData.db)」）。
- 写超时保护：`DatabaseWriteTimeout`（`base_models.py:313`）、`_SqliteDriverLease`（`:317`）、`_WriteBinding`（`:90`）。
- 写方法必须 `@with_session`；读可用 `@with_read_session`。
- 网页控制台映射用 `@site.register_admin` + `GsAdminModel`（§4.10）。

### 7.3 Web 服务 / API

- Core 本体是 **FastAPI + uvicorn**；WS 路由 `/ws/{bot_id}`；另有 HTTP `/api`（`http_agent`：`/api/send_msg`、SSE streaming agent 接口等）。
- 插件注册自定义 HTTP 路由：`from gsuid_core.webconsole.plugin_page import register_plugin_page`。
- 插件注册管理页/数据表：`from gsuid_core.webconsole.mount_app import PageSchema, GsAdminModel, site` + `@site.register_admin`。
- 插件注册状态项：`from gsuid_core.status.plugin_status import register_status`。
- HTTP 模式下 `_event.task_event = asyncio.Event()`，`bot.send` 不再走 WS 而是写入 `send_dict`，由 `wait_task` 取回 `MessageSend`（`bot.py` `target_send` 的 `if task_event:` 分支）。**注意**：HTTP 模式不支持 `ban` / `unsend` / `wait_recall`。

---

## 8. 生态规模

### 8.1 核心

| 项目 | Star | Fork | 默认分支 | 最近推送 |
|---|---|---|---|---|
| [Genshin-bots/gsuid_core](https://github.com/Genshin-bots/gsuid_core) | **355** | 51 | `master` | 2026-09-23 |
| [Genshin-bots/GenshinUID-docs](https://github.com/Genshin-bots/GenshinUID-docs)（文档源） | 3 | 20 | `vp` | 2026-09-13 |

（作者：早苗 / KimigaiiWuyi；仓库早期在 `KimigaiiWuyi/GsCore`，已迁移到组织 `Genshin-bots`。`https://github.com/KimigaiiWuyi/GsCore` 现返回 404。）

### 8.2 主要插件（GitHub Star，2026-09 实测）

| 插件 | Star | Fork | 分支 | 最近推送 | 说明 |
|---|---|---|---|---|---|
| [KimigaiiWuyi/GenshinUID](https://github.com/KimigaiiWuyi/GenshinUID) | **866** | 108 | `v4` | 2026-09-23 | 全功能原神，生态旗舰 |
| [ZZZure/ZZZeroUID](https://github.com/ZZZure/ZZZeroUID) | **120** | 14 | `master` | 2026-09-20 | 绝区零 |
| [KimigaiiWuyi/SayuStock](https://github.com/KimigaiiWuyi/SayuStock) | **77** | 15 | `main` | 2026-09-17 | 股票（依赖 playwright） |
| [baiqwerdvd/StarRailUID](https://github.com/baiqwerdvd/StarRailUID) | 53 | 17 | `master` | 2026-09-24 | 星穹铁道 |
| [Agnes4m/DeltaUID](https://github.com/Agnes4m/DeltaUID) | 29 | 9 | `main` | 2026-09-07 | 三角洲 |
| [KimigaiiWuyi/WzryUID](https://github.com/KimigaiiWuyi/WzryUID) | 26 | 4 | `main` | 2026-09-07 | 王者荣耀 |
| [KimigaiiWuyi/BlueArchiveUID](https://github.com/KimigaiiWuyi/BlueArchiveUID) | 22 | 3 | `main` | 2026-08-23 | 蔚蓝档案 |
| [Agnes4m/CS2UID](https://github.com/Agnes4m/CS2UID) | 20 | 1 | `main` | 2026-09-07 | CS2 |
| [KimigaiiWuyi/MajsoulUID](https://github.com/KimigaiiWuyi/MajsoulUID) | 19 | 4 | `main` | 2026-09-07 | 雀魂 |
| [KimigaiiWuyi/LOLegendsUID](https://github.com/KimigaiiWuyi/LOLegendsUID) | 18 | 5 | `main` | 2026-09-07 | 英雄联盟 |
| [baiqwerdvd/ArknightsUID](https://github.com/baiqwerdvd/ArknightsUID) | 12 | 0 | `main` | 2026-05-21 | 明日方舟（WIP） |
| [Agnes4m/VAUID](https://github.com/Agnes4m/VAUID) | 7 | 1 | `main` | 2026-09-07 | 无畏契约 |

### 8.3 官方插件索引

`https://docs.sayu-bot.com/plugin_list.json` — 顶层键：`plugins` / `fun_plugins` / `tool_plugins` / `extra`；`plugins` 下 **40 个条目**。

条目 schema（实测原文，例如）：

```json
{
  "GenshinUID": {
    "link": "https://github.com/KimigaiiWuyi/GenshinUID",
    "avatar": "https://github.com/KimigaiiWuyi.png",
    "cover": "https://s2.loli.net/2023/03/25/bareSdYcsmRPOyZ.png",
    "branch": "main",
    "type": "tip",
    "content": "普通",
    "info": "全功能原神插件",
    "installMsg": "",
    "alias": ["gsuid", "gs", "原神"]
  }
}
```

`type` ∈ `tip`（普通）/ `danger`（危险，如 `mys_qrlogin`）/ 停止维护。
`alias` 数组就是用户敲的插件别名（`core安装插件<alias>`）。

### 8.4 适配器生态（说明 Node 侧接入是被官方支持的）

文档 `/LinkBots/AdapterList.html` 与 `/LinkBots/NoneBot2.html` 列出：**NoneBot2、HoshinoBot、yunzai-bot、Koishi、ZeroBot** 等；平台：QQ、QQ频道、微信、TG、KOOK、飞书、QQ群官方机器人、Red 协议等。
`gsuid_core/.agents/skills/gscore-adapter-development/` 下有 12 篇适配器开发参考资料（含完整示例 `09-full-adapter-example.md`）——**写 Node 适配器时这是最直接的一手材料**。

---

## 9. 要让它在 Node.js 那边跑起来必须提供什么

### 9.1 分档看「必须提供什么」

**第一档：Node 只做「适配器」（推荐）**
Node 侧需要的全部内容 = §5 的协议，加平台 API。具体清单：

1. 一个 WS 客户端，连 `<core>/ws/<bot_id>`，`bot_id` 是平台名（如 `Discord`）。
2. 平台消息 → `MessageReceive` JSON 的转换：`bot_id`（平台名）、`bot_self_id`、`msg_id`、`user_type` ∈ {group, direct, channel, sub_channel}、`group_id`、`user_id`、`user_pm`（按 §5 映射）、`sender`（尽量带 `nickname`/`avatar`）、`content: Message[]`。
3. `MessageSend` → 平台 API 的转换：处理 `target_type`/`target_id`/`content`，逐段渲染：
   - `log_*` → 只打日志，不发消息
   - `image` 的 `base64://` 与 `link://` **两种都要处理**
   - `buttons` 的 `Button[]` vs `List[Button]`（按行）两种布局
   - `markdown` / `template_markdown` / `template_buttons`：平台不支持时降级
   - `node`：平台不支持合并转发时**必须逐条展开发送**
   - `at` / `reply` / `reply_id`
   - `excute_ban_user` / `excute_delete_message`（可选）
   - `recall_message_id` 回执（可选，core 侧有 10s 超时与能力探测）
4. `file` 段的 `"{文件名}|{base64}"` 拆分。
5. 消息 id 回传（`msg_id`）与 `echo` 回执（若实现 `wait_recall`）。

**第二档：Node 做「宿主」而 Python 做「插件执行器」**
除第一档外，还需要：

6. 事件 → Python 侧车的 RPC（JSON）。
7. Python 侧车提供 `gsuid_core` shim 包，但**可以只实现插件的 60 个模块路径**（§3.3），内部转发到 Node。
8. PIL 相关（`utils.image.*`、`utils.fonts`、`utils.error_reply` 的 `get_error_img`、`help.*`）**必须真跑 Python**；Node 侧只传 bytes/路径。
9. 配置与 DB 的归属决策：
   - 若插件声明了 `StringConfig` 与 SQLModel 表 → 建议整体留在 Python 侧，Node 只读结果；
   - 若只有 `SV/Plugins` 级别的开关与前缀 → Node 可实现 `data/plugins_configs/<name>.json` 读写。
10. i18n：`t(key, /, lang=None, **params)` + `bot.t(key, **params)`；词条来自 `plugins/<Name>/locales/`，`{p0}` 风格具名占位符。缺 key 回落 key 本身（纯 JS 可降级为原样返回）。
11. 触发器匹配**必须逐字复刻** `trigger.py`：`_CMD_GAP` 四个字符、`_is_cjk`/`_script_boundary` 的中英交界空格弹性、`on_prefix` 必须有参数、`on_command` 允许无参数、`on_regex` 在 **去前缀后的文本** 上 `re.findall`、`ev.text`/`ev.command` 的填充算法。Python `re` 与 JS `RegExp` 在 `\d`、`\w`、命名分组语法上不同——**命名分组 `(?P<name>...)` JS 不支持，需要转换**。
12. 分发顺序：`on_message` 先派发（不参与 block）；命令类按 `(not trigger.prefix, sv.priority)` 排序；`block=True` → `break`。
13. 鉴权级联 `_sv_authorized` 的 12 个判断（§4.3），以及 `get_user_pml` 的 masters/superusers 覆盖逻辑。
14. `Bot.instances` / `mutiply_instances` 的多步会话状态机（`receive_resp` / `receive_mutiply_resp` / `send_option`），含 `sv.modify_func` 在 `finally` 的清理。
15. `call_bot()` 的语义（遍历调用栈找 `Bot` 实例）——纯 JS 可用 AsyncLocalStorage 近似，但**定时任务中不可用**（文档明确说明），文档建议改用 `call_bot().target_send()`。

**第三档：纯 JS 重写整个宿主**
不建议。理由（量化）：
- core 本体 631 个 py / 153,865 行；
- PIL 绘图是插件的核心能力（GenshinUID 478 处、StarRailUID 235 处、ZZZeroUID 198 处、WzryUID 54 处 PIL 引用）；
- 大量插件 `await bot.send(pil_image)`（真实例子见 §2.3 的 `register_help(..., Image.open(ICON))`）；
- `msgspec` / SQLModel / APScheduler 的行为细节（`misfire_grace_time`、`coalesce`、`replace_existing` 禁用、`with_session` 自动 commit/rollback）都要重造。

### 9.2 Python 侧 shim 的最小模块清单（若走第二档）

按引用次数排序，**前 20 个模块即可让绝大多数非绘图插件跑起来**：

```
gsuid_core.logger                        130
gsuid_core.models                        124
gsuid_core.bot                            86
gsuid_core.sv                             93
gsuid_core.i18n                           63
gsuid_core.utils.image.convert            45   ← PIL
gsuid_core.utils.database.models          42
gsuid_core.utils.error_reply              37   ← PIL
gsuid_core.utils.image.image_tools        24   ← PIL
gsuid_core.ai_core.trigger_bridge         25
gsuid_core.aps                            15
gsuid_core.utils.database.api             15
gsuid_core.subscribe                      14
gsuid_core.utils.image.utils / fonts.fonts 6
gsuid_core.data_store                      7
gsuid_core.segment                         8
gsuid_core.help.utils / help.model / help.draw_*  8
gsuid_core.server                          4
gsuid_core.gss                             2
gsuid_core.message_models                  2
```

### 9.3 兼容层的验收测试建议

1. **纯文本**：`gs_test.py` 的 `on_fullmatch("全匹配测试")`、`on_prefix(("关闭","开启"))`、`on_keyword("关键词测试")`、`on_suffix("后缀测试")`、`on_regex(...)` 全部走通，`ev.text` / `ev.command` / `ev.regex_dict` 值逐字对齐。
2. **前缀**：`Plugins(name=..., force_prefix=["gs"], allow_empty_prefix=False)` + `SV.on_command("查询深渊")` → 验证 `gs查询深渊` 与 `查询深渊` 的差异。
3. **中英交界空格**：`gs 查询深渊` / `gs查询深渊` 等价；`gs查询 深渊` 的 `ev.text` 正确。
4. **block**：两个 SV，优先级 3 与 5，前者 `block=True` → 后者不触发。
5. **多步会话**：`bot.receive_resp("...", [选项...])` 与 `bot.receive_mutiply_resp(...)` 的区分（单用户 vs 群内任意用户），60 秒超时。
6. **媒体**：`MessageSegment.image(url)` → `link://`；`MessageSegment.image(PIL)` → `base64://`；`MessageSegment.buttons([[b1,b2],[b3,b4,b5,b6]])` 的分行；`node` 在「禁止/允许/拆分/合并」四种 `EnableForwardMessage` 配置下的行为。
7. **权限**：`masters`/`superusers` 覆盖；`SV(pm=0)` 与 `SV(pm=1)` 的 `user_pm > sv.pm → 拒绝`。
8. **配置**：`StringConfig('X', path, DEFAULT)` 建文件 → `get_config('k').data` → `set_config` → 文件落盘 → `data/plugins_configs/X.json` 里的 `prefix`/`sv` 生效。
9. **重载**：`core重载插件X` 后旧 SV 消失、定时任务不重复注册（`ConflictingIdError` 不出现）。

### 9.4 关键坑位（容易做错的地方）

- `Plugin.permisson` 拼写（少一个 i）。
- `real_bot_id` vs `bot_id`：能力表（`SendMDPlatform` 等）查的是 `real_bot_id`；`msg.bot_id` 若含 `:` 会被 `split(":")[0]` 截断赋给 `Event.bot_id`。
- `Event.session_id` 的格式是 `{WS_BOT_ID}:{bot_id}:{bot_self_id}:group|private:{id}`，而 `Bot.session_id` 是 `{bid}%%%{temp_gid}%%%{uid}`——**两个 `session_id` 不同**，不要混用。
- `on_message` 的 `keyword` 是随机 uuid4（作为 dict key 去重），不参与文本匹配。
- `_PREFIXLESS_TYPES = {"file", "meta", "message"}` 不展开插件前缀。
- `Bot.send` 的 `at_sender` 位置由配置 `AtSenderPos`（"消息最后" 或默认插入头部）决定。
- `receive_resp` 在超时/异常时 `finally` 清理 `Bot.instances`，但 `receive_mutiply_resp` 只在 `sv.modify_func` 的 `finally` 清理 `mutiply_instances`/`mutiply_map`。
- 插件目录名**必须等于** `Plugins(name=...)`，否则 `SV` 反推的 `self_plugin_name` 与配置键不一致。

---

## 附录 A：本文引用的一手来源

| 内容 | 来源 |
|---|---|
| 插件目录/入口/加载 | `gsuid_core/server.py:51-52,113-119,301-353,372-451,453-506,530-589` |
| 插件名反推 | `gsuid_core/sv.py:144-153` |
| SV / Plugins / SL | `gsuid_core/sv.py:22-34,109-172,186-197,334-500,1053-1090` |
| 触发器匹配语义 | `gsuid_core/trigger.py:1-311` |
| 分发 / 鉴权 / 权限 | `gsuid_core/handler.py:270-310,386-405,545-645,768-867` |
| Event / Message 模型 | `gsuid_core/models.py`；<https://docs.sayu-bot.com/CodeAdapter/Pack.html> |
| Bot 类 | `gsuid_core/bot.py`（`Bot`、`_Bot`、`call_bot`） |
| MessageSegment / Button | `gsuid_core/segment.py:89-264`、`gsuid_core/message_models.py` |
| 图片工具 | `gsuid_core/utils/image/convert.py`、`utils/image/image_tools.py`、`utils/fonts/fonts.py` |
| 配置 | `gsuid_core/config.py:13,122,268-382`、`utils/plugins_config/models.py`、`utils/plugins_config/gs_config.py:104-174` |
| 数据库 | `gsuid_core/utils/database/base_models.py:90-2100`、`utils/database/models.py`、`utils/database/api.py` |
| 调度 / 订阅 / 钩子 / 路径 | `gsuid_core/aps.py`、`subscribe.py`、`server.py:162-270`、`data_store.py` |
| 帮助 / 控制台 | `gsuid_core/help/utils.py`、`help/model.py`、`webconsole/mount_app.py`、`webconsole/plugin_page.py` |
| WS 协议 | <https://docs.sayu-bot.com/CodeAdapter/Protocol.html> |
| 插件开发章节 | <https://docs.sayu-bot.com/CodePlugins/Start.html>、`CookBook.html`、`Simple.html`、`Exsample.html`、`Class.html`、`Scheduler.html`、`PluginsPrefix.html`、`PluginsConfig.html`、`GetPluginsConfig.html`、`PluginsDataBase.html`、`Resp.html`、`Subscribe.html`、`trigger.html`、`BotCall.html` |
| 插件索引 | <https://docs.sayu-bot.com/plugin_list.json> |
| 真实插件源码 | [GenshinUID v4](https://github.com/KimigaiiWuyi/GenshinUID)、[StarRailUID](https://github.com/baiqwerdvd/StarRailUID)、[WzryUID](https://github.com/KimigaiiWuyi/WzryUID)、[ZZZeroUID](https://github.com/ZZZure/ZZZeroUID) |
| 适配器开发参考（12 篇） | `gsuid_core/.agents/skills/gscore-adapter-development/references/01..12-*.md`（在 gsuid_core 仓库内） |

## 附录 A2：第二批深度核验（源码级补充与勘误）

对 `gsuid_core` 0.10.7 快照做逐行复核后，以下内容**修正或显著细化**了前面的描述。行号以本地 `gsuid_core-master` 为准。

### A2.1 勘误（必须修正的）

| # | 前面写的 | 源码事实 |
|---|---|---|
| 1 | WS 是 text 帧 JSON | **binary 帧**：`await websocket.receive_bytes()`（`core.py:162`）+ `msgjson.decode(data, type=MessageReceive)`（`:163`）；发送 `send_bytes`（`bot.py:512`）。协议文档过时 |
| 2 | 队列按 SV priority 排序 | `TaskContext.priority = _event.user_pm`（`handler.py:593,639,763,380`）——**队列按用户权限排序**；SV priority 只决定 `handle_event` 里的**同步派发顺序** |
| 3 | `get_error_img` 返回图片 bytes | 当前实现 `is_pic_error` 硬编码 False，**恒返回纯字符串**（`utils/error_reply.py:103-114`） |
| 4 | 定时任务"job store 未配置" | 确认：**没有配置 jobstore**，APScheduler 用默认 **MemoryJobStore**，任务**不持久化**，重启靠重新 import 重新注册 |
| 5 | `handler._check_command` 是 `SV` 用的 | `handler.py:897-904` 的 `_check_command` 是**死代码**，从不被调用；实际判定在 `Trigger.check_command` |
| 6 | `/api/send_msg` 是可用替代通道 | 该 HTTP 路径用进程级 `_Bot("HTTP")`（`core.py:211`），但**它的 `_process()` 从未被启动**（只有 WS 端点会启动），队列永不被消费 → `wait_task` 20s 超时。**本快照中 HTTP 命令派发实际不可用** |

### A2.2 `handle_event` 的完整步骤表（补全中间步骤）

| # | 动作 | 代码 |
|---|---|---|
| 1 | `IS_HANDDLE` 总闸 | `handler.py:387-388` |
| 2 | **meta 段最先拦截**（早于黑名单） | `:391-392` → `handle_meta_event` `:321` |
| 3 | 读 `BlackList` / `ShieldQQBot` / `ShowReceive` / `SameUserEventCD` / AI 开关 | `:394-399` |
| 4 | `msg.user_pm = user_pm = await get_user_pml(msg)` | `:402` |
| 5 | `event = await msg_process(msg)` | `:403` → `:780` |
| 6 | `event.WS_BOT_ID = ws.bot_id`；重复桥接告警 | `:404-405` |
| 7 | `ShowReceive` 时打印收到事件 | `:406-407` |
| 8 | `ai_scope_banned = is_scope_banned(event.session_id)` | `:409-411` |
| 9 | AI 入站 hook 扇出（只观察，不阻断） | `:415-426` |
| 10 | **写历史**（`_has_text or event.at_list`）——**早于触发器匹配** | `:431-478` |
| 11 | `if event.user_pm == 0: _schedule_owner_subscribe(event)` | `:484-485` |
| 12 | `get_platform_val(...)["receive"] += 1` | `:487-488` |
| 13 | 影子用户/群写入（缓冲或后台任务） | `:490-503` |
| 14 | **多步会话拦截**（`Bot.instances` / `mutiply_instances`）→ 命中则 `return` | `:505-532` |
| 15 | `SameUserEventCD` 冷却 → return | `:534-540` |
| 16 | `command_start` 剥离 → 可能直接 return | `:542-555` |
| 17 | 黑名单 + 遍历 `SL.lst` + `check_command` → `valid_event` | `:557-577` |
| 18 | 拆分 `command_triggers` / `message_triggers` | `:579-580` |
| 19 | 派发 `on_message` | `:582-594` |
| 20 | 派发命令触发器，否则进 AI 分支 | `:596-765` |

**关键顺序结论**：
- meta 早于一切（含黑名单）。
- **历史记录写在触发器匹配之前**。
- **多步会话拦截也早于触发器匹配**——所以 `receive_resp` 等待期间，用户的下一条消息根本不会进入触发器匹配。
- `command_start` 剥离是**原地改 `event.raw_text`**；且当 `_command_start` 非空而无前缀命中时，**整条消息被丢弃**（`return`）：
  ```python
  # handler.py:542-555
  is_start = False
  if _command_start and event.raw_text:
      for start in _command_start:
          if event.raw_text.strip().startswith(start):
              event.raw_text = event.raw_text.replace(start, "", 1)
              is_start = True
              break
      else:
          if not is_start:
              return
  ```
  `_command_start = command_start + [""]`（仅当 `enable_empty_start` 为真）；两者默认分别是 `[]` 与 `True`，所以**默认配置下不剥离、不丢弃**。

### A2.3 候选集与排序的精确细节

```python
# handler.py:596-645（关键片段）
if len(command_triggers) >= 1:
    if event.at:                                   # ← @ 屏蔽检查只在 event.at（最后一个非 bot 的 @）
        for shield_id in shield_list:
            if event.at.startswith(shield_id):
                logger.warning(t("log.handler.at_bot_shield"))
                return
    sorted_event = sorted(command_triggers.items(), key=lambda x: (not x[0].prefix, x[1]))
    for trigger, _ in sorted_event:
        ...
        if trigger.block:
            break
```

- 主排序键 `(not trigger.prefix, sv.priority)`：**无前缀触发器排最后**；次键 SV priority **升序**（数字小=先执行）；`sorted` 稳定，平局保持 `SL.lst` / `TL` 插入顺序（= 插件加载顺序）。
- `valid_event` 的**值**是 **SV 的 priority**，不是 Plugins 的 priority。
- 没有按触发器类型或首字符的预索引——**每个 SVIDE、每个类型桶、每个触发器**都会被遍历；每个 `Trigger` 内部做廉价首字符探针。
- `ShieldQQBot` 默认 `["38890","28541","28542"]`（`sp_config.py:30-35`）。
- `on_message` 单独循环：不 `count_data`、不挂 trace、**不处理 `block`**、不排序、不抑制 AI。
- `get_command` 在 `task_id` 赋值**之前** await（因为它会改 `_event.command`/`text`）。

### A2.4 `event.WS_BOT_ID` 与限流

- `event.WS_BOT_ID = ws.bot_id`（`handler.py:404` / meta 路径 `:327`），它是 `/ws/{bot_id}` 的**路由段**。
- 入站并发门（`handler.py:38-40,61-93`，`core.py:155,167`）：每连接 `asyncio.Semaphore(32)`，1.0s 内拿不到槽位或事件超 30s → **只丢这一条**。
- 全局开关 `set_handle(is_handle)`（`handler.py:129-134`）。
- `Trigger.func` 存的是 `sv.modify_func` 包出来的 wrapper（`sv.py:38-57`）：**插件异常被框架吞掉并记日志**，`finally` 里清理 `Bot.instances`。

### A2.5 配置系统的精确 schema（核实）

`plugins_sample`（`config.py:122-135`）**逐字**为：

```python
{"name": "", "pm": 6, "priority": 5, "enabled": True, "area": "SV",
 "black_list": [], "white_list": [], "prefix": [], "force_prefix": [],
 "disable_force_prefix": False, "allow_empty_prefix": False, "sv": {}}
```

> 注意：sample 里**没有 `alias`**，但活的 `Plugins` 类有，且 `sv.py:232` 会把 `alias` 写进存储的 dict → 真实文件里有 `alias`。

`data/plugins_configs/<plugin_name>.json` 的**实际持久化 schema**：

```json
{
  "name": "GenshinUID", "pm": 6, "priority": 5, "enabled": true, "area": "SV",
  "black_list": [], "white_list": [],
  "prefix": [], "force_prefix": ["gs"], "disable_force_prefix": false,
  "allow_empty_prefix": false, "alias": ["gsuid"],
  "sv": {
    "查询深渊": {"priority": 5, "enabled": true, "pm": 6, "black_list": [], "area": "ALL", "white_list": []}
  }
}
```

`SV.__init__` 解析 `priority/enabled/pm/black_list/area/white_list` 的**优先级顺序**（`sv.py:255-292`）：
① 旧 `core_config["sv"][name]`（读后从 `config.json` 删除）→ ② `plugins_configs/<plugin>.json` 的 `sv.<name>` → ③ 构造参数；随后一律用 `SV.set` 写回 6 个字段。

`StringConfig` 补充（`gs_config.py`）：
- `__new__` 单例注册表 `all_config_list: Dict[str, StringConfig]`（`:508`）。
- `get_config(key, default_value=None) -> GSC` 返回**配置对象**；缺 key 会合成一个猜测类型的默认对象。实际用法恒为 `config.get_config("X").data`。
- `set_config(key, value) -> bool` **强校验 `type(value) == type(item.data)`**；对 `GsRepeatGroupConfig` / `GsTimeRConfig`(list→tuple) / `GsTimeRangeConfig`(嵌套 list→嵌套 tuple) / `GsFloatConfig`(int→float) / `GsDateConfig`(ISO str→date) 做特化转换；未知 key 返回 False。
- 落盘格式是 msgspec tagged struct，例如
  `{"type": "GsStrConfig", "title": ..., "desc": ..., "data": ..., "options": [...], "regex": null, "details": null, "secret": false}`。
- `reconcile_config`（`:43-86`）是**非破坏性**的：补缺失 key、重置类型不符项、刷新 title/desc/options/secret、递归 reconcile 分组、**保留孤儿 key**。
- `self.plugin_name = self._get_caller_plugin_name()`（`:218-231`）用 `sys._getframe(2)` 走路径找 `gsuid_core/plugins` 后的目录名——**在 `plugins/` 之外创建的 config（如 buildin）plugin_name 为 None**，网页控制台就映射不到。

### A2.6 数据库：精确行为（这是最难移植的部分）

- DB 文件：`DB_PATH = get_res_path() / "GsData.db"` → **`data/GsData.db`**（`base_models.py:74`）。
- 建表：**没有 alembic**。`ensure_core_database_tables()`（`utils/database/startup.py:200-209`）import 模型模块后 `SQLModel.metadata.create_all`；增量改列/索引是**手写的幂等 raw SQL 列表**（`exec_list`，`:41-175`），由 `trans_adapter()` 执行，`try: execute; commit except: pass`。
- sqlite：`create_async_engine("sqlite+aiosqlite:///<path>", connect_args={"check_same_thread": False, "timeout": 5.0}, poolclass=NullPool, ...)`；启用 **WAL**（`journal_mode != wal` 直接抛错）；每连接 `PRAGMA busy_timeout=5000; synchronous=NORMAL`；读信号量 24。
- `with_session` / `with_read_session`（`_session_wrapper`，`:438-527`）的确切语义：
  - **写**：若当前 task 已持有写会话（ContextVar `_write_session`）→ 在 `begin_nested()` **savepoint** 内复用；否则开新 session，函数跑完后 `await session.commit()`。
  - **读**：进入前 `PRAGMA query_only=ON`，退出 `OFF`；sqlite 上受 24 并发读信号量限制，且**不抢写闸**。
  - **sqlite 写闸**：进程级单写者闸 `sqlite_write_gate.hold(core=_writer_is_core(func))`（core 模块优先），预算 **10s**，超时抛 `DatabaseWriteTimeout` 并中断/关闭底层 aiosqlite 连接。
  - **重试**：`_retry_db` 3 次，仅对 "database is locked"/"busy"/"disk i/o error" 生效，指数退避 0.5*2^n。
- 启动钩子顺序：`move_database`(-100) → `create_core_tables`(-90) → `trans_adapter`(-80) → `purge_uuid4_command_stats`(-60)。
- **uid 列约定**：`get_gameid_name(game_name)` → `game_name is None or "gs"` → `"uid"`，否则 `f"{game}_uid"`；多 uid 用 `_` 连接拆分。`insert_uid` 返回值语义：`-1` 长度/空、`-3` 非数字、`-2` 已绑定、`0` 成功。`switch_uid_by_game`：`-1` 无记录、`-2` uid 不存在、`-3` 少于 2 个 uid。
- 插件确实重度使用：`GsBind.insert_uid/switch_uid_by_game/delete_uid/get_uid_by_game/get_uid_list_by_game/get_all_uid_list_by_game/get_all_data`、`GsUser.get_user_cookie_by_uid/get_all_stoken/get_all_cookie/get_all_user/get_sign_user_list/full_insert_data`；StarRailUID 到处 `get_uid(bot, ev, GsBind, "sr", True, pattern=r"\d{9}")`；插件自定义表一律 `<X>Bind(Bind, table=True)` / `<X>User(User, table=True)` / `<X>Push(Push, table=True)`。
- **结论**：Node 侧要么完整复刻这套表/列/CRUD 契约（表名列名必须逐字一致，因为 core 自身也读同一 DB），要么把 DB 层整体留在 Python。

### A2.7 调度器：一个真实的坑

```python
# aps.py:19-37
options = {
    "executor": ThreadPoolExecutor(max_workers=10),
    "job_defaults": {"misfire_grace_time": core_config.get_config("misfire_grace_time"), "coalesce": True},
    "timezone": "Asia/Shanghai",
}
class _GsScheduler(AsyncIOScheduler):
    def scheduled_job(self, *args, **kwargs):
        kwargs.pop("replace_existing", None)   # 强制禁止
        return super().scheduled_job(*args, **kwargs)
scheduler = _GsScheduler(); scheduler.configure(options)
```

`remove_repeat_job()`（`:53-67`）**按 `job.name` 去重并删除后一个**——这是「我的定时任务莫名消失」的真实来源，在 `load_gss` 结束时调用（`gss.py:11`）。

### A2.8 订阅 `send()` 的分发规则（重要）

`Subscribe.send(reply=None, option_list=None, unsuported_platform=False, sep="\n", command_tips="请输入以下命令之一:", command_start_text="", force_direct=False, extra_metadata=None)`（`utils/database/models.py:103-189`）：

- 构造一个 `Event(bot_id, user_id, bot_self_id, user_type=("direct" if force_direct else self.user_type), group_id, real_bot_id, msg_id)`。
- 若 `self.WS_BOT_ID` 已设且该 bot 在线 → 用它发。
- 若已失效 → 扫描 `gss.active_bot` 找 `bot_id` 匹配的，**更新 DB 里的 `WS_BOT_ID`** 再发。
- 若都找不到 → 记日志并 **`return -1`**。
- 若 `WS_BOT_ID` 为空 → **向所有在线 bot 广播**。

`Subscribe` 表列：`id, user_id, bot_id, WS_BOT_ID, group_id, task_name, bot_self_id, user_type, extra_message, uid, extra_data, msg_id`，索引 `ix_subscribe_task_name_uid(task_name, uid)`，`group_id` 与 `task_name`、`uid` 单独索引。

### A2.9 Web 控制台的精确定义

FastAPI 实例在 **`gsuid_core/app_life.py:51-57`**，被 `gsuid_core/web_app.py` 与 `gsuid_core/webconsole/app_app.py` 重新导出。插件推荐 `from gsuid_core.webconsole.app_app import app`。

```python
# webconsole/mount_app.py:35-69
class PageSchema(BaseModel):
    label: str
    icon: str

class GsAdminModel:
    model: Any = None
    pk_name: str = "id"
    page_schema: Any = None

class Site:
    def __init__(self): self.plugins_page: Dict[str, List] = {}; self._registered: Dict = {}; self.is_start = False
    def register_admin(self, *admin_cls: Type[GsAdminModel], _ADD: bool = False) -> Type[GsAdminModel]:
        plugin_name = get_caller_plugin_name()      # sys._getframe(2) 走路径
        ...
        return admin_cls[0]

site = Site()
```

> `site` **只是一个按调用方插件分组的注册表**——框架并不真的挂 amis admin。所以插件即使从 `fastapi_amis_admin.amis.components` import `PageSchema` 也能工作（core 从不检查类型）。

```python
# webconsole/plugin_page.py:235-305
def register_plugin_page(*, title: str, static_dir: str | Path, page_id: str = "main",
                         plugin: str | None = None, description: str = "",
                         confirm_message: str = "", title_i18n=None, description_i18n=None,
                         confirm_message_i18n=None, index: str = "index.html", icon: str = "",
                         locales_dir: str | Path | None = None) -> PluginPageSpec
# 校验 page_id ^[a-z][a-z0-9_-]{0,63}$，不能以 "_" 开头；要求 static_dir/index.html 存在

class PluginAPI:                                    # plugin_page.py:391-459
    def __init__(self, plugin=None, *, prefix=None, auth=True, tag=None)
    # 默认 prefix = f"/api/{plugin_id}"，默认 Depends(require_auth)

def unregister_plugin_pages(plugin_name) -> int     # 热重载时调用
def api_ok(data, msg="ok") / def api_fail(msg, status=1)
```

鉴权辅助：`webconsole/web_api.py`：`verify_token(authorization=None, token=None)`、`require_auth(...)`、`require_admin(...)`、`require_auth_header(...)`、`require_admin_header(...)`。

真实插件用法：ZZZeroUID 的 `zzzerouid_webconsole/__init__.py:9-33` 调 `register_plugin_page(...)` 后在 `api.py:34` 用 `api = PluginAPI()` + `@api.get("/players")` / `api_ok(...)`；也支持裸 `@app.get` + `Depends(require_auth)`。

### A2.10 帮助系统与其它工具的精确定义

```python
# help/utils.py:12-32
def register_help(name: str, help: str, icon: Optional[Image.Image] = None):
    if icon is None: icon = Image.open(ICON)
    if icon.mode != "RGBA": icon = icon.convert("RGBA")
    plugin_help = {"name": name, "desc": f"{name}插件帮助功能", "eg": f"发送 {help} 获得帮助",
                   "icon": icon, "need_ck": False, "need_sk": False, "need_admin": False}
    if plugin_help not in plugins_help["插件帮助一览"]["data"]:
        plugins_help["插件帮助一览"]["data"].append(plugin_help)

# help/draw_new_plugin_help.py:102-126
async def get_new_help(plugin_name, plugin_info: Dict[str, str], plugin_icon: Image.Image,
                       plugin_help: Dict[str, PluginHelp], plugin_prefix="",
                       help_mode: Literal["dark","light"]="dark", banner_bg=None,
                       banner_sub_text="💖且听风吟。", help_bg=None, cag_bg=None, item_bg=None,
                       icon_path=ICON_PATH, footer=None, column=3, need_cover=False,
                       enable_cache=True, pm=6, highlight_bg=None, banner_title_color=None,
                       banner_sub_color=None, cag_title_color=None, cag_sub_color=None,
                       plugin_icon_size=128)
# 缓存到 data/help/{plugin_name}_{pm}.jpg
```

> `help.json`（插件自己维护 `Dict[str, PluginHelp]`）是第三方插件的惯例文件。

```python
# utils/error_reply.py:78-134
def get_error(retcode: Union[int, str], message: Union[str, Dict, None] = None) -> str
def get_error_type(retcode) -> str
async def get_error_img(retcode, force_image: bool = False, message=None) -> Union[bytes, str]
async def draw_error_img(retcode=51233, error_message=None, error_type=None) -> bytes
# 模块级字符串 UID_HINT / MYS_HINT / CK_HINT / CHAR_HINT(含一个 {} 槽) / VERIFY_HINT / SK_HINT / UPDATE_HINT
# ERROR_CODE: Dict[int, str]（键 -51,-100,-503,10001,10101,10102,1034,-10001,-201,1008,10104,-999,-501002,10110,-199）

# utils/message.py
async def send_diff_msg(bot: Bot, code: Any, data: Dict)
async def send_msg_to_master(message)   # 读 masters；用 gs_subscribe.get_subscribe("主人用户")；发给第一个去重后的订阅，force_direct=True

# utils/cache.py
IMAGE_CACHE = get_res_path("IMAGE_CACHE")
CACHE: Dict[float, Dict[str, Union[Path, str]]] = {}
def gs_cache(expire_time=3600)          # 同时支持协程与同步函数；图片落到 data/IMAGE_CACHE/{time_key}_{file_key}.jpg

# pool.py
def to_thread(func)                     # @to_thread，同步/异步皆可；模块级 ThreadPoolExecutor(max_workers=10)
def to_process(func)
run_in_thread_pool = to_thread
def shutdown_pools()                    # 通过 on_core_shutdown 注册

# status/plugin_status.py（全文 15 行）
plugins_status: Dict[str, PluginStatus] = {}
def register_status(ICON: Image.Image, plugin_name: str,
                    plugin_status: Dict[str, Callable[..., Awaitable[Union[str, int, float]]]])
```

### A2.11 启动钩子的执行语义（细化）

- 注册是**进程全局**的模块级集合（`core_start_def` / `core_start_before_def` / `core_shutdown_def`），不是 per-plugin；热重载按 `func.__module__` 归属移除。
- 执行：按 priority 升序，**同 priority 用 `asyncio.gather` 并发**，每组完成后才进下一组；协程函数直接 await，同步函数走 `asyncio.to_thread`；整组包在 try/except 里**只记日志**。
- lifespan 顺序（`app_life.py:14-48`）：① `await core_start_before_execute()`（**阻塞，在服务开始服务之前**）→ ② `create_task(check_speed())` → ③ `create_task(core_start_execute())`（**不 await**）→ ④ `create_task(_bgsetup_frontend_b())` → ⑤ `await start_scheduler()` → ⑥ `create_task(clean_trace_collector())`；关闭时 `shutdown_event.set()` → `await shutdown_scheduler()` → `await core_shutdown_execute()`。
- 插件加载在更早的 `core.py:82-86`（`init_database()` 然后 `load_gss()`）。

### A2.12 给兼容层的 8 条硬性提醒（复核者总结）

1. **两套 session id 并存**：`Event.session_id` = `{ws}:{bot_id}:{bot_self_id}:group:{gid}`，而 `Bot.session_id` 与派发层拦截键 = `{bid}%%%{temp_gid}%%%{uid}`。`receive_resp` 等待用的是**后者**。
2. **`on_message` 绕过一切**（无 count/trace/block/AI 抑制），且以随机 uuid4 作 keyword。
3. **队列优先级是 `user_pm`，不是 SV priority。**
4. **权限拒绝是静默的**，与「没匹配到」不可区分——消息会继续流进 AI 分支。
5. **`raw_text` 被破坏性改写两次**（段级 `.strip()` 拼接 → `command_start` 剥离），`ev.text` 是第三份值（由 `get_command` 产出）。
6. **前缀展开必须复刻**（`sv.py:343-383`）：`force_prefix` / `disable_force_prefix` / `allow_empty_prefix` / `list(set(_pp))` 去重（**前缀顺序不确定**）/ `_PREFIXLESS_TYPES` 豁免。
7. **`GsLogger` 的日志帧用路由 id 作 `bot_id`**（`gs_logger.py:16-21`）——这是唯一 `bot_id != real_bot_id` 的出站帧；`target_type`/`target_id` 为 `None`，适配器应**打印而不发送**。
8. 有现成测试锁语义，可直接当兼容层的对照：`tests/test_handler_command_vs_ai.py`、`tests/test_inbound_dispatch.py`。

---

## 附录 B：统计口径说明

- import 统计：下载 4 个插件仓库 zipball → 展开 → 对全部 `*.py` 逐行正则匹配 → 判重。命令等价于
  `Select-String -Pattern '^\s*(from\s+gsuid_core[\w\.]*\s+import\s+.+|import\s+gsuid_core[\w\.]*)'`。
- 计数示例数据来自 core 的 `buildin_plugins/` + 4 个插件仓库的合并去重（因此 §3.2 的数字大于 §3.3 的「仅插件仓库」数字）。
- Star/Fork/推送时间：GitHub REST API `GET /repos/{owner}/{repo}` 于 2026-09 采集；仓库默认分支不同（GenshinUID 是 `v4`，不是 `master`），下载时须用 `default_branch`。
- 本地源码快照路径：`D:\yunzaibot\JiuLi\_gsresearch\x\`（`gsuid_core-master`、`GenshinUID-4`、`StarRailUID-master`、`WzryUID-main`、`ZZZeroUID-master`）。
