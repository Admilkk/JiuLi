"""
gsuid_core.meta_plugins 仿制：元插件（由其他插件动态注册的插件）

真实 GsCore 用它做「插件市场」这类需要动态增删插件的场景。兼容层提供注册表，
import_api 返回一个可用的最小对象。
"""

from typing import Any, Callable, Dict, List, Optional

_meta: List[Any] = []


class MetaPlugin:
    def __init__(self, name: str = "", **kwargs):
        self.name = name
        self.__dict__.update(kwargs)


def meta(name: Optional[str] = None, **kwargs):
    def decorator(cls):
        _meta.append(cls)
        return cls

    return decorator


class _ImportAPI:
    async def import_module(self, *args, **kwargs):
        raise NotImplementedError("JiuLi 的 GsCore 兼容层暂不支持动态导入插件模块")

    async def reload(self, *args, **kwargs):
        return None

    def __getattr__(self, item):
        return None


import_api = _ImportAPI()

__all__ = ["MetaPlugin", "import_api", "meta"]
