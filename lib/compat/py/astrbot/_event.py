"""
AstrMessageEvent 仿制（内部实现）

对应真实源码 astrbot/core/platform/astr_message_event.py。
必须提供基类全部字段与方法：真实插件会 isinstance 判断平台子类，也会直接读 event.role / is_wake。

派发前必须写好的字段（否则插件的 filter 判断会出错）：
  role（"admin"/"member"）、is_wake、is_at_or_wake_command、message_obj.type / .group、
  platform_meta.name / .id。由 boot 脚本负责填。
"""

import asyncio
import re
import time
from typing import Any, AsyncGenerator, List, Optional

from ._message import (
    AstrBotMessage,
    At,
    BaseMessageComponent,
    Group,
    Image,
    MessageChain,
    MessageEventResult,
    MessageSession,
    MessageType,
    Plain,
    PlatformMetadata,
)


class _ProviderRequestStub:
    """request_llm 的返回值占位。真实 AstrBot 里它带着 tool 定义与对话上下文。"""

    def __init__(self, prompt: str = "", system_prompt: str = "", **kwargs):
        self.prompt = prompt
        self.system_prompt = system_prompt
        self.image_urls: List[str] = []
        self.audio_urls: List[str] = []
        self.contexts: List[Any] = []
        self.extra_user_content_parts: List[Any] = []
        self.func_tool = None
        self.session_id = ""
        for k, v in kwargs.items():
            setattr(self, k, v)


class _BotApiStub:
    """AiocqhttpMessageEvent.bot.api.call_action 的占位"""

    def __init__(self, bridge, event_id):
        self._bridge = bridge
        self._event_id = event_id

    async def call_action(self, action: str, **params):
        if self._bridge is not None:
            self._bridge.log(
                "warn",
                f"插件调用了平台 action「{action}」，JiuLi 兼容层暂未代理该动作（参数：{params}）",
            )
        return None


class _BotStub:
    def __init__(self, bridge, event_id):
        self.api = _BotApiStub(bridge, event_id)


