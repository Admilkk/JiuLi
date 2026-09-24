"""
Star / Context / StarTools 仿制（内部实现）

对应真实源码 astrbot/core/star/{star,context,star_tools,star_manager}.py。
**没有** 复刻 star_manager 的全部行为，但保留了兼容层最关键的语义：
  - Star.__init_subclass__ 自动注册（按 cls.__module__ 索引）
  - 实例化签名探测：有 config 先试 cls(context, config)，TypeError 回退 cls(context)
  - handler 用 functools.partial 二次绑定，且**幂等**（先还原 raw 再绑）
  - StarTools 必须先 initialize，否则 send_message 抛错（与真实源码一致）
"""

import functools
import inspect
import importlib
import importlib.util
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from ._filter import EventType, star_handlers_registry
from ._message import (
    AstrBotMessage,
    MessageChain,
    MessageSession,
    PlatformMetadata,
)

# 注册表


@dataclass
class StarMetadata:
    name: str = ""
    author: str = ""
    desc: str = ""
    version: str = ""
    repo: str = ""
    module_path: str = ""
    star_cls: Any = None
    cls: Any = None
    instance: Any = None
    activated: bool = False
    display_name: str = ""
    short_desc: str = ""
    support_platforms: List[str] = field(default_factory=list)
    astrbot_version: str = ""
    directory: str = ""
    _bound: bool = False


star_registry: List[StarMetadata] = []
star_map: Dict[str, StarMetadata] = {}


# Star


class _PluginLogger:
    def __init__(self, name: str):
        self.name = name

    def _emit(self, level, msg, *args):
        text = str(msg)
        if args:
            try:
                text = text % args if "%" in text else text.format(*args)
            except Exception:
                pass
        import sys

        sys.stderr.write(f"[{self.name}] {text}\n")
        sys.stderr.flush()

    def info(self, msg, *a):
        self._emit("info", msg, *a)

    def warning(self, msg, *a):
        self._emit("warning", msg, *a)

    warn = warning

    def error(self, msg, *a):
        self._emit("error", msg, *a)

    def debug(self, msg, *a):
        self._emit("debug", msg, *a)

    def critical(self, msg, *a):
        self._emit("critical", msg, *a)

    def exception(self, msg, *a):
        import traceback

        self._emit("error", f"{msg}\n{traceback.format_exc()}")


class Star:
    """所有插件（Star）的父类"""

    author: str = ""
    name: str = ""
    plugin_id: str = ""
    context: Any = None
    logger: Any = None

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        module_path = getattr(cls, "__module__", "")
        metadata = star_map.get(module_path)
        if metadata is None:
            metadata = StarMetadata(module_path=module_path)
            star_map[module_path] = metadata
            star_registry.append(metadata)
        metadata.star_cls = cls
        metadata.cls = cls
        if not metadata.name:
            metadata.name = cls.__name__
        if not metadata.author:
            metadata.author = getattr(cls, "author", "") or "unknown"

    def __init__(self, context: Any, config: Optional[dict] = None) -> None:
        self.context = context
        self.config = config
        self.logger = _PluginLogger(getattr(type(self), "name", type(self).__name__))

    async def initialize(self) -> None:
        return None

    async def terminate(self) -> None:
        return None

    # 常用能力

    async def text_to_image(self, text: str, return_url: bool = True) -> str:
        """兼容层没有文转图服务，返回 False 让插件自己降级"""
        return False  # type: ignore[return-value]

    async def html_render(self, tmpl: str, data: dict, return_url: bool = True, options: Optional[dict] = None) -> str:
        return False  # type: ignore[return-value]

    # 插件 KV 存储（真实源码来自 PluginKVStoreMixin）
    def get_kv_data(self, key: str, default: Any = None) -> Any:
        import json

        path = Path("data/plugin_data") / (self.plugin_id or self.name or "star") / "kv.json"
        try:
            return json.loads(path.read_text(encoding="utf-8")).get(key, default)
        except Exception:
            return default

    def put_kv_data(self, key: str, value: Any) -> bool:
        import json

        path = Path("data/plugin_data") / (self.plugin_id or self.name or "star") / "kv.json"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        except Exception:
            data = {}
        data[key] = value
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return True

    delete_kv_data = put_kv_data


