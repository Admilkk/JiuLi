"""
gsuid_core.sv 仿制：SV（服务）/ SL（服务表）/ Plugins（插件级配置）

GsCore 的插件没有任何清单文件：模块 import 时创建 `SV('名字')` 并用 `@sv.on_xxx` 装饰器
注册触发器，注册是 import 的副作用。所以这里也必须是「装饰器即注册」，注册表是模块级的。

匹配语义按 gsuid_core 源码（trigger.py / sv.py）实测复刻，几个容易搞错的点：
  - on_command：以 head 开头即命中，**不要求带参数**（等于 fullmatch + prefix）
  - on_prefix ：必须**还有后续内容**，且 head 之后紧跟的字符不能是空白
  - 中英交界处空格弹性：`gs查询` 与 `gs 查询` 视为同一命令（_needs_flex_gap）
  - on_prefix 的 ev.command 是「命中的触发词」，ev.text 是它后面剩下的内容
  - on_regex 在**去前缀后的文本**上 findall，并把命名分组填进 ev.regex_dict
"""

import re
import uuid
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple, Union

TriggerValue = Union[str, Iterable[str], Dict[str, Any]]

# 真实源码：_CMD_GAP = " \t\u3000\u00a0"
_CMD_GAP = " \t\u3000\u00a0"
# 不做前缀展开的触发器类型（真实源码 _PREFIXLESS_TYPES）
_PREFIXLESS_TYPES = {"file", "meta", "message"}


def _caller_plugin_name() -> str:
    """
    真实 GsCore 用调用栈路径反推插件名（找到 plugins/<name>/ 段的下一段）。
    兼容层里插件是顶层模块（gs_jiuli_test），所以取调用者模块名的第一段即可。
    """
    import inspect

    frame = inspect.currentframe()
    try:
        frame = frame.f_back if frame else None
        while frame is not None:
            module_name = frame.f_globals.get("__name__", "")
            parts = module_name.split(".")
            if parts and parts[0] and parts[0] not in ("gsuid_core", "__main__", "boot_gscore"):
                return parts[0]
            frame = frame.f_back
    finally:
        del frame
    return ""


def _as_list(value: TriggerValue) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [str(k) for k in value.keys()]
    try:
        return [str(i) for i in value]
    except TypeError:
        return [str(value)]


def _is_cjk(ch: str) -> bool:
    return "\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf"


def _script_boundary(left: str, right: str) -> bool:
    """左右字符属于不同书写系统（中/英）时返回 True"""
    if not left or not right:
        return False
    return _is_cjk(left) != _is_cjk(right)


def _needs_flex_gap(keyword: str) -> bool:
    return any(_script_boundary(keyword[i], keyword[i + 1]) for i in range(len(keyword) - 1))


def _consume_keyword(text: str, keyword: str) -> Optional[int]:
    """
    在 text 开头消费 keyword，返回消费掉的字符数；不匹配返回 None。
    中英交界处允许 0 或 1 个空白（`gs查询` ≈ `gs 查询`）。
    """
    if not keyword:
        return 0
    if text.startswith(keyword):
        return len(keyword)
    if not _needs_flex_gap(keyword):
        return None

    ti = ki = 0
    while ki < len(keyword):
        if ti >= len(text):
            return None
        if text[ti] == keyword[ki]:
            ti += 1
            ki += 1
            continue
        # 当前 text 字符是空白，且 keyword 在这里恰好是中英交界 → 允许跳过
        if (
            text[ti] in _CMD_GAP
            and ki > 0
            and ki < len(keyword)
            and _script_boundary(keyword[ki - 1], keyword[ki])
        ):
            ti += 1
            continue
        return None
    return ti


