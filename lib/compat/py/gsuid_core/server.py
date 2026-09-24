"""gsuid_core.server 仿制：启动钩子

真实 GsCore 在 WS 服务起来前后执行这些钩子。兼容层里「启动」= Python 边车启动，
所以 before 钩子在插件加载后、ready 之前跑，普通钩子在 ready 之后作为后台任务跑。
"""

from typing import Awaitable, Callable, List, Tuple

_BEFORE: List[Tuple[int, Callable]] = []
_AFTER: List[Tuple[int, Callable]] = []


def _hook(store, fn=None, priority: int = 10):
    def register(func):
        store.append((priority, func))
        return func

    # 支持 @on_core_start 与 @on_core_start(priority=5) 两种写法
    if fn is not None and callable(fn):
        return register(fn)
    return register


def on_core_start_before(fn=None, priority: int = 10):
    """WS 连接前阻塞执行（这里是 ready 之前）"""
    return _hook(_BEFORE, fn, priority)


def on_core_start(fn=None, priority: int = 10):
    """启动后异步执行"""
    return _hook(_AFTER, fn, priority)


def before_hooks():
    return [f for _, f in sorted(_BEFORE, key=lambda i: i[0])]


def after_hooks():
    return [f for _, f in sorted(_AFTER, key=lambda i: i[0])]


__all__ = ["after_hooks", "before_hooks", "on_core_start", "on_core_start_before"]