def register(name=None, author=None, desc=None, version=None, repo=None):
    """
    已废弃的注册装饰器（真实源码 v3.5.19 后靠 __init_subclass__ 自动注册）。
    兼容层保留它，因为老插件仍在用；metadata.yaml 会逐字段覆盖这里写的值。
    """

    def decorator(cls):
        cls.name = name or cls.__name__
        cls.author = author or getattr(cls, "author", "")
        if desc:
            cls.__desc__ = desc
        if version:
            cls.__version__ = version
        if repo:
            cls.__repo__ = repo
        return cls

    return decorator


# StarTools


class StarTools:
    _context: Any = None

    @classmethod
    def initialize(cls, context):
        cls._context = context

    @classmethod
    def get_data_dir(cls, plugin_name: str = "") -> Path:
        name = plugin_name or "default"
        path = Path("data/plugin_data") / name
        path.mkdir(parents=True, exist_ok=True)
        return path

    @classmethod
    async def send_message(cls, session, message_chain: MessageChain) -> bool:
        if cls._context is None:
            raise ValueError("StarTools not initialized")
        return await cls._context.send_message(session, message_chain)

    @classmethod
    async def create_message(cls, type: str = "", self_id: str = "", session_id: str = "",
                             sender=None, message=None, message_str: str = "",
                             message_id: str = "", raw_message=None, group_id: str = "") -> AstrBotMessage:
        from ._message import Group, MessageMember, MessageType

        msg = AstrBotMessage()
        msg.type = MessageType.GROUP_MESSAGE if group_id else MessageType.FRIEND_MESSAGE
        msg.self_id = self_id
        msg.session_id = session_id
        msg.message_id = message_id
        msg.sender = sender or MessageMember()
        msg.message = message or []
        msg.message_str = message_str
        msg.raw_message = raw_message
        if group_id:
            msg.group = Group(group_id=group_id)
        return msg

    @classmethod
    async def get_data_dir_async(cls, plugin_name: str = "") -> Path:
        return cls.get_data_dir(plugin_name)


# Context


class _AstrBotConfig(dict):
    """AstrBotConfig：真实源码是 pydantic 模型 + dict 行为"""

    def __init__(self, data: Optional[dict] = None):
        super().__init__(data or {})

    def save_config(self) -> bool:
        return True

    def get(self, key, default=None):
        return super().get(key, default)


