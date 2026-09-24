"""
gsuid_core.subscribe 仿制：订阅消息

真实 API（来自 gsuid_core/subscribe.py 实测签名）：
    async def add_subscribe(subscribe_type: Literal['session','single'], task_name, event, extra_message=None)
    async def get_subscribe(task_name) -> List[Subscribe]     # Subscribe.send(msg) 自动找到目标
    async def delete_subscribe(subscribe_type, task_name, event)

兼容层用内存表 + JSON 落盘实现同一套接口。差异：没有定时推送调度器，
`Subscribe.send` 只负责「按记录的目标把消息发给 JiuLi」。
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

STORE = Path(os.environ.get("JIULI_GS_COMPAT_DATA", "data/gsuid_compat")) / "subscribe.json"


class Subscribe:
    """订阅记录：真实源码里带 send() 与 extra_message"""

    def __init__(self, subscribe_type: str, task_name: str, data: Dict[str, Any], bridge=None):
        self.subscribe_type = subscribe_type
        self.task_name = task_name
        self.data = data
        self.extra_message = data.get("extra_message")
        self.bot_id = data.get("bot_id") or ""
        self.user_id = data.get("user_id") or ""
        self.group_id = data.get("group_id")
        self.uid = data.get("uid") or self.user_id
        self._bridge = bridge

    async def send(self, msg: Any) -> bool:
        if self._bridge is None:
            return False
        from .bot import to_elements

        elements = to_elements(msg)
        if not elements:
            return False
        target = {
            "selfId": self.bot_id,
            "isGroup": bool(self.group_id),
            "channelId": str(self.group_id or self.user_id),
        }
        self._bridge.send(elements, target=target)
        return True

    def __repr__(self):
        return f"Subscribe({self.subscribe_type}, {self.task_name}, {self.data})"


def _load() -> List[Dict[str, Any]]:
    try:
        if STORE.exists():
            data = json.loads(STORE.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
    except Exception:
        pass
    return []


def _save(rows: List[Dict[str, Any]]) -> None:
    try:
        STORE.parent.mkdir(parents=True, exist_ok=True)
        STORE.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


class _SubscribeManager:
    def __init__(self):
        self._bridge = None

    def bind(self, bridge):
        self._bridge = bridge

    @staticmethod
    def _key(subscribe_type: str, task_name: str, data: Dict[str, Any]) -> tuple:
        return (
            subscribe_type,
            task_name,
            str(data.get("bot_id") or ""),
            str(data.get("group_id") or ""),
            str(data.get("user_id") or ""),
        )

    async def add_subscribe(
        self,
        subscribe_type: str = "single",
        task_name: str = "",
        event: Any = None,
        extra_message: Optional[str] = None,
        **kwargs,
    ) -> bool:
        data = {
            "bot_id": getattr(event, "bot_id", "") or "",
            "user_id": getattr(event, "user_id", "") or "",
            "group_id": getattr(event, "group_id", None),
            "uid": getattr(event, "user_id", "") or "",
            "extra_message": extra_message,
            **kwargs,
        }
        rows = _load()
        key = self._key(subscribe_type, task_name, data)
        rows = [r for r in rows if self._key(r.get("subscribe_type", ""), r.get("task_name", ""), r) != key]
        rows.append({"subscribe_type": subscribe_type, "task_name": task_name, **data})
        _save(rows)
        return True

    async def get_subscribe(self, task_name: str = "", **kwargs) -> List[Subscribe]:
        out = []
        for row in _load():
            if task_name and row.get("task_name") != task_name:
                continue
            out.append(
                Subscribe(row.get("subscribe_type", "single"), row.get("task_name", ""), row, self._bridge)
            )
        return out

    async def get_all_subscribe(self, **kwargs) -> List[Subscribe]:
        return await self.get_subscribe("")

    async def delete_subscribe(
        self,
        subscribe_type: str = "single",
        task_name: str = "",
        event: Any = None,
        **kwargs,
    ) -> bool:
        data = {
            "bot_id": getattr(event, "bot_id", "") or "",
            "user_id": getattr(event, "user_id", "") or "",
            "group_id": getattr(event, "group_id", None),
        }
        key = self._key(subscribe_type, task_name, data)
        rows = _load()
        keep = [r for r in rows if self._key(r.get("subscribe_type", ""), r.get("task_name", ""), r) != key]
        changed = len(keep) != len(rows)
        _save(keep)
        return changed

    async def send_subscribe_msg(self, task_name: str, msg: Any) -> int:
        """把消息推给该任务的全部订阅者（真实源码里由 Core 的推送流程调用）"""
        sent = 0
        for sub in await self.get_subscribe(task_name):
            if await sub.send(msg):
                sent += 1
        return sent


gs_subscribe = _SubscribeManager()

__all__ = ["Subscribe", "gs_subscribe"]
