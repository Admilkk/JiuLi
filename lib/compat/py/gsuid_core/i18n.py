"""gsuid_core.i18n 仿制：t() 直通返回原文（真实 GsCore 会按语言包翻译）"""

from typing import Any


def t(msg: Any, *args, **kwargs) -> Any:
    if args:
        try:
            return str(msg).format(*args)
        except Exception:
            return str(msg)
    return msg


def tt(msg: Any, *args, **kwargs) -> Any:
    return t(msg, *args, **kwargs)


__all__ = ["t", "tt"]
