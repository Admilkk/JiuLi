"""astrbot.core.platform.platform 仿制：Platform ABC 与注册器"""

from ...api.platform import Platform, register_platform_adapter  # noqa: F401
from ..._message import PlatformMetadata  # noqa: F401

__all__ = ["Platform", "PlatformMetadata", "register_platform_adapter"]
