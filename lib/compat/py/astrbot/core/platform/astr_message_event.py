"""astrbot.core.platform.astr_message_event 仿制"""

from ..._event import (  # noqa: F401
    AiocqhttpMessageEvent,
    AstrMessageEvent,
    QQOfficialMessageEvent,
    TelegramMessageEvent,
)

__all__ = [
    "AiocqhttpMessageEvent",
    "AstrMessageEvent",
    "QQOfficialMessageEvent",
    "TelegramMessageEvent",
]
