"""gsuid_core.ai_core.register 仿制：AI 工具/知识库/别名注册（兼容层只记录，不生效）"""

from typing import Any, Callable, Dict, List, Optional

_registered: Dict[str, List[Any]] = {"tools": [], "alias": [], "entity": []}


def ai_tools(func: Optional[Callable] = None, **kwargs):
    def decorator(fn):
        _registered["tools"].append({"fn": fn, **kwargs})
        return fn

    return decorator(func) if func is not None else decorator


def ai_alias(*args, **kwargs):
    def decorator(fn):
        _registered["alias"].append({"fn": fn, "args": args, **kwargs})
        return fn

    return decorator


def ai_entity(*args, **kwargs):
    def decorator(fn):
        _registered["entity"].append({"fn": fn, "args": args, **kwargs})
        return fn

    return decorator


def registered():
    return _registered


__all__ = ["ai_alias", "ai_entity", "ai_tools", "registered"]
