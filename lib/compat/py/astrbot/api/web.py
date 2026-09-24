"""astrbot.api.web 仿制：插件 Pages 后端（兼容层不提供 Web 框架，注册即记录）"""

from typing import Any, Callable, List

_routes: List[dict] = []


class PluginPage:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def register_web_api(route: str = "", methods: Optional[List[str]] = None, desc: str = ""):
    def decorator(func):
        _routes.append({"route": route, "methods": methods or ["GET"], "desc": desc, "handler": func})
        return func

    return decorator


def registered_routes() -> List[dict]:
    return _routes


__all__ = ["PluginPage", "register_web_api", "registered_routes"]
