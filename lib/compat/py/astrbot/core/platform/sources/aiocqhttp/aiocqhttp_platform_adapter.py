"""astrbot.core.platform.sources.aiocqhttp.aiocqhttp_platform_adapter 仿制"""

from .....api.platform import Platform  # noqa: F401
from .....api.platform import register_platform_adapter  # noqa: F401
from ....._message import PlatformMetadata  # noqa: F401

__all__ = ["Platform", "PlatformMetadata", "register_platform_adapter"]
