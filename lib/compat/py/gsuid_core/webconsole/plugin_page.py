"""gsuid_core.webconsole.plugin_page 仿制：注册插件自定义页面"""

from typing import Any, Callable, Dict, List, Optional

from .mount_app import PageSchema, site

_pages: List[dict] = []


def register_plugin_page(
    plugin_name: str = "",
    page_name: str = "",
    page_path: str = "",
    view: Optional[Callable] = None,
    **kwargs,
):
    def decorator(fn):
        _pages.append({"plugin": plugin_name, "name": page_name, "path": page_path, "view": fn})
        site.register_page(PageSchema(label=page_name, path=page_path))
        return fn

    return decorator(view) if view is not None else decorator


def registered_pages() -> List[dict]:
    return _pages


__all__ = ["registered_pages", "register_plugin_page"]
