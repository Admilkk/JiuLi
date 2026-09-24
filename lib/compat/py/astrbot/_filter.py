"""
AstrBot 过滤器与注册器仿制（内部实现）

对应真实源码：
  astrbot/core/star/register/star_handler.py   （全部注册器）
  astrbot/core/star/filter/*.py                （HandlerFilter 与各内置 filter）
  astrbot/core/star/filter/{event_message_type,platform_adapter_type,permission,command,regex}.py

关键语义（照抄真实源码，文档里有出入的地方以源码为准）：
  - 多个装饰器是 AND，全部通过才执行。
  - EventMessageType 是 enum.Flag，且有文档漏掉的 OTHER_MESSAGE。
  - PermissionType.ADMIN 只看 event.role == "admin"（这个字符串由派发方写入）。
  - RegexFilter 不受唤醒词约束；CommandFilter 要求 is_at_or_wake_command。
  - priority 存在 extras_configs 里，升序执行（越大越靠后）。
"""

import enum
import inspect
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from ._message import MessageType


# ==================== 事件类型 ====================


class EventType(enum.Enum):
    """真实 AstrBot 里定义了 16 个；这里保留同名成员，兼容层实际实现★标注的"""

    OnAstrBotLoadedEvent = enum.auto()
    OnPlatformLoadedEvent = enum.auto()
    AdapterMessageEvent = enum.auto()
    OnDecoratingResultEvent = enum.auto()
    OnCallingFuncToolEvent = enum.auto()  # ★ llm_tool
    OnLLMRequestEvent = enum.auto()
    OnLLMResponseEvent = enum.auto()
    OnWaitingLLMRequestEvent = enum.auto()
    OnAgentBeginEvent = enum.auto()
    OnAgentDoneEvent = enum.auto()
    OnUsingLLMToolEvent = enum.auto()
    OnLLMToolRespondEvent = enum.auto()
    AfterMessageSentEvent = enum.auto()
    OnPluginLoadedEvent = enum.auto()
    OnPluginUnloadedEvent = enum.auto()
    OnPluginErrorEvent = enum.auto()


class EventMessageType(enum.Flag):
    GROUP_MESSAGE = enum.auto()
    PRIVATE_MESSAGE = enum.auto()
    OTHER_MESSAGE = enum.auto()
    ALL = GROUP_MESSAGE | PRIVATE_MESSAGE | OTHER_MESSAGE


MESSAGE_TYPE_2_EVENT_MESSAGE_TYPE = {
    MessageType.GROUP_MESSAGE: EventMessageType.GROUP_MESSAGE,
    MessageType.FRIEND_MESSAGE: EventMessageType.PRIVATE_MESSAGE,
    MessageType.OTHER_MESSAGE: EventMessageType.OTHER_MESSAGE,
}


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
    ALL = enum.auto()  # 真实源码里是独立 auto()，不是按位或


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


class PermissionType(enum.Flag):
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


# ==================== 参数解析辅助 ====================


class GreedyStr(str):
    """必须是最后一个参数，吃掉剩余全部文本"""


class _ParamError(ValueError):
    pass


def unwrap_optional(annotation):
    """Optional[T] / T|None → (T, True)"""
    import typing

    origin = typing.get_origin(annotation)
    if origin is typing.Union:
        args = [a for a in typing.get_args(annotation) if a is not type(None)]
        if len(args) == 1:
            return args[0], True
        return annotation, True
    return annotation, False


def _convert(value: str, annotation):
    if annotation is inspect.Parameter.empty or annotation is Any or annotation is str:
        return value
    if annotation is GreedyStr:
        return GreedyStr(value)
    if annotation is bool:
        low = value.strip().lower()
        if low in ("true", "yes", "1"):
            return True
        if low in ("false", "no", "0"):
            return False
        raise _ParamError(f"参数 {value!r} 不是布尔值")
    try:
        return annotation(value)
    except Exception as err:
        raise _ParamError(f"参数 {value!r} 无法转换为 {getattr(annotation, '__name__', annotation)}：{err}")