class Context:
    def __init__(self, bridge=None, config: Optional[dict] = None):
        self._bridge = bridge
        self._config = _AstrBotConfig(config or {})
        self.provider_manager = None
        self.platform_manager = None
        self.conversation_manager = None
        self.message_history_manager = None
        self.persona_manager = None
        self.astrbot_config_mgr = None
        self.kb_manager = None
        self.cron_manager = None
        self.subagent_orchestrator = None
        self._event_queue = None
        self._web_apis: List[dict] = []

    # 插件/平台

    def get_all_stars(self) -> List[StarMetadata]:
        return list(star_registry)

    def get_registered_star(self, star_name: str) -> Optional[StarMetadata]:
        for meta in star_registry:
            if meta.name == star_name:
                return meta
        return None

    def get_platform_inst(self, platform_id: str):
        return _PlatformProxy(self._bridge, platform_id) if self._bridge else None

    def get_platform(self, platform_type):
        return self.get_platform_inst("jiuli")

    def get_event_queue(self):
        return self._event_queue

    # 配置

    def get_config(self, umo: Optional[str] = None) -> _AstrBotConfig:
        return self._config

    def get_db(self):
        raise NotImplementedError("JiuLi 的 AstrBot 兼容层没有数据库服务（插件请用自己目录下的文件存储）")

    # 发送

    async def send_message(self, session, message_chain: MessageChain) -> bool:
        """主动消息：umo → JiuLi 目标"""
        if self._bridge is None:
            return False
        if isinstance(session, str):
            session = MessageSession.from_str(session)
        target = {
            "selfId": getattr(session, "platform_name", "") or "jiuli",
            "isGroup": session.message_type.value == "GroupMessage",
            "channelId": session.session_id,
        }
        elements = _chain_to_elements(message_chain)
        if not elements:
            return True
        self._bridge.send(elements, target=target)
        return True

    # LLM（兼容层不接模型）

    async def get_current_chat_provider_id(self, umo: str = "") -> str:
        raise NotImplementedError("JiuLi 的 AstrBot 兼容层没有配置 LLM Provider")

    def get_using_provider(self, umo: Optional[str] = None):
        return None

    async def get_using_provider_async(self, umo: Optional[str] = None):
        return None

    def get_provider_by_id(self, provider_id: str):
        return None

    def get_all_providers(self) -> list:
        return []

    async def llm_generate(self, **kwargs):
        raise NotImplementedError("JiuLi 的 AstrBot 兼容层没有 LLM Provider，请在 JiuLi 侧配置模型后由宿主代理")

    async def tool_loop_agent(self, **kwargs):
        raise NotImplementedError("JiuLi 的 AstrBot 兼容层没有 Agent 执行器")

    # LLM 工具 / Web API

    def get_llm_tool_manager(self):
        return None

    def add_llm_tools(self, *tools) -> None:
        return None

    async def activate_llm_tool_async(self, name: str) -> bool:
        return False

    async def deactivate_llm_tool_async(self, name: str) -> bool:
        return False

    activate_llm_tool = activate_llm_tool_async
    deactivate_llm_tool = deactivate_llm_tool_async

    def register_web_api(self, route, view_handler, methods, desc) -> None:
        self._web_apis.append({"route": route, "methods": methods, "desc": desc})
        if self._bridge:
            self._bridge.log("warn", f"插件注册了 Web API {route}，JiuLi 兼容层暂未把 Web 请求转发给插件")

    def register_task(self, task, desc: str = "") -> None:
        import asyncio

        try:
            asyncio.create_task(task)  # type: ignore[arg-type]
        except Exception:
            pass

    def register_provider(self, provider) -> None:
        return None


class _PlatformProxy:
    """get_platform_inst 的返回值：只实现发消息，其它动作明确报错"""

    def __init__(self, bridge, platform_id: str):
        self._bridge = bridge
        self._platform_id = platform_id

    def meta(self) -> PlatformMetadata:
        return PlatformMetadata(id=self._platform_id)

    async def send_by_session(self, session, message_chain) -> None:
        elements = _chain_to_elements(message_chain)
        if elements:
            self._bridge.send(
                elements,
                target={
                    "selfId": self._platform_id,
                    "isGroup": session.message_type.value == "GroupMessage",
                    "channelId": session.session_id,
                },
            )

    async def send_by_session_str(self, umo: str, message_chain) -> None:
        await self.send_by_session(MessageSession.from_str(umo), message_chain)

    def __getattr__(self, item):
        raise NotImplementedError(f"JiuLi 的 AstrBot 兼容层未实现 Platform.{item}()")


def _chain_to_elements(chain) -> list:
    from ._event import chain_to_elements

    return chain_to_elements(chain)


# 加载器


def _read_metadata(plugin_dir: Path) -> Dict[str, Any]:
    for name in ("metadata.yaml", "metadata.yml"):
        path = plugin_dir / name
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        try:
            import yaml

            data = yaml.safe_load(text) or {}
            if isinstance(data, dict):
                return data
        except Exception:
            # 没装 pyyaml 时退化成极简解析（只认 key: value）
            out: Dict[str, Any] = {}
            for line in text.splitlines():
                if ":" in line and not line.strip().startswith("#"):
                    k, _, v = line.partition(":")
                    out[k.strip()] = v.strip().strip('"').strip("'")
            return out
    return {}


def _instantiate(cls, context: Context, config: Optional[_AstrBotConfig]):
    """实例化签名探测：有 schema 时先试带 config，TypeError 再退回来"""
    if config is not None:
        try:
            return cls(context=context, config=config)
        except TypeError:
            pass
    try:
        return cls(context=context)
    except TypeError:
        return cls(context)


