"""astrbot.core.star 仿制包"""

from ..._star import (  # noqa: F401
    Context,
    Star,
    StarMetadata,
    StarTools,
    register,
    star_handlers_registry,
    star_map,
    star_registry,
)

__all__ = [
    "Context",
    "Star",
    "StarMetadata",
    "StarTools",
    "register",
    "star_handlers_registry",
    "star_map",
    "star_registry",
]
