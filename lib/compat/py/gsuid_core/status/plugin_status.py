"""gsuid_core.status.plugin_status 仿制：插件状态上报（兼容层只记录）"""

from typing import Any, Callable, Dict, List

_status: List[Dict[str, Any]] = []


def register_status(name: str = "", func: Callable = None, **kwargs):
    def decorator(fn):
        _status.append({"name": name, "func": fn, **kwargs})
        return fn

    return decorator(func) if func is not None else decorator


def registered() -> List[Dict[str, Any]]:
    return _status


__all__ = ["register_status", "registered"]
