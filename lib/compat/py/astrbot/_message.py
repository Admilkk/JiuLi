"""
AstrBot 消息模型仿制（内部实现，由 astrbot.core.message.components 等再导出）

对应真实源码：astrbot/core/message/components.py、message_event_result.py、
astrbot/core/platform/{astrbot_message,message_session,message_type}.py

有意不做成 pydantic 模型：插件对组件的用法就是「构造 + 读字段 + toDict()」，
用普通类比 pydantic v1/v2 的差异更好控制；不确定的字段一律给默认值，
让插件读到 None 而不是 AttributeError。
"""

import enum
import json
import os
import time
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Any, List, Optional


# ==================== 消息类型 ====================


class MessageType(enum.Enum):
    GROUP_MESSAGE = "GroupMessage"
    FRIEND_MESSAGE = "FriendMessage"
    OTHER_MESSAGE = "OtherMessage"


# ==================== 组件 ====================


class BaseMessageComponent:
    type: str = "unknown"

    def toDict(self) -> dict:
        """OneBot v11 CQ 段风格：{"type": ..., "data": {...}}"""
        return {"type": self.type, "data": {}}

    async def to_dict(self) -> dict:
        return self.toDict()

    def __repr__(self):
        return f"{type(self).__name__}({self.toDict()['data']})"


class Plain(BaseMessageComponent):
    type = "text"

    def __init__(self, text: str = "", convert: bool = True):
        self.text = str(text)

    def toDict(self):
        return {"type": "text", "data": {"text": self.text}}


class Face(BaseMessageComponent):
    type = "face"

    def __init__(self, id: int = 0, **kwargs):
        self.id = id

    def toDict(self):
        return {"type": "face", "data": {"id": self.id}}


class _FileComponent(BaseMessageComponent):
    """Image / Record / Video 共用的 file/url/path 三件套"""

    def __init__(self, file: Optional[str] = None, url: Optional[str] = None, path: Optional[str] = None, **kwargs):
        self.file = file or ""
        self.url = url or ""
        self.path = path or ""

    def _src(self) -> str:
        return self.url or self.file or (Path(self.path).resolve().as_uri() if self.path else "")

    def toDict(self):
        return {"type": self.type, "data": {"file": self._src()}}

    @classmethod
    def fromURL(cls, url: str):
        return cls(url=url, file=url)

    @classmethod
    def fromFileSystem(cls, path: str):
        abs_path = os.path.abspath(path)
        return cls(file=Path(abs_path).as_uri(), path=abs_path)

    @classmethod
    def fromBase64(cls, b64: str):
        data = b64 if b64.startswith("base64://") else f"base64://{b64}"
        return cls(file=data)

    @classmethod
    def fromBytes(cls, raw: bytes):
        import base64

        return cls(file="base64://" + base64.b64encode(raw).decode())

    @classmethod
    def fromIO(cls, io: BytesIO):
        return cls.fromBytes(io.getvalue())

    async def convert_to_file_path(self) -> str:
        return self.path

    async def convert_to_base64(self) -> str:
        return self.file

    async def register_to_file_service(self) -> str:
        return self._src()


class Image(_FileComponent):
    type = "image"

    def __init__(self, file: Optional[str] = None, _type: Optional[str] = "", url: Optional[str] = "", path: Optional[str] = None, **kwargs):
        super().__init__(file, url, path)
        self._type = _type

    def toDict(self):
        return {"type": "image", "data": {"file": self._src()}}

    async def to_dict(self):
        return self.toDict()


class Record(_FileComponent):
    type = "record"

    def __init__(self, file: Optional[str] = None, url: Optional[str] = "", text: Optional[str] = None, path: Optional[str] = None, **kwargs):
        super().__init__(file, url, path)
        self.text = text


class Video(_FileComponent):
    type = "video"

    def __init__(self, file: Optional[str] = None, url: Optional[str] = "", cover: Optional[str] = "", path: Optional[str] = None, **kwargs):
        super().__init__(file, url, path)
        self.cover = cover


