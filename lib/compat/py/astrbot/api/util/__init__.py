"""
astrbot.api.util 仿制：会话控制器（session_waiter）

真实实现会在事件 pipeline 里拦截同一会话的后续消息。兼容层的 pipeline 在 boot 脚本里，
没有拦截点，因此这里给出**明确不可用**的实现：import 与装饰器都不报错，
一旦真的进入多步会话就抛 NotImplementedError，避免静默失效。

需要多步会话的 AstrBot 插件请参考 GsCore 的 receive_resp（那条链路是真实现的）。
"""

import functools
from typing import Any, Callable, Optional


class SessionController:
    def __init__(self, timeout: float = 30, **kwargs):
        self.timeout = timeout
        self.stopped = False

    def stop(self) -> None:
        self.stopped = True

    def keep(self) -> None:
        self.stopped = False


class SessionFilter:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

    def filter(self, event) -> bool:
        return True


def session_waiter(timeout: float = 30, timeout_retry: bool = False):
    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        async def wrapper(event, *args, **kwargs):
            controller = SessionController(timeout=timeout)
            raise NotImplementedError(
                "JiuLi 的 AstrBot 兼容层暂不支持 session_waiter 多步会话"
                "（需要事件 pipeline 的会话拦截；GsCore 侧的 bot.receive_resp 已实现）"
            )

        wrapper.__session_waiter__ = {"timeout": timeout, "timeout_retry": timeout_retry}
        return wrapper

    return decorator


__all__ = ["SessionController", "SessionFilter", "session_waiter"]
