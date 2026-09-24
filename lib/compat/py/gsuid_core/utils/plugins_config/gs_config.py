"""
gsuid_core.utils.plugins_config.gs_config 仿制：StringConfig（插件自定义配置）

真实行为：把插件声明的配置项读写到 `data/<插件名>/config.json`。
这里照做，于是插件的配置能真正持久化，用户改 JSON 也生效。
"""

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from .models import GSC

_repaired: set = set()


class StringConfig:
    all_config_list: Dict[str, "StringConfig"] = {}

    def __init__(
        self,
        config_name: str,
        CONFIG_PATH: Union[Path, List[Path]],
        config_list: Dict[str, GSC],
    ) -> None:
        self.config_name = config_name
        if isinstance(CONFIG_PATH, (list, tuple)):
            self.path = Path(CONFIG_PATH[0])
        else:
            self.path = Path(CONFIG_PATH)
        self.config_list: Dict[str, GSC] = config_list
        self.raw: Dict[str, Any] = {}
        self.load_config()
        StringConfig.all_config_list[config_name] = self

    # 读写

    def load_config(self) -> None:
        raw: Dict[str, Any] = {}
        try:
            if self.path.exists():
                raw = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            raw = {}
        self.raw = raw if isinstance(raw, dict) else {}
        # 新配置项用默认值补齐
        for key, item in self.config_list.items():
            if key not in self.raw:
                self.raw[key] = item.data

    def write_config(self) -> bool:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.raw, ensure_ascii=False, indent=2), encoding="utf-8")
            return True
        except Exception:
            return False

    def get_config(self, key: str, default_value: Any = None) -> Any:
        if key in self.raw:
            return self.raw[key]
        if key in self.config_list:
            return self.config_list[key].data
        return default_value

    def set_config(self, key: str, value: Any) -> bool:
        item = self.config_list.get(key)
        # 真实源码会强校验类型一致，这里保持一致以免插件写出脏数据
        if item is not None and not isinstance(value, type(item.data)) and item.data is not None:
            return False
        self.raw[key] = value
        return self.write_config()

    def get_raw_config(self) -> Dict[str, Any]:
        return self.raw

    def sort_config(self) -> None:
        order = list(self.config_list.keys())
        self.raw = {k: self.raw[k] for k in order if k in self.raw} | {
            k: v for k, v in self.raw.items() if k not in order
        }

    def repair_config(self) -> None:
        self.load_config()

    def update_config(self, key: str, value: Any) -> bool:
        return self.set_config(key, value)

    def migrate_from(self, *args, **kwargs) -> None:
        return None


# core 配置：真实源码里 masters / superusers / command_start 都在这里
from .models import GsBoolConfig, GsIntConfig, GsListStrConfig, GsStrConfig  # noqa: E402

core_config = StringConfig(
    "core",
    Path("data/config.json"),
    {
        "masters": GsListStrConfig(data=[], title="主人QQ", desc="可执行全部指令"),
        "superusers": GsListStrConfig(data=[], title="超级用户", desc=""),
        "command_start": GsListStrConfig(data=[], title="命令前缀", desc=""),
        "TRUSTED_IPS": GsListStrConfig(data=["localhost", "::1", "127.0.0.1"], title="信任 IP"),
        "misfire_grace_time": GsIntConfig(data=60, title="任务容错时间"),
        "EnableForwardMessage": GsBoolConfig(data=True, title="是否启用合并转发"),
    },
)

__all__ = ["ConfigSetManager"]


class ConfigSetManager:  # 真实源码里的 ABC，兼容层给最小实现
    def get_config(self, *args, **kwargs):
        return None

    def list_available(self):
        return []

    def get_all_configs(self):
        return []

    def exists(self, *args, **kwargs) -> bool:
        return False

    def create_default(self, *args, **kwargs) -> None:
        return None

    def delete(self, *args, **kwargs) -> None:
        return None

    def clear_cache(self) -> None:
        return None