class Trigger:
    def __init__(self, type: str, keyword: str, func: Callable, prefix: str = "",
                 block: bool = False, to_me: bool = False):
        self.type = type
        self.keyword = keyword
        self.func = func
        self.prefix = prefix
        self.block = block
        self.to_me = to_me
        self._head = f"{prefix}{keyword}"
        self._pattern = re.compile(keyword) if type == "regex" else None

    @property
    def is_async(self) -> bool:
        import inspect

        return inspect.iscoroutinefunction(self.func)

    # ---------- 判定 ----------

    def check_command(self, ev) -> bool:
        text = ev.raw_text or ""
        t = self.type

        if t == "message":
            return True
        if t == "fullmatch":
            n = _consume_keyword(text, self._head)
            return n is not None and n == len(text)
        if t in ("command", "prefix"):
            n = _consume_keyword(text, self._head)
            if n is None:
                return False
            if t == "command":
                return True
            # on_prefix 必须带后续内容
            if len(text) <= n:
                return False
            return text[n] not in _CMD_GAP
        if t == "suffix":
            return text.endswith(self.keyword) and text != self.keyword
        if t == "keyword":
            return self.keyword in text
        if t == "regex":
            rest = self._rest_of(text)
            return bool(self._pattern.findall(rest))
        if t == "file":
            name = ev.file_name or ""
            return bool(ev.file) and name.split(".")[-1] == self.keyword
        if t == "meta":
            return ev.meta_event_type == self.keyword
        return False

    def _rest_of(self, text: str) -> str:
        """去掉插件前缀后的文本（regex 在前缀之后做匹配）"""
        if self.prefix and text.startswith(self.prefix):
            return text[len(self.prefix):]
        return text

    async def get_command(self, ev) -> Any:
        """命中后填充 ev.command / ev.text（regex 另填 regex_group / regex_dict）"""
        text = ev.raw_text or ""
        t = self.type

        if t in ("command", "prefix"):
            n = _consume_keyword(text, self._head) or 0
            ev.command = self.keyword
            ev.text = text[n:].strip()
        elif t == "fullmatch":
            ev.command = self.keyword
            ev.text = ""
        elif t == "suffix":
            ev.command = self.keyword
            ev.text = text[: len(text) - len(self.keyword)].strip()
        elif t == "keyword":
            ev.command = self.keyword
            ev.text = text.replace(self.keyword, "", 1).strip()
        elif t == "regex":
            rest = self._rest_of(text)
            match = self._pattern.search(rest)
            ev.command = match.group(0) if match else ""
            ev.regex_group = tuple(match.groups()) if match else ()
            ev.regex_dict = dict(match.groupdict()) if match else {}
            # 与 GsCore 一致：去掉正则命中的那一段，剩下的交给插件
            ev.text = rest[: match.start()].strip() + rest[match.end():].strip() if match else rest.strip()
        elif t == "message":
            ev.text = text
            ev.command = ev.command or ""
        return ev


class Plugins:
    """插件级配置：前缀、权限、别名。真实 GsCore 用它约束整个插件目录。"""

    registry: Dict[str, "Plugins"] = {}

    def __init__(
        self,
        name: str = "",
        pm: int = 6,
        priority: int = 5,
        enabled: bool = True,
        area: str = "SV",
        black_list: Optional[List] = None,
        white_list: Optional[List] = None,
        sv: Optional[Dict] = None,
        prefix: Optional[TriggerValue] = None,
        force_prefix: Optional[TriggerValue] = None,
        disable_force_prefix: bool = False,
        allow_empty_prefix: Optional[bool] = None,
        force: bool = False,
        alias: Optional[TriggerValue] = None,
        **kwargs,
    ):
        self.name = name
        self.pm = pm
        self.priority = priority
        self.enabled = enabled
        self.area = area
        self.black_list = black_list or []
        self.white_list = white_list or []
        self.sv = sv or {}
        self.prefix = _as_list(prefix)
        self.force_prefix = _as_list(force_prefix)
        self.disable_force_prefix = disable_force_prefix
        self.allow_empty_prefix = bool(prefix) is False if allow_empty_prefix is None else allow_empty_prefix
        self.force = force
        self.alias = _as_list(alias)
        Plugins.registry[name] = self
        # 同时登记进 SL：SV 可能先于 Plugins 创建，两边保持同步
        try:
            SL.plugins[name] = self
            for existing in SV.registry:
                if existing.self_plugin_name == name or existing.name == name:
                    existing.plugins = self
        except NameError:  # 模块加载期 SL 还没定义
            pass

    def get_prefixs(self) -> List[str]:
        """可用前缀：prefix + force_prefix + 空串（允许无前缀时）"""
        out = list(self.prefix) + list(self.force_prefix)
        if self.allow_empty_prefix:
            out.append("")
        return list(set(out))

    def get_force_prefixs(self) -> List[str]:
        if self.disable_force_prefix:
            return []
        return list(self.force_prefix)


class Service:
    """SV 的基类名（部分插件 from gsuid_core.sv import Service）"""


