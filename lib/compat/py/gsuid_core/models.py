"""
gsuid_core.models 仿制：Event / Message / MessageSegment

Event 是 GsCore 插件打交道最多的对象。真实 Event 是 msgspec.Struct，
这里用普通类 + 宽松属性表，字段名对齐真实 GsCore，插件读不到的字段会是 None 而不是 AttributeError，
这样「插件用了我们没实现的字段」表现为功能缺失而不是整个插件崩掉。
"""

from enum import Enum
from typing import Any, Dict, List, Optional


class MessageType(str, Enum):
    GROUP = "GROUP"
    PRIVATE = "PRIVATE"
    GUILD = "GUILD"
    CHANNEL = "CHANNEL"


class EventType(str, Enum):
    GROUP_MSG = "GROUP_MSG"
    PRIVATE_MSG = "PRIVATE_MSG"
    META = "META"


class Message:
    """GsCore 的消息段：Message(type, data)"""

    def __init__(self, type: str = "text", data: Any = "", **kwargs):
        self.type = type
        self.data = data
        for k, v in kwargs.items():
            setattr(self, k, v)

    def __repr__(self):
        return f"Message(type={self.type!r}, data={self.data!r})"

    # ---- 常用构造 ----

    @classmethod
    def text(cls, data: Any):
        return cls("text", data)

    @classmethod
    def image(cls, data: Any):
        return cls("image", data)

    @classmethod
    def at(cls, data: Any):
        return cls("at", data)

    @classmethod
    def record(cls, data: Any):
        return cls("record", data)

    @classmethod
    def video(cls, data: Any):
        return cls("video", data)

    @classmethod
    def node(cls, data: Any):
        return cls("node", data)

    @classmethod
    def markdown(cls, data: Any):
        return cls("markdown", data)

    @classmethod
    def buttons(cls, data: Any):
        return cls("buttons", data)


class MessageSegment:
    """部分插件用 MessageSegment.xxx() 构造，等价于 Message"""

    @staticmethod
    def text(data: Any):
        return Message("text", data)

    @staticmethod
    def image(data: Any):
        return Message("image", data)

    @staticmethod
    def at(data: Any):
        return Message("at", data)

    @staticmethod
    def record(data: Any):
        return Message("record", data)

    @staticmethod
    def video(data: Any):
        return Message("video", data)

    @staticmethod
    def node(data: Any):
        return Message("node", data)


class MessageReceive:
    """bot.receive_resp() 的返回值"""

    def __init__(self, text: str = "", image: Optional[List[str]] = None, msg_id: str = ""):
        self.text = text
        self.image = image or []
        self.msg_id = msg_id

    def __repr__(self):
        return f"MessageReceive(text={self.text!r}, image={self.image!r})"


class Event:
    """
    一条消息事件。字段名对齐真实 GsCore：
      bot_id / bot_self_id / user_id / user_type / group_id / sender / content /
      text / command / image / at / raw_text / msg_id / raw_data / is_tome / post_type
    """

    def __init__(self, data: Optional[Dict[str, Any]] = None):
        data = data or {}
        self.raw_data: Dict[str, Any] = data

        self.bot_id: str = data.get("bot_id") or data.get("self_id") or ""
        self.bot_self_id: str = self.bot_id
        self.user_id: str = data.get("user_id") or ""
        self.user_type: str = data.get("user_type") or (
            "group" if data.get("group_id") else "direct"
        )
        self.group_id: Optional[str] = data.get("group_id") or None
        self.sender: Dict[str, Any] = data.get("sender") or {}
        self.msg_id: str = data.get("msg_id") or data.get("message_id") or ""
        self.post_type: str = data.get("post_type") or "message"

        self.content: List[Dict[str, Any]] = data.get("elements") or []
        self.raw_text: str = data.get("raw_text") or data.get("text") or ""

        # 富媒体：真实 GsCore 里 image 是「最后一张」，image_list 是全部
        images = [i.get("url", "") for i in self.content if i.get("type") == "image"]
        self.image: Optional[str] = images[-1] if images else None
        self.image_list: List[str] = list(images)
        self.image_id: Optional[str] = None
        self.image_id_list: List[str] = []
        self.audio_id: Optional[str] = None
        self.audio_id_list: List[str] = []
        self.video_id: Optional[str] = None
        self.video_id_list: List[str] = []

        ats = [i.get("id", "") for i in self.content if i.get("type") == "at"]
        self.at: Optional[str] = ats[0] if ats else None
        self.at_list: List[str] = list(ats)
        self.is_tome: bool = bool(data.get("is_tome") or (self.bot_id and self.at == self.bot_id))

        self.reply: Optional[str] = None
        self.reply_id: Optional[str] = None
        self.node: Optional[List[Any]] = None
        self.file: Optional[str] = None
        self.file_name: Optional[str] = None
        self.file_type: Optional[str] = None

        self.meta_event_type: Optional[str] = None
        self.meta_event_data: Dict[str, Any] = {}

        # 匹配阶段由 SV / Trigger 覆盖；未命中触发器时与 raw_text 相同
        # （真实源码 msg_process 里 text 与 raw_text 同步累加，触发器再改写）
        self.text: str = self.raw_text
        self.command: str = ""
        self.regex_group: tuple = ()
        self.regex_dict: Dict[str, str] = {}
        self.task_id: str = ""
        self.task_event: Any = None
        self._id: Any = data.get("_id")

    @property
    def session_id(self) -> str:
        """
        真实格式：
          {WS_BOT_ID}:{bot_id}:{bot_self_id}:group:{group_id}
          {WS_BOT_ID}:{bot_id}:{bot_self_id}:private:{user_id}
        注意与 Bot.session_id（%%% 拼接）不是一回事，多步会话用的是后者。
        """
        scope = "group" if self.group_id else "private"
        target = self.group_id if self.group_id else self.user_id
        return f"{self.bot_id}:{self.bot_id}:{self.bot_self_id}:{scope}:{target}"

    def get_meta(self, key: str, default: Any = None) -> Any:
        return self.meta_event_data.get(key, default)

    def __repr__(self):
        return f"Event(user={self.user_id}, group={self.group_id}, raw_text={self.raw_text!r})"


__all__ = [
    "Event",
    "EventType",
    "Message",
    "MessageReceive",
    "MessageSegment",
    "MessageType",
]
