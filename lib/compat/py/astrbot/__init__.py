"""
astrbot 兼容仿制包（JiuLi 生态兼容层）

不是 AstrBot 本体：只提供插件公开契约面（astrbot.api.*）与真实插件大量直接 import 的
半公开内部面（astrbot.core.message.components / config.astrbot_config / star.filter.* 等）。

覆盖范围与缺口见 docs/compat-ecosystems.md。
"""

import sys
from pathlib import Path

# 真实插件会用 importlib.metadata.version("AstrBot") 做版本探测，这里兜住
__version__ = "4.28.1"


class _Logger:
    def _emit(self, level, msg, *args):
        text = str(msg)
        if args:
            try:
                text = text % args if "%" in text else text.format(*args)
            except Exception:
                pass
        sys.stderr.write(f"[astrbot] {text}\n")
        sys.stderr.flush()

    def info(self, msg, *a):
        self._emit("info", msg, *a)

    def warning(self, msg, *a):
        self._emit("warning", msg, *a)

    warn = warning

    def error(self, msg, *a):
        self._emit("error", msg, *a)

    def debug(self, msg, *a):
        self._emit("debug", msg, *a)

    def critical(self, msg, *a):
        self._emit("critical", msg, *a)

    def exception(self, msg, *a):
        import traceback

        self._emit("error", f"{msg}\n{traceback.format_exc()}")


logger = _Logger()

__all__ = ["__version__", "logger"]