class AstrMessageEvent:
    def __init__(
        self,
        message_str: str,
        message_obj: AstrBotMessage,
        platform_meta: PlatformMetadata,
        session_id: str,
    ) -> None:
        self.message_str = message_str
        self.message_obj = message_obj
        self.platform_meta = platform_meta
        self.platform = platform_meta  # 旧别名
        self.role = "member"
        self.is_wake = False
        self.is_at_or_wake_command = False
        self.session = MessageSession(
            platform_name=platform_meta.id if platform_meta else "jiuli",
            message_type=getattr(message_obj, "type", MessageType.FRIEND_MESSAGE),
            session_id=session_id,
        )
        self.created_at = time.time()
        self.call_llm = True
        self.plugins_name: Optional[List[str]] = None
        self._result: Optional[MessageEventResult] = None
        self._force_stopped = False
        self._extras: dict = {}
        self._tmp_files: List[str] = []
        self.trace = None
        self.span = None
        # 兼容层内部：发消息的通道（由 loader 注入）
        self._bridge = None
        self._event_id = None

    # ---------- 平台 / 身份 ----------

    def get_platform_name(self) -> str:
        return self.platform_meta.name if self.platform_meta else "jiuli"

    def get_platform_id(self) -> str:
        return self.platform_meta.id if self.platform_meta else "jiuli"

    def get_self_id(self) -> str:
        return self.message_obj.self_id

    def get_sender_id(self) -> str:
        return self.message_obj.sender.user_id if self.message_obj.sender else ""

    def get_sender_name(self) -> str:
        sender = self.message_obj.sender
        if not sender:
            return ""
        return sender.nickname or sender.user_id or ""

    def get_group_id(self) -> str:
        return self.message_obj.group_id or ""

    def get_session_id(self) -> str:
        return self.session_id

    @property
    def unified_msg_origin(self) -> str:
        return str(self.session)

    @unified_msg_origin.setter
    def unified_msg_origin(self, value: str) -> None:
        self.session = MessageSession.from_str(value)

    @property
    def session_id(self) -> str:
        return self.session.session_id

    @session_id.setter
    def session_id(self, value: str) -> None:
        self.session.session_id = value

    # ---------- 消息 ----------

    def get_message_str(self) -> str:
        return self.message_str

    def get_messages(self) -> List[BaseMessageComponent]:
        return self.message_obj.message

    def get_message_type(self) -> MessageType:
        return self.message_obj.type

    def get_message_outline(self) -> str:
        parts = []
        for comp in self.message_obj.message:
            if isinstance(comp, Plain):
                parts.append(comp.text)
            elif comp.type == "image":
                parts.append("[图片]")
            elif comp.type == "face":
                parts.append(f"[表情:{getattr(comp, 'id', '')}]")
            elif comp.type == "at":
                parts.append(f"[At:{getattr(comp, 'qq', '')}]")
            elif comp.type == "node" or comp.type == "nodes":
                parts.append("[转发消息]")
            elif comp.type == "reply":
                parts.append("[引用消息]")
            else:
                parts.append(f"[{comp.type}]")
        return "".join(parts)

    def is_private_chat(self) -> bool:
        return self.get_message_type() == MessageType.FRIEND_MESSAGE

    def is_wake_up(self) -> bool:
        return self.is_wake

    def is_admin(self) -> bool:
        """真实源码就是这一行：只看 role 字符串"""
        return self.role == "admin"

    # ---------- extra ----------

    def set_extra(self, key, value) -> None:
        self._extras[key] = value

    def get_extra(self, key: Optional[str] = None, default=None):
        if key is None:
            return self._extras
        return self._extras.get(key, default)

    def clear_extra(self) -> None:
        self._extras.clear()

    # ---------- 传播控制 ----------

    def set_result(self, result) -> None:
        if isinstance(result, str):
            result = MessageEventResult().message(result)
        self._result = result

    def get_result(self) -> Optional[MessageEventResult]:
        return self._result

    def clear_result(self) -> None:
        self._result = None

    def stop_event(self) -> None:
        self._force_stopped = True
        if self._result is None:
            self.set_result(MessageEventResult().stop_event())
        else:
            self._result.stop_event()

    def continue_event(self) -> None:
        self._force_stopped = False
        if self._result is not None:
            self._result.continue_event()

    def is_stopped(self) -> bool:
        if self._force_stopped:
            return True
        if self._result is None:
            return False
        return self._result.is_stopped()

    def should_call_llm(self, call_llm: bool) -> None:
        self.call_llm = call_llm

    # ---------- 构造结果 ----------

    def make_result(self) -> MessageEventResult:
        return MessageEventResult()

    def plain_result(self, text: str) -> MessageEventResult:
        return MessageEventResult().message(str(text))

    def image_result(self, url_or_path: str) -> MessageEventResult:
        result = MessageEventResult()
        if str(url_or_path).startswith("http"):
            result.url_image(url_or_path)
        else:
            result.file_image(url_or_path)
        return result

    def chain_result(self, chain: List[BaseMessageComponent]) -> MessageEventResult:
        result = MessageEventResult()
        result.chain = chain
        return result

    # ---------- 直接发送 ----------

    async def send(self, message: MessageChain) -> None:
        if self._bridge is None:
            raise RuntimeError("事件未接入 JiuLi 发送通道（兼容层内部错误）")
        elements = chain_to_elements(message)
        if elements:
            self._bridge.send(elements, event_id=self._event_id)

    async def send_streaming(self, generator: AsyncGenerator[MessageChain, None], use_fallback: bool = False) -> None:
        async for chunk in generator:
            await self.send(chunk)

    async def react(self, emoji: str) -> None:
        await self.send(MessageChain().message(emoji))

    async def send_typing(self) -> None:
        return None

    async def stop_typing(self) -> None:
        return None

    async def process_buffer(self, buffer: str, pattern: re.Pattern) -> str:
        return buffer

    # ---------- LLM（兼容层不接模型，给占位） ----------

    def request_llm(self, prompt: str = "", func_tool_manager=None, tool_set=None, session_id: str = "",
                    image_urls=None, audio_urls=None, contexts=None, system_prompt: str = "", conversation=None):
        req = _ProviderRequestStub(prompt, system_prompt)
        req.image_urls = image_urls or []
        req.audio_urls = audio_urls or []
        req.contexts = contexts or []
        req.session_id = session_id
        return req

    # ---------- 群信息 / 临时文件 ----------

    async def get_group(self, group_id: Optional[str] = None, **kwargs) -> Optional[Group]:
        return self.message_obj.group

    def track_temporary_local_file(self, path: str) -> None:
        self._tmp_files.append(path)

    def untrack_temporary_local_file(self, path: str) -> None:
        if path in self._tmp_files:
            self._tmp_files.remove(path)

    def cleanup_temporary_local_files(self) -> None:
        self._tmp_files.clear()


