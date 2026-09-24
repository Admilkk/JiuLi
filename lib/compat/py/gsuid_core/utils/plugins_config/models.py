"""
gsuid_core.utils.plugins_config.models 仿制：配置项模型

真实源码有 17 种 Gs*Config（文档只列了 8 种）。这里全部提供，
共同点是都有 `data` 字段 —— 插件拿配置全是 `config.get_config("X")` 然后读 `.data`。
"""

from typing import Any, Dict, List, Optional, Tuple


class GsConfig:
    def __init__(self, title: str = "", desc: str = "", **kwargs):
        self.title = title
        self.desc = desc
        for k, v in kwargs.items():
            setattr(self, k, v)


def _make(name: str, defaults: Dict[str, Any]):
    def __init__(self, data=None, title: str = "", desc: str = "", **kwargs):
        GsConfig.__init__(self, title, desc)
        for key, default in defaults.items():
            setattr(self, key, kwargs.get(key, default))
        self.data = data if data is not None else defaults.get("data")

    return type(name, (GsConfig,), {"__init__": __init__})


GsStrConfig = _make("GsStrConfig", {"data": "", "options": [], "regex": None, "details": None, "secret": False})
GsBoolConfig = _make("GsBoolConfig", {"data": False, "secret": False})
GsDictConfig = _make("GsDictConfig", {"data": {}, "secret": False})
GsListStrConfig = _make("GsListStrConfig", {"data": [], "options": [], "secret": False})
GsListConfig = _make("GsListConfig", {"data": [], "secret": False})
GsIntConfig = _make("GsIntConfig", {"data": 0, "max_value": None, "options": [], "secret": False})
GsFloatConfig = _make("GsFloatConfig", {"data": 0.0, "min_value": None, "max_value": None, "secret": False})
GsImageConfig = _make("GsImageConfig", {"data": "", "upload_to": "", "filename": "", "suffix": "jpg", "secret": False})
GsTimeRConfig = _make("GsTimeRConfig", {"data": (0, 0), "secret": False})
GsDivider = _make("GsDivider", {"data": None})
GsFileUploadConfig = _make(
    "GsFileUploadConfig", {"data": "", "upload_to": "", "filename": "", "suffix": "html", "secret": False}
)
GsFilesUploadConfig = _make("GsFilesUploadConfig", {"data": "", "suffix": "html", "secret": False})
GsDateConfig = _make("GsDateConfig", {"data": None, "secret": False})
GsTimeRangeConfig = _make("GsTimeRangeConfig", {"data": ((0, 0), (0, 0)), "secret": False})
GsColorConfig = _make("GsColorConfig", {"data": "#ffffff"})
GsRepeatGroupConfig = _make("GsRepeatGroupConfig", {"data": [], "template": {}, "secret": False})
GsTimeConfig = _make("GsTimeConfig", {"data": "", "secret": False})

GSC = GsConfig

__all__ = [
    "GSC",
    "GsBoolConfig",
    "GsColorConfig",
    "GsConfig",
    "GsDateConfig",
    "GsDictConfig",
    "GsDivider",
    "GsFileUploadConfig",
    "GsFilesUploadConfig",
    "GsFloatConfig",
    "GsImageConfig",
    "GsIntConfig",
    "GsListConfig",
    "GsListStrConfig",
    "GsRepeatGroupConfig",
    "GsStrConfig",
    "GsTimeConfig",
    "GsTimeRConfig",
    "GsTimeRangeConfig",
]
