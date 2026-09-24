"""
gsuid_core.ai_core.trigger_bridge 仿制：ai_return 装饰器

真实作用：标记一个函数可以被 AI 以自然语言触发（对应 @sv.on_xxx(to_ai="描述")）。
兼容层没有 AI 触发器，装饰器只做标记并原样返回函数 —— 插件照常能被指令触发，
只是不会被自然语言触发。
"""

from typing import Any, Callable, Optional


def ai_return(func: Optional[Callable] = None, *, desc: str = "", **kwargs):
    def decorator(fn: Callable) -> Callable:
        fn.__ai_return__ = {"desc": desc, **kwargs}
        return fn

    return decorator(func) if func is not None else decorator


def ai_bridge(*args: Any, **kwargs: Any):
    def decorator(fn):
        return fn

    return decorator


__all__ = ["ai_bridge", "ai_return"]
