"""gsuid_core.logger 仿制：loguru 风格的最小 logger（真实插件里出现频率最高的 import）"""

import sys


class _Logger:
    """真实 GsCore 用 loguru，插件只用到 info/warning/error/debug/success 与 opt()"""

    def __init__(self, name="gsuid_core"):
        self.name = name

    def _emit(self, level, msg, *args):
        text = str(msg)
        if args:
            try:
                text = text.format(*args)
            except Exception:
                text = f"{text} {' '.join(str(a) for a in args)}"
        payload = f"[{self.name}] {text}"
        try:
            if level in ("error", "critical"):
                sys.stderr.write(payload + "\n")
            else:
                sys.stderr.write(payload + "\n")
            sys.stderr.flush()
        except Exception:
            pass

    def trace(self, msg, *args):
        self._emit("trace", msg, *args)

    def debug(self, msg, *args):
        self._emit("debug", msg, *args)

    def info(self, msg, *args):
        self._emit("info", msg, *args)

    def success(self, msg, *args):
        self._emit("success", msg, *args)

    def warning(self, msg, *args):
        self._emit("warning", msg, *args)

    warn = warning

    def error(self, msg, *args):
        self._emit("error", msg, *args)

    def critical(self, msg, *args):
        self._emit("critical", msg, *args)

    def exception(self, msg, *args):
        self._emit("error", msg, *args)

    def opt(self, **kwargs):
        """loguru 的 opt(depth=..., exception=...) 链式调用；兼容层直接忽略参数"""
        return self

    def bind(self, **kwargs):
        return self


logger = _Logger()

__all__ = ["logger"]