class At(BaseMessageComponent):
    type = "at"

    def __init__(self, qq: Any = "", name: Optional[str] = "", **kwargs):
        self.qq = str(qq)
        self.name = name

    def toDict(self):
        return {"type": "at", "data": {"qq": self.qq}}


class AtAll(At):
    def __init__(self, qq: str = "all", **kwargs):
        super().__init__(qq=qq, **kwargs)


class Reply(BaseMessageComponent):
    type = "reply"

    def __init__(self, id: Any = "", chain: Optional[list] = None, sender_id: Any = 0, sender_nickname: Optional[str] = "", time: Optional[int] = 0, message_str: Optional[str] = "", **kwargs):
        self.id = str(id)
        self.chain = chain if chain is not None else []
        self.sender_id = sender_id
        self.sender_nickname = sender_nickname
        self.time = time
        self.message_str = message_str
        # deprecated 别名
        for key in ("text", "qq", "seq"):
            if key in kwargs:
                setattr(self, key, kwargs[key])

    def toDict(self):
        return {"type": "reply", "data": {"id": self.id}}


class Poke(BaseMessageComponent):
    type = "poke"

    def __init__(self, poke_type: Any = None, id: Any = 0, _type: Any = "126", **kwargs):
        self.poke_type = poke_type if poke_type is not None else kwargs.get("type")
        self.id = id
        self._type = _type if _type is not None else kwargs.get("type", "126")

    def target_id(self):
        return self.id

    def toDict(self):
        return {"type": "poke", "data": {"type": self._type, "id": self.id}}


class Forward(BaseMessageComponent):
    type = "forward"

    def __init__(self, id: Any = "", **kwargs):
        self.id = str(id)

    def toDict(self):
        return {"type": "forward", "data": {"id": self.id}}


class Node(BaseMessageComponent):
    type = "node"

    def __init__(self, content: Optional[list] = None, id: Any = 0, name: str = "", uin: Any = "0", seq: Any = "", time: Any = 0, **kwargs):
        self.content = content or []
        self.id = id
        self.name = name
        self.uin = uin
        self.seq = seq
        self.time = time

    async def to_dict(self):
        return {
            "type": "node",
            "data": {
                "content": [await _to_dict_deep(c) for c in self.content],
                "id": self.id,
                "name": self.name,
                "uin": self.uin,
            },
        }

    def toDict(self):
        return {
            "type": "node",
            "data": {"content": [_to_dict_sync(c) for c in self.content], "id": self.id, "name": self.name, "uin": self.uin},
        }


class Nodes(BaseMessageComponent):
    type = "nodes"

    def __init__(self, nodes: Optional[list] = None, **kwargs):
        self.nodes = nodes or []

    async def to_dict(self):
        return {"type": "nodes", "data": {"messages": [await n.to_dict() for n in self.nodes]}}

    def toDict(self):
        return {"type": "nodes", "data": {"messages": [n.toDict() for n in self.nodes]}}


class Json(BaseMessageComponent):
    type = "json"

    def __init__(self, data: Any = "", **kwargs):
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except Exception:
                pass
        self.data = data

    def toDict(self):
        return {"type": "json", "data": {"data": self.data}}


class File(BaseMessageComponent):
    type = "file"

    def __init__(self, name: str = "", file: str = "", url: str = "", **kwargs):
        self.name = name
        self.file_ = file
        self.url = url

    @property
    def file(self) -> str:
        return self.file_ or self.url

    @file.setter
    def file(self, value: str):
        if value.startswith("http"):
            self.url = value
        else:
            self.file_ = value

    async def get_file(self, allow_return_url: bool = False) -> str:
        if allow_return_url and self.url:
            return self.url
        return self.file_ or self.url

    async def register_to_file_service(self) -> str:
        return await self.get_file(True)

    async def to_dict(self):
        return self.toDict()

    def toDict(self):
        return {"type": "file", "data": {"name": self.name, "file": self.file_, "url": self.url}}