class HandlerFilter:
    """真实源码是 abc.ABC，唯一方法 filter(event, cfg) -> bool；插件会继承它写自定义 filter"""

    def filter(self, event, cfg) -> bool:
        return True


class EventMessageTypeFilter(HandlerFilter):
    def __init__(self, event_message_type: EventMessageType):
        self.event_message_type = event_message_type

    def filter(self, event, cfg) -> bool:
        message_type = event.get_message_type()
        mapped = MESSAGE_TYPE_2_EVENT_MESSAGE_TYPE.get(message_type)
        if mapped is None:
            return False
        return bool(mapped & self.event_message_type)


class PlatformAdapterTypeFilter(HandlerFilter):
    def __init__(self, platform_adapter_type):
        if isinstance(platform_adapter_type, str):
            platform_adapter_type = ADAPTER_NAME_2_TYPE.get(platform_adapter_type)
        self.platform_type = platform_adapter_type

    def filter(self, event, cfg) -> bool:
        if self.platform_type is None:
            return False
        if self.platform_type & PlatformAdapterType.ALL:
            return True
        mapped = ADAPTER_NAME_2_TYPE.get(event.get_platform_name())
        if mapped is None:
            return False
        return bool(mapped & self.platform_type)


class PermissionTypeFilter(HandlerFilter):
    def __init__(self, permission_type: PermissionType, raise_error: bool = True):
        self.permission_type = permission_type
        self.raise_error = raise_error

    def filter(self, event, cfg) -> bool:
        # 语义与真实源码逐行一致
        if self.permission_type == PermissionType.ADMIN or (
            self.permission_type == PermissionType.GROUP_ADMIN and event.get_group_id()
        ):
            return event.is_admin()
        if self.permission_type == PermissionType.SHARED_GROUP_ADMIN and event.get_group_id():
            return event.is_admin() or bool(event.get_extra("_session_isolated", False))
        return True


class RegexFilter(HandlerFilter):
    def __init__(self, regex):
        self.regex = re.compile(regex) if isinstance(regex, str) else regex

    def filter(self, event, cfg) -> bool:
        """真实源码注释：正则过滤器不受 wake_prefix 制约"""
        return bool(self.regex.search(event.get_message_str().strip()))


class CommandFilter(HandlerFilter):
    def __init__(self, command_name: str, parent_names: Optional[List[str]] = None, alias: Optional[set] = None):
        self.command_name = command_name
        self.parent_names = parent_names or []
        self.alias = alias or set()
        self.handler_params: List[tuple] = []
        self.custom_filters: List[Callable] = []

    def get_complete_command_names(self) -> List[str]:
        base = " ".join([*self.parent_names, self.command_name]).strip()
        names = [base]
        for a in self.alias:
            names.append(" ".join([*self.parent_names, str(a)]).strip())
        return names

    def equals(self, message_str: str) -> bool:
        return message_str in self.get_complete_command_names()

    def add_custom_filter(self, fn: Callable):
        self.custom_filters.append(fn)

    def custom_filter_ok(self, event, cfg) -> bool:
        for fn in self.custom_filters:
            try:
                if not fn(event, cfg):
                    return False
            except Exception:
                return False
        return True

    def validate_and_convert_params(self, params: List[str], handler_params: List[tuple]) -> List[Any]:
        result: List[Any] = []
        index = 0
        for name, annotation, default, is_greedy in handler_params:
            if is_greedy and index < len(params):
                result.append(_convert(" ".join(params[index:]), GreedyStr))
                index = len(params)
                continue
            if index < len(params):
                result.append(_convert(params[index], annotation))
                index += 1
            elif default is not inspect.Parameter.empty:
                result.append(default)
            else:
                raise _ParamError(f"必要参数缺失。该指令完整参数: {name}")
        return result

    def filter(self, event, cfg) -> bool:
        if not event.is_at_or_wake_command:
            return False
        if not self.custom_filter_ok(event, cfg):
            return False
        message_str = re.sub(r"\s+", " ", event.get_message_str().strip())
        ok = False
        for full_cmd in self.get_complete_command_names():
            if message_str.startswith(f"{full_cmd} ") or message_str == full_cmd:
                ok = True
                message_str = message_str[len(full_cmd):].strip()
                break
        if not ok:
            return False
        params = [p for p in message_str.split(" ") if p]
        try:
            parsed = self.validate_and_convert_params(params, self.handler_params)
        except _ParamError:
            raise
        event.set_extra("parsed_params", parsed)
        return True


