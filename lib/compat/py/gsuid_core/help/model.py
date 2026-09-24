"""gsuid_core.help.model 仿制：帮助数据结构"""

from typing import Any, Dict, List, Optional

from .utils import PluginHelp, PluginSV


class HelpModel:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class PluginHelpList:
    def __init__(self, data: Optional[List[PluginHelp]] = None):
        self.data = data or []


__all__ = ["HelpModel", "PluginHelp", "PluginHelpList", "PluginSV"]