class Music(BaseMessageComponent):
    type = "music"

    def __init__(self, _type: str = "", id: Any = 0, url: str = "", audio: str = "", title: str = "", content: str = "", image: str = "", **kwargs):
        self._type, self.id, self.url, self.audio = _type, id, url, audio
        self.title, self.content, self.image = title, content, image


class Share(BaseMessageComponent):
    type = "share"

    def __init__(self, url: str = "", title: str = "", content: str = "", image: str = "", **kwargs):
        self.url, self.title, self.content, self.image = url, title, content, image


class Contact(BaseMessageComponent):
    type = "contact"

    def __init__(self, _type: str = "", id: Any = 0, **kwargs):
        self._type, self.id = _type, id


class Location(BaseMessageComponent):
    type = "location"

    def __init__(self, lat: float = 0.0, lon: float = 0.0, title: str = "", content: str = "", **kwargs):
        self.lat, self.lon, self.title, self.content = lat, lon, title, content


class RPS(BaseMessageComponent):
    type = "rps"

    def __init__(self, text: str = "", **kwargs):
        self.text = text


class Dice(RPS):
    type = "dice"


class Shake(RPS):
    type = "shake"


class Unknown(RPS):
    type = "unknown"


ComponentTypes = {
    "plain": Plain,
    "text": Plain,
    "image": Image,
    "record": Record,
    "video": Video,
    "file": File,
    "face": Face,
    "at": At,
    "rps": RPS,
    "dice": Dice,
    "shake": Shake,
    "share": Share,
    "contact": Contact,
    "location": Location,
    "music": Music,
    "reply": Reply,
    "poke": Poke,
    "forward": Forward,
    "node": Node,
    "nodes": Nodes,
    "json": Json,
    "unknown": Unknown,
}


def _to_dict_sync(component: Any) -> Any:
    if isinstance(component, BaseMessageComponent):
        return component.toDict()
    return component


async def _to_dict_deep(component: Any) -> Any:
    if isinstance(component, BaseMessageComponent):
        return await component.to_dict()
    return component


# ==================== 消息链 / 结果 ====================


@dataclass
class MessageChain:
    chain: List[BaseMessageComponent] = field(default_factory=list)
    use_t2i_: Optional[bool] = None
    use_markdown_: Optional[bool] = None
    type: Optional[str] = None

    def derive(self, chain: Optional[list] = None) -> "MessageChain":
        return MessageChain(
            chain=list(chain) if chain is not None else list(self.chain),
            use_t2i_=self.use_t2i_,
            use_markdown_=self.use_markdown_,
            type=self.type,
        )

    def message(self, message: str) -> "MessageChain":
        self.chain.append(Plain(message))
        return self

    def at(self, name: str, qq: Any) -> "MessageChain":
        self.chain.append(At(qq=qq, name=name))
        return self

    def at_all(self) -> "MessageChain":
        self.chain.append(AtAll())
        return self

    def error(self, message: str) -> "MessageChain":
        return self.message(message)

    def url_image(self, url: str) -> "MessageChain":
        self.chain.append(Image.fromURL(url))
        return self

    def file_image(self, path: str) -> "MessageChain":
        self.chain.append(Image.fromFileSystem(path))
        return self

    def base64_image(self, b64: str) -> "MessageChain":
        self.chain.append(Image.fromBase64(b64))
        return self

    def use_t2i(self, use_t2i: bool) -> "MessageChain":
        self.use_t2i_ = use_t2i
        return self

    def use_markdown(self, use: Optional[bool] = True) -> "MessageChain":
        self.use_markdown_ = use
        return self

    def get_plain_text(self, with_other_comps_mark: bool = False) -> str:
        out = []
        for comp in self.chain:
            if isinstance(comp, Plain):
                out.append(comp.text)
            elif with_other_comps_mark:
                out.append(f"[{comp.type}]")
        return "".join(out)

    def squash_plain(self):
        texts = [c.text for c in self.chain if isinstance(c, Plain)]
        if not texts:
            return
        self.chain = [c for c in self.chain if not isinstance(c, Plain)]
        self.chain.insert(0, Plain("".join(texts)))


