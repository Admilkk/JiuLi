"""astrbot.core.platform 仿制包"""

from ..._event import AstrMessageEvent, AiocqhttpMessageEvent  # noqa: F401
from ..._message import (  # noqa: F401
    AstrBotMessage,
    Group,
    MessageMember,
    MessageSession,
    MessageType,
    PlatformMetadata,
)

__all__ = [
    "AstrBotMessage",
    "AstrMessageEvent",
    "AiocqhttpMessageEvent",
    "Group",
    "MessageMember",
    "MessageSession",
    "MessageType",
    "PlatformMetadata",
]
