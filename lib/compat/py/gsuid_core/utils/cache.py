"""gsuid_core.utils.cache 仿制：进程内缓存（真实源码用 diskcache）"""

import time
from typing import Any, Dict, Optional


class _Cache:
    def __init__(self, name: str = "cache"):
        self.name = name
        self._data: Dict[str, tuple] = {}

    def get(self, key: str, default: Any = None) -> Any:
        item = self._data.get(key)
        if not item:
            return default
        value, expire = item
        if expire and expire < time.time():
            self._data.pop(key, None)
            return default
        return value

    def set(self, key: str, value: Any, expire: Optional[float] = None) -> None:
        self._data[key] = (value, time.time() + expire if expire else None)

    def delete(self, key: str) -> None:
        self._data.pop(key, None)

    def clear(self) -> None:
        self._data.clear()

    def __contains__(self, key: str) -> bool:
        return self.get(key) is not None


CACHE = _Cache("CACHE")
gs_cache = CACHE

__all__ = ["CACHE", "gs_cache"]