class AiocqhttpMessageEvent(AstrMessageEvent):
    """真实插件会 isinstance(event, AiocqhttpMessageEvent)；事件里多了 event.bot"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.bot = _BotStub(self._bridge, self._event_id)


# 其它平台子类别名：插件一般只做 isinstance 判断，行为与基类一致
class TelegramMessageEvent(AstrMessageEvent):
    pass


class QQOfficialMessageEvent(AstrMessageEvent):
    pass


# ==================== 组件 ↔ 通用元素 ====================


def chain_to_elements(chain: Any) -> List[dict]:
    """MessageChain / list[component] → JiuLi 通用元素"""
    components = chain.chain if isinstance(chain, MessageChain) else chain
    out: List[dict] = []
    for comp in components or []:
        if comp is None:
            continue
        t = getattr(comp, "type", None)
        if t == "text":
            out.append({"type": "text", "text": comp.text})
        elif t == "image":
            src = comp.url or comp.file or comp.path or ""
            out.append({"type": "image", "url": _as_uri(src)})
        elif t == "at":
            out.append({"type": "at", "id": str(comp.qq)})
        elif t == "face":
            out.append({"type": "face", "id": str(comp.id)})
        elif t == "reply":
            out.append({"type": "reply", "id": str(comp.id)})
        elif t == "record":
            out.append({"type": "record", "url": _as_uri(comp.url or comp.file or "")})
        elif t == "video":
            out.append({"type": "video", "url": _as_uri(comp.url or comp.file or "")})
        elif t == "file":
            out.append({"type": "file", "url": _as_uri(comp.url or comp.file or ""), "name": comp.name})
        elif t == "json":
            out.append({"type": "json", "data": comp.data})
        else:
            out.append({"type": "text", "text": str(comp)})
    return out


def _as_uri(src: str) -> str:
    if not src:
        return ""
    if src.startswith("http") or src.startswith("base64://") or src.startswith("data:") or src.startswith("file:"):
        return src
    import os
    from pathlib import Path

    if os.path.exists(src):
        return Path(os.path.abspath(src)).as_uri()
    return src


def element_to_component(el: dict) -> BaseMessageComponent:
    """JiuLi 通用元素 → AstrBot 组件（入站用）"""
    from ._message import Face, Poke, Record, Reply, Video, File

    t = el.get("type")
    if t == "text":
        return Plain(el.get("text", ""))
    if t == "image":
        return Image(file=el.get("url", ""), url=el.get("url", "") if str(el.get("url", "")).startswith("http") else "")
    if t == "at":
        return At(qq=str(el.get("id", "")))
    if t == "face":
        return Face(id=el.get("id", 0))
    if t == "reply":
        return Reply(id=el.get("id", ""))
    if t == "record":
        return Record(file=el.get("url", ""))
    if t == "video":
        return Video(file=el.get("url", ""))
    if t == "file":
        return File(name=el.get("name") or "file", file=el.get("url", ""))
    if t == "poke":
        return Poke()
    return Plain(el.get("text", ""))
