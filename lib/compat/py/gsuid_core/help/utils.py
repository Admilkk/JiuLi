"""
gsuid_core.help.utils 仿制：register_help

真实作用是把插件的帮助条目与图标交给 Core 生成帮助图。兼容层没有帮助图渲染，
但**必须**让这个 import 时副作用不报错（真实插件在模块顶层就调用它）。
"""

from typing import Any, List, Optional

_help_registry: List[dict] = []


class PluginHelp:
    def __init__(self, name: str = "", help: str = "", icon: Any = None, **kwargs):
        self.name = name
        self.help = help
        self.icon = icon
        self.__dict__.update(kwargs)


class PluginSV:
    def __init__(self, name: str = "", help: str = "", **kwargs):
        self.name = name
        self.help = help
        self.__dict__.update(kwargs)


def register_help(name: str, help: str = "", icon: Any = None) -> None:
    _help_registry.append({"name": name, "help": help, "icon": icon})


def registered_help() -> List[dict]:
    return _help_registry


__all__ = ["PluginHelp", "PluginSV", "register_help", "registered_help"]
