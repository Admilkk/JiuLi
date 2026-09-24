"""astrbot.api.platform 仿制"""

from ..._message import (  # noqa: F401
    AstrBotMessage,
    Group,
    MessageMember,
    MessageSession,
    MessageType,
    PlatformMetadata,
)
from ..._event import AstrMessageEvent  # noqa: F401


class Platform:
    """平台适配器抽象基类（兼容层不注册平台，插件继承它时应视为不支持）"""

    def __init__(self, *args, **kwargs):
        self.config = kwargs.get("config", {})

    def meta(self) -> PlatformMetadata:  # pragma: no cover - 真实插件才实现
        return PlatformMetadata()

    async def send_by_session(self, session, message_chain) -> None:
        raise NotImplementedError("JiuLi 的 AstrBot 兼容层不注册平台适配器")

    def run(self) -> None:
        raise NotImplementedError("JiuLi 的 AstrBot 兼容层不注册平台适配器")


def register_platform_adapter(*args, **kwargs):
    def decorator(cls):
        return cls

    if args and callable(args[0]):
        return decorator(args[0])
    return decorator


__all__ = [
    "AstrBotMessage",
    "AstrMessageEvent",
    "Group",
    "MessageMember",
    "MessageSession",
    "MessageType",
    "Platform",
    "PlatformMetadata",
    "register_platform_adapter",
]
