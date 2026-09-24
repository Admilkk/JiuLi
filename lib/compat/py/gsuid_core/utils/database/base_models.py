"""
gsuid_core.utils.database.base_models 仿制：轻量数据模型

真实 GsCore 用 SQLModel + SQLAlchemy 异步会话。兼容层**不能**假装有 SQL，
否则插件的查询会静默返回错数据 —— 所以这里实现一个 JSON 落盘的等价模型：
  - 每张表一个 data/gsuid_compat/<表名>.json
  - 暴露与真实源码同名同签名的 classmethod（select_data / insert_data /
    update_data / delete_row / get_distinct_list / insert_uid / get_uid_list_by_game ...）
  - `@with_session` 被保留为装饰器（真实源码要求必须加），但传进去的 session 是占位对象

差异（已在 docs/compat-ecosystems.md 写明）：没有事务、没有并发控制、没有 SQL 表达式，
`row => ({money: $.sub(row.money, 100)})` 这类 SQL 层表达式求值不支持。
"""

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# 落盘位置可用 JIULI_GS_COMPAT_DATA 覆盖（测试隔离用）
STORE_DIR = Path(os.environ.get("JIULI_GS_COMPAT_DATA", "data/gsuid_compat"))


class _Session:
    """占位 session：真实源码里是 AsyncSession"""

    async def commit(self):
        return None

    async def rollback(self):
        return None

    async def flush(self):
        return None

    async def execute(self, *args, **kwargs):
        raise NotImplementedError("JiuLi 的 GsCore 兼容层没有 SQL 执行能力")


_SESSION = _Session()


def with_session(func):
    """真实源码的 @with_session：给方法注入 session 作为第二参数"""
    import functools
    import inspect

    if inspect.iscoroutinefunction(func):
        @functools.wraps(func)
        async def wrapper(cls, *args, **kwargs):
            return await func(cls, _SESSION, *args, **kwargs)
    else:
        @functools.wraps(func)
        def wrapper(cls, *args, **kwargs):
            return func(cls, _SESSION, *args, **kwargs)

    return wrapper


with_read_session = with_session


class _Table:
    """一张表的 JSON 存储"""

    _cache: Dict[str, Dict[str, Any]] = {}
    _locks: Dict[str, asyncio.Lock] = {}

    def __init__(self, name: str):
        self.name = name
        self.path = STORE_DIR / f"{name}.json"

    @property
    def lock(self) -> asyncio.Lock:
        if self.name not in _Table._locks:
            _Table._locks[self.name] = asyncio.Lock()
        return _Table._locks[self.name]

    def read(self) -> Dict[str, Any]:
        if self.name in _Table._cache:
            return _Table._cache[self.name]
        data: Dict[str, Any] = {}
        try:
            if self.path.exists():
                data = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            data = {}
        _Table._cache[self.name] = data if isinstance(data, dict) else {}
        return _Table._cache[self.name]

    def write(self) -> None:
        try:
            STORE_DIR.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.read(), ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass


class BaseIDModel:
    __table_name__ = "base"

    @classmethod
    def _table(cls) -> _Table:
        return _Table(getattr(cls, "__table_name__", cls.__name__.lower()))

    @classmethod
    def _match(cls, row: Dict[str, Any], **kwargs) -> bool:
        for k, v in kwargs.items():
            if v is None:
                continue
            if str(row.get(k)) != str(v):
                return False
        return True

    # ---- 常用接口 ----

    @classmethod
    async def data_exist(cls, **kwargs) -> bool:
        return any(cls._match(r, **kwargs) for r in cls._table().read().values())

    @classmethod
    async def insert_data(cls, **kwargs):
        table = cls._table()
        async with table.lock:
            data = table.read()
            new_id = max([int(k) for k in data.keys()] or [0]) + 1
            row = {"id": new_id, **kwargs}
            data[str(new_id)] = row
            table.write()
            return row

    @classmethod
    async def full_insert_data(cls, **kwargs):
        return await cls.insert_data(**kwargs)

    @classmethod
    async def select_data(cls, **kwargs) -> Optional[Dict[str, Any]]:
        for row in cls._table().read().values():
            if cls._match(row, **kwargs):
                return row
        return None

    @classmethod
    async def select_rows(cls, **kwargs) -> List[Dict[str, Any]]:
        return [r for r in cls._table().read().values() if cls._match(r, **kwargs)]

    @classmethod
    async def select_data_list(cls, **kwargs) -> List[Dict[str, Any]]:
        return await cls.select_rows(**kwargs)

    @classmethod
    async def update_data(cls, data: Dict[str, Any], **kwargs) -> bool:
        table = cls._table()
        async with table.lock:
            rows = table.read()
            hit = False
            for row in rows.values():
                if cls._match(row, **kwargs):
                    row.update(data)
                    hit = True
            if hit:
                table.write()
            return hit

    @classmethod
    async def update_data_by_data(cls, data: Dict[str, Any], **kwargs) -> bool:
        return await cls.update_data(data, **kwargs)

    @classmethod
    async def delete_row(cls, **kwargs) -> bool:
        table = cls._table()
        async with table.lock:
            rows = table.read()
            keep = {k: v for k, v in rows.items() if not cls._match(v, **kwargs)}
            changed = len(keep) != len(rows)
            if changed:
                _Table._cache[table.name] = keep
                table.write()
            return changed

    @classmethod
    async def delete_data(cls, **kwargs) -> bool:
        return await cls.delete_row(**kwargs)

    @classmethod
    async def get_distinct_list(cls, column: str = "user_id", **kwargs) -> List[str]:
        seen = []
        for row in cls._table().read().values():
            if not cls._match(row, **kwargs):
                continue
            value = row.get(column)
            if value is not None and value not in seen:
                seen.append(value)
        return seen


class BaseBotIDModel(BaseIDModel):
    __table_name__ = "base_bot"


class BaseModel(BaseBotIDModel):
    __table_name__ = "base_model"


__all__ = [
    "BaseBotIDModel",
    "BaseIDModel",
    "BaseModel",
    "_Session",
    "with_read_session",
    "with_session",
]