class EventResultType(enum.Enum):
    CONTINUE = enum.auto()
    STOP = enum.auto()


class ResultContentType(enum.Enum):
    LLM_RESULT = enum.auto()
    AGENT_RUNNER_ERROR = enum.auto()
    GENERAL_RESULT = enum.auto()
    STREAMING_RESULT = enum.auto()
    STREAMING_FINISH = enum.auto()


@dataclass
class MessageEventResult(MessageChain):
    result_type: Optional[EventResultType] = EventResultType.CONTINUE
    result_content_type: Optional[ResultContentType] = ResultContentType.GENERAL_RESULT
    async_stream: Any = None

    def stop_event(self):
        self.result_type = EventResultType.STOP

    def continue_event(self):
        self.result_type = EventResultType.CONTINUE

    def is_stopped(self) -> bool:
        return self.result_type == EventResultType.STOP

    def set_async_stream(self, stream):
        self.async_stream = stream

    def set_result_content_type(self, typ):
        self.result_content_type = typ

    def is_llm_result(self) -> bool:
        return self.result_content_type == ResultContentType.LLM_RESULT

    def is_model_result(self) -> bool:
        return self.is_llm_result()


CommandResult = MessageEventResult


# ==================== 消息对象 / 会话 ====================


@dataclass
class MessageMember:
    user_id: str = ""
    nickname: Optional[str] = None


@dataclass
class Group:
    group_id: str = ""
    group_name: Optional[str] = None
    group_avatar: Optional[str] = None
    group_owner: Optional[str] = None
    group_admins: Optional[list] = None
    members: Optional[list] = None
    member_count: Optional[int] = None


class AstrBotMessage:
    """真实源码里 group_id 是 property（由 group 派生），这里保持一致"""

    def __init__(self) -> None:
        self.type: MessageType = MessageType.FRIEND_MESSAGE
        self.self_id: str = ""
        self.session_id: str = ""
        self.message_id: str = ""
        self.group: Optional[Group] = None
        self.sender: MessageMember = MessageMember()
        self.message: List[BaseMessageComponent] = []
        self.message_str: str = ""
        self.raw_message: Any = None
        self.timestamp: int = int(time.time())

    @property
    def group_id(self) -> str:
        return self.group.group_id if self.group else ""

    @group_id.setter
    def group_id(self, value: Optional[str]):
        if not value:
            return
        if self.group is None:
            self.group = Group(group_id=str(value))
        else:
            self.group.group_id = str(value)


@dataclass
class MessageSession:
    """umo 的载体：str(umo) == "platform_id:MessageType.value:session_id"""

    platform_name: str
    message_type: MessageType
    session_id: str

    def __post_init__(self):
        self.platform_name = self.platform_name or "jiuli"

    def __str__(self) -> str:
        return f"{self.platform_name}:{self.message_type.value}:{self.session_id}"

    @classmethod
    def from_str(cls, value: str) -> "MessageSession":
        parts = str(value).split(":")
        if len(parts) < 3:
            raise ValueError(f"不合法的 session 字符串: {value}")
        platform = parts[0]
        type_str = parts[1]
        session_id = ":".join(parts[2:])
        try:
            message_type = MessageType(type_str)
        except ValueError:
            message_type = MessageType.FRIEND_MESSAGE
        return cls(platform_name=platform, message_type=message_type, session_id=session_id)


MessageSesion = MessageSession  # 真实源码里的拼写（少个 s），插件可能照抄


@dataclass
class PlatformMetadata:
    name: str = "jiuli"
    description: str = "JiuLi 兼容平台"
    id: str = "jiuli"
    support_streaming_message: bool = False
    support_proactive_message: bool = True