# ==================== handler 注册表 ====================


@dataclass
class StarHandlerMetadata:
    event_type: EventType
    handler_full_name: str
    handler_name: str
    handler_module_path: str
    handler: Callable
    event_filters: List[HandlerFilter] = field(default_factory=list)
    desc: str = ""
    extras_configs: Dict[str, Any] = field(default_factory=dict)
    enabled: bool = True
    raw_handler: Optional[Callable] = None

    def __lt__(self, other):
        return self.extras_configs.get("priority", 0) < other.extras_configs.get("priority", 0)


star_handlers_registry: List[StarHandlerMetadata] = []


def _handler_params_of(func: Callable) -> List[tuple]:
    """跳过 self / event，返回 [(name, annotation, default, is_greedy)]"""
    try:
        sig = inspect.signature(func)
    except (TypeError, ValueError):
        return []
    params = list(sig.parameters.values())[2:]
    out = []
    for p in params:
        annotation, _ = unwrap_optional(p.annotation)
        out.append((p.name, annotation, p.default, annotation is GreedyStr))
    return out


def _register(func: Callable, event_type: EventType, filters: List[HandlerFilter], kwargs: Dict[str, Any]):
    """
    注册 handler。

    一个函数上可以叠多个装饰器（`@filter.permission_type` + `@filter.command`），
    真实 AstrBot 是**累加**到同一个 handler 的 event_filters（AND 语义），
    所以这里对同一个函数对象做 merge；重载时函数对象是新的，则整体替换（保证幂等）。
    """
    extras = dict(kwargs)
    desc = extras.pop("desc", None) or (inspect.getdoc(func) or "").split("\n")[0]
    full_name = f"{func.__module__}_{func.__name__}"

    existing = next((h for h in star_handlers_registry if h.handler_full_name == full_name), None)
    if existing is not None and existing.raw_handler is func:
        existing.event_filters.extend(filters)
        existing.extras_configs.update(extras)
        if desc and not existing.desc:
            existing.desc = desc
        return func

    entry = StarHandlerMetadata(
        event_type=event_type,
        handler_full_name=full_name,
        handler_name=func.__name__,
        handler_module_path=func.__module__,
        handler=func,
        raw_handler=func,
        event_filters=list(filters),
        desc=desc,
        extras_configs=extras,
    )
    star_handlers_registry[:] = [h for h in star_handlers_registry if h.handler_full_name != full_name]
    star_handlers_registry.append(entry)
    return func


# ==================== 注册器（filter.*） ====================


def command(command_name: Optional[str] = None, sub_command: Optional[str] = None, alias: Optional[set] = None, **kwargs):
    def decorator(func):
        cf = CommandFilter(command_name or func.__name__, [sub_command] if sub_command else [], alias)
        cf.handler_params = _handler_params_of(func)
        return _register(func, EventType.AdapterMessageEvent, [cf], kwargs)

    return decorator