class SV(Service):
    """
    服务模块：一个 SV 下可以挂多条触发器。
      sv = SV('测试开关')
      @sv.on_prefix(('开启', '关闭'))
      async def handler(bot, ev): ...
    """

    _instances: Dict[str, "SV"] = {}

    def __new__(cls, name: str = "", *args, **kwargs):
        # 真实源码：同名 SV 是单例
        if name and name in cls._instances:
            return cls._instances[name]
        obj = super().__new__(cls)
        if name:
            cls._instances[name] = obj
        return obj

    def __init__(
        self,
        name: str = "",
        pm: int = 6,
        priority: int = 5,
        enabled: bool = True,
        area: str = "ALL",
        black_list: Optional[List] = None,
        white_list: Optional[List] = None,
        **kwargs,
    ):
        if getattr(self, "_initialized", False):
            return
        self._initialized = True
        self.name = name
        self.pm = pm
        self.priority = priority
        self.available = enabled
        self.area = area
        self.black_list = black_list or []
        self.white_list = white_list or []
        self.kwargs = kwargs
        # TL: {触发器类型: {keyword: Trigger}}
        self.TL: Dict[str, Dict[str, Trigger]] = {}
        # 真实源码用调用栈反推插件名（插件目录名），Plugins 是按插件名配置的
        self.self_plugin_name = _caller_plugin_name()
        self.plugins = Plugins.registry.get(self.self_plugin_name) or Plugins.registry.get(name)
        SV.registry.append(self)
        SL.register(self)

    # ---- 开关（SL.lst[name].disable() 那类用法）----

    def disable(self):
        self.available = False

    def enable(self):
        self.available = True

    @property
    def enabled(self) -> bool:
        return self.available

    def set(self, is_lazy: bool = True, **kwargs):
        return self

    # ---- 触发器注册 ----

    def _on(
        self,
        type: str,
        keyword: TriggerValue,
        block: bool = False,
        to_me: bool = False,
        prefix: bool = True,
        to_ai: str = "",
        covers=None,
        aliases=None,
        **kwargs,
    ) -> Callable:
        keywords = _as_list(keyword)

        def decorator(func: Callable) -> Callable:
            for kw in keywords:
                trigger = Trigger(type, kw, func, prefix="", block=block, to_me=to_me)
                trigger.to_ai = to_ai
                trigger.aliases = aliases
                self.TL.setdefault(type, {})[kw] = trigger
            return func

        return decorator

    def on_command(self, command=None, **kwargs):
        return self._on("command", command, **kwargs)

    def on_fullmatch(self, keyword=None, **kwargs):
        return self._on("fullmatch", keyword, **kwargs)

    def on_prefix(self, keyword=None, **kwargs):
        return self._on("prefix", keyword, **kwargs)

    def on_suffix(self, keyword=None, **kwargs):
        return self._on("suffix", keyword, **kwargs)

    def on_keyword(self, keyword=None, **kwargs):
        return self._on("keyword", keyword, **kwargs)

    def on_regex(self, keyword=None, **kwargs):
        return self._on("regex", keyword, **kwargs)

    def on_file(self, file_type=None, **kwargs):
        return self._on("file", file_type, **kwargs)

    def on_message(self, unique_id: Optional[str] = None, **kwargs):
        return self._on("message", unique_id or str(uuid.uuid4()), **kwargs)

    def on_meta(self, event_name=None, **kwargs):
        return self._on("meta", event_name, **kwargs)

    # 所有触发器（TRIGGERS 顺序：真实源码里 message 单独先派发）
    def all_triggers(self) -> List[Tuple[str, Trigger]]:
        out = []
        for type_name, mapping in self.TL.items():
            for trigger in mapping.values():
                out.append((type_name, trigger))
        return out


class SL:
    """服务表：SL.lst['名字'] 取到 SV 实例"""

    lst: Dict[str, SV] = {}
    plugins: Dict[str, Plugins] = {}

    @classmethod
    def register(cls, sv: SV):
        cls.lst[sv.name] = sv

    @classmethod
    def get(cls, name: str) -> Optional[SV]:
        return cls.lst.get(name)


SV.registry: List[SV] = []


def register_plugins(plugins: Plugins):
    SL.plugins[plugins.name] = plugins
    for sv in SV.registry:
        if sv.name == plugins.name:
            sv.plugins = plugins


def get_plugin_prefixs(plugin_name: str) -> List[str]:
    p = SL.plugins.get(plugin_name)
    return p.get_prefixs() if p else [""]


def get_plugin_prefix(plugin_name: str) -> str:
    prefixes = get_plugin_prefixs(plugin_name)
    return prefixes[0] if prefixes else ""


def get_plugin_force_prefixs(plugin_name: str) -> List[str]:
    p = SL.plugins.get(plugin_name)
    return p.get_force_prefixs() if p else []


def get_plugin_force_prefix(plugin_name: str) -> str:
    prefixes = get_plugin_force_prefixs(plugin_name)
    return prefixes[0] if prefixes else ""


def get_plugin_available_prefix(plugin_name: str) -> str:
    """真实源码里最常用的一个：返回可用于展示的前缀"""
    prefixes = [p for p in get_plugin_prefixs(plugin_name) if p]
    return prefixes[0] if prefixes else ""


__all__ = [
    "Plugins",
    "SL",
    "SV",
    "Service",
    "Trigger",
    "get_plugin_available_prefix",
    "get_plugin_force_prefix",
    "get_plugin_force_prefixs",
    "get_plugin_prefix",
    "get_plugin_prefixs",
    "register_plugins",
]
