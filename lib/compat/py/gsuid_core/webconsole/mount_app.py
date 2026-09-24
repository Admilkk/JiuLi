"""
gsuid_core.webconsole.mount_app 仿制：PageSchema / GsAdminModel / site

真实实现基于 FastAPI-Amis-Admin，会把插件的配置页挂进网页控制台。
兼容层没有控制台，所以这里的注册是**记录型**的：插件 import 与装饰器都不报错，
但控制台页面不会出现。JiuLi 侧可以通过 #诊断 看到这些注册。
"""

from typing import Any, Dict, List, Optional


class PageSchema:
    def __init__(self, label: str = "", icon: str = "", path: str = "", **kwargs):
        self.label = label
        self.icon = icon
        self.path = path
        self.__dict__.update(kwargs)


class GsAdminModel:
    pk_name: str = "id"
    page_schema: Any = None
    model: Any = None


class _Site:
    def __init__(self):
        self.registered: List[Any] = []
        self.pages: List[Any] = []

    def register_admin(self, cls):
        self.registered.append(cls)
        return cls

    def register_page(self, schema):
        self.pages.append(schema)
        return schema

    def __getattr__(self, item):
        return None


site = _Site()

__all__ = ["GsAdminModel", "PageSchema", "site"]