def _rebind_handlers(instance, module_path: str) -> None:
    """幂等二次绑定：先还原 raw，再绑当前实例"""
    for entry in star_handlers_registry:
        if entry.handler_module_path != module_path:
            continue
        raw = entry.raw_handler or (entry.handler if not hasattr(entry.handler, "func") else entry.handler.func)
        entry.raw_handler = raw
        entry.handler = functools.partial(raw, instance)


def load_plugin(plugin_dir: Path, context: Context) -> Optional[StarMetadata]:
    """加载单个插件目录：main.py 或 <dir>.py"""
    main = plugin_dir / "main.py"
    if not main.exists():
        alt = plugin_dir / f"{plugin_dir.name}.py"
        if alt.exists():
            main = alt
        else:
            return None

    module_path = f"astrbot_plugins.{plugin_dir.name}.main"
    spec = importlib.util.spec_from_file_location(module_path, main)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法为 {main} 建立模块 spec")
    module = importlib.util.module_from_spec(spec)
    import sys

    sys.modules[module_path] = module
    spec.loader.exec_module(module)

    metadata = star_map.get(module_path)
    if metadata is None or metadata.star_cls is None:
        # 兜底：模块里直接找 Star 子类（模块名不一致时）
        for value in vars(module).values():
            if inspect.isclass(value) and issubclass(value, Star) and value is not Star:
                metadata = star_map.get(value.__module__)
                break
    if metadata is None or metadata.star_cls is None:
        raise RuntimeError("没有找到继承自 Star 的插件类")

    # metadata.yaml 逐字段覆盖
    yam = _read_metadata(plugin_dir)
    for key in ("name", "author", "desc", "version", "repo", "display_name", "short_desc", "astrbot_version"):
        if yam.get(key):
            setattr(metadata, key, yam[key])
    if not metadata.desc and yam.get("description"):
        metadata.desc = yam["description"]
    metadata.support_platforms = yam.get("support_platforms") or []
    metadata.directory = str(plugin_dir)

    # 配置
    config = None
    schema_file = plugin_dir / "_conf_schema.json"
    if schema_file.exists():
        import json

        try:
            schema = json.loads(schema_file.read_text(encoding="utf-8"))
        except Exception:
            schema = {}
        config = _AstrBotConfig({k: v.get("default") for k, v in schema.items() if isinstance(v, dict)})

    # 实例化 + 注入类属性
    cls = metadata.star_cls
    cls.name = metadata.name or cls.__name__
    cls.author = metadata.author or "unknown"
    cls.plugin_id = f"{str(cls.author).lower()}/{str(cls.name).lower()}"
    instance = _instantiate(cls, context, config)
    metadata.instance = instance
    metadata.activated = True
    _rebind_handlers(instance, module_path)
    return metadata


def load_plugins(plugin_dir: Path, context: Context, bridge=None) -> List[str]:
    """扫描目录下所有含 main.py 的子目录"""
    loaded: List[str] = []
    if not plugin_dir.exists():
        return loaded
    for entry in sorted(os.listdir(plugin_dir)):
        full = plugin_dir / entry
        if entry.startswith((".", "_")) or not full.is_dir():
            continue
        try:
            meta = load_plugin(full, context)
            if meta:
                loaded.append(meta.name or entry)
                if bridge:
                    bridge.log("info", f"已加载 AstrBot 插件 {meta.name or entry} v{meta.version or '?'}")
        except Exception:
            import traceback

            if bridge:
                bridge.log("error", f"AstrBot 插件 {entry} 加载失败：\n{traceback.format_exc()}")
    return loaded


async def call_initialize(meta: StarMetadata) -> None:
    instance = meta.instance
    if instance is not None and hasattr(instance, "initialize"):
        ret = instance.initialize()
        if hasattr(ret, "__await__"):
            await ret


__all__ = [
    "Context",
    "Star",
    "StarMetadata",
    "StarTools",
    "register",
    "star_map",
    "star_registry",
]
