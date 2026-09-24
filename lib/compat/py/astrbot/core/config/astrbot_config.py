"""astrbot.core.config.astrbot_config 仿制：AstrBotConfig（真实插件直接 import 它）"""

from ..._star import _AstrBotConfig as AstrBotConfig  # noqa: F401

VERSION = "4.28.1"

__all__ = ["AstrBotConfig", "VERSION"]