class RegisteringCommandable:
    """filter.command_group 的返回值：既可当装饰器，又能级联 .command / .group"""

    def __init__(self, parent_names: List[str], alias: Optional[set] = None):
        self.parent_names = parent_names
        self.alias = alias

    def __call__(self, func):
        self.parent_names = self.parent_names or [func.__name__]
        return self

    def _child(self, name: str, alias: Optional[set], event_type=EventType.AdapterMessageEvent):
        def decorator(func):
            cf = CommandFilter(name, list(self.parent_names), alias)
            cf.handler_params = _handler_params_of(func)
            return _register(func, event_type, [cf], {})

        return decorator

    def command(self, command_name: Optional[str] = None, alias: Optional[set] = None, **kwargs):
        name = command_name or ""

        def decorator(func):
            cf = CommandFilter(name or func.__name__, list(self.parent_names), alias)
            cf.handler_params = _handler_params_of(func)
            return _register(func, EventType.AdapterMessageEvent, [cf], kwargs)

        return decorator

    def group(self, name: Optional[str] = None, alias: Optional[set] = None, **kwargs):
        return RegisteringCommandable([*self.parent_names, name or ""], alias)

    def custom_filter(self, *args, **kwargs):
        return None


def command_group(command_group_name: Optional[str] = None, sub_command: Optional[str] = None, alias: Optional[set] = None, **kwargs):
    return RegisteringCommandable([command_group_name] if command_group_name else [], alias)


def event_message_type(event_message_type: EventMessageType, **kwargs):
    def decorator(func):
        return _register(func, EventType.AdapterMessageEvent, [EventMessageTypeFilter(event_message_type)], kwargs)

    return decorator


def platform_adapter_type(platform_adapter_type, **kwargs):
    def decorator(func):
        return _register(func, EventType.AdapterMessageEvent, [PlatformAdapterTypeFilter(platform_adapter_type)], kwargs)

    return decorator


def regex(regex: Any, **kwargs):
    def decorator(func):
        return _register(func, EventType.AdapterMessageEvent, [RegexFilter(regex)], kwargs)

    return decorator


def permission_type(permission_type: PermissionType, raise_error: bool = True, **kwargs):
    def decorator(func):
        return _register(
            func, EventType.AdapterMessageEvent, [PermissionTypeFilter(permission_type, raise_error)], kwargs
        )

    return decorator


def custom_filter(custom_type_filter, *args, **kwargs):
    raise_error = args[0] if args else kwargs.pop("raise_error", True)

    def decorator(func):
        return _register(func, EventType.AdapterMessageEvent, [custom_type_filter], kwargs)

    return decorator


def _hook_decorator(event_type: EventType):
    def outer(**kwargs):
        def decorator(func):
            return _register(func, event_type, [], kwargs)

        return decorator

    return outer


llm_tool = _hook_decorator(EventType.OnCallingFuncToolEvent)
on_astrbot_loaded = _hook_decorator(EventType.OnAstrBotLoadedEvent)
on_platform_loaded = _hook_decorator(EventType.OnPlatformLoadedEvent)
on_waiting_llm_request = _hook_decorator(EventType.OnWaitingLLMRequestEvent)
on_llm_request = _hook_decorator(EventType.OnLLMRequestEvent)
on_llm_response = _hook_decorator(EventType.OnLLMResponseEvent)
on_agent_begin = _hook_decorator(EventType.OnAgentBeginEvent)
on_agent_done = _hook_decorator(EventType.OnAgentDoneEvent)
on_using_llm_tool = _hook_decorator(EventType.OnUsingLLMToolEvent)
on_llm_tool_respond = _hook_decorator(EventType.OnLLMToolRespondEvent)
on_decorating_result = _hook_decorator(EventType.OnDecoratingResultEvent)
after_message_sent = _hook_decorator(EventType.AfterMessageSentEvent)
on_plugin_loaded = _hook_decorator(EventType.OnPluginLoadedEvent)
on_plugin_unloaded = _hook_decorator(EventType.OnPluginUnloadedEvent)
on_plugin_error = _hook_decorator(EventType.OnPluginErrorEvent)
