"""
gsuid_core.bot 仿制：Bot 对象与消息发送

插件拿到的 Bot 是「这次事件的发送手柄」：`await bot.send(...)`。
真实 GsCore 里 Bot 走早柚协议 WS 到适配器，这里直接转成通用元素交给 JiuLi。

同时提供 bot.receive_resp()（多步会话）：GsCore 里它会挂起当前处理器，
等下一条同会话消息到来再返回。这里用一层 waiter 注册表实现，
boot 脚本在触发匹配之前先查表，所以不会有第二条消息被别的指令抢走的问题。
"""

import asyncio
import base64
import os
from typing import Any, Dict, List, Optional, Union

from .models import Event, Message, MessageReceive

IMAGE_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")

# 会话 key → Future[Event]；receive_resp 注册，boot 的事件入口消费
_WAITERS: Dict[str, asyncio.Future] = {}


def session_key(ev: Event) -> str:
    return f"{ev.bot_id}:{ev.group_id or ev.user_id}"


def resolve_waiter(ev: Event) -> bool:
    """
    boot 在触发匹配前调用：如果这个会话正在等下一次输入，就把消息交给它。
    返回 True 表示这条消息已被 receive_resp 消费，不应再走触发器匹配。
    """
    fut = _WAITERS.pop(session_key(ev), None)
    if fut is None or fut.done():
        return False
    loop = fut.get_loop()
    loop.call_soon_threadsafe(fut.set_result, ev)
    return True


def _element_of(item: Any) -> Optional[Dict[str, Any]]:
    """把插件传来的任意东西转成通用元素"""
    if item is None:
        return None
    if isinstance(item, Message):
        return _element_of_message(item)
    if isinstance(item, (bytes, bytearray)):
        return {"type": "image", "url": "data:image/png;base64," + base64.b64encode(bytes(item)).decode()}
    if isinstance(item, (list, tuple)):
        return None  # 由调用方展开
    text = str(item)
    if text.startswith("base64://"):
        return {"type": "image", "url": "data:image/png;base64," + text[len("base64://"):]}
    if text.startswith("data:") and ";base64," in text:
        return {"type": "image", "url": text}
    if len(text) < 512 and text.lower().endswith(IMAGE_EXT) and os.path.exists(text):
        return {"type": "image", "url": "file://" + os.path.abspath(text)}
    return {"type": "text", "text": text}


def _element_of_message(msg: Message) -> Optional[Dict[str, Any]]:
    t = (msg.type or "text").lower()
    data = msg.data
    if t in ("text", "plain"):
        return {"type": "text", "text": str(data)}
    if t in ("image", "img"):
        return _element_of(data) if isinstance(data, (bytes, bytearray)) else _image_element(data)
    if t == "at":
        return {"type": "at", "id": str(data)}
    if t in ("record", "audio", "voice"):
        return {"type": "record", "url": _url_of(data)}
    if t == "video":
        return {"type": "video", "url": _url_of(data)}
    if t == "file":
        return {"type": "file", "url": _url_of(data), "name": getattr(msg, "name", None)}
    if t in ("markdown", "buttons", "button"):
        return {"type": t, "data": data}
    return {"type": "text", "text": str(data)}


def _url_of(data: Any) -> str:
    if isinstance(data, (bytes, bytearray)):
        return "data:application/octet-stream;base64," + base64.b64encode(bytes(data)).decode()
    text = str(data)
    if text.startswith("base64://"):
        return "data:application/octet-stream;base64," + text[len("base64://"):]
    if len(text) < 512 and os.path.exists(text):
        return "file://" + os.path.abspath(text)
    return text


def _image_element(data: Any) -> Dict[str, Any]:
    return {"type": "image", "url": _url_of(data)}


def to_elements(message: Any) -> List[Dict[str, Any]]:
    """str / bytes / Message / list 混合 → 通用元素数组"""
    if message is None:
        return []
    if isinstance(message, (list, tuple)):
        out: List[Dict[str, Any]] = []
        for item in message:
            out.extend(to_elements(item))
        return out
    el = _element_of(message)
    if el is None:
        return []
    return [el]


class Bot:
    def __init__(self, bridge, ev: Event):
        self.bridge = bridge
        self.ev = ev
        self.bot_id = ev.bot_id
        self.self_id = ev.bot_id
        self.bot_self_id = ev.bot_self_id or ev.bot_id
        self.user_id = ev.user_id
        self.group_id = ev.group_id
        self.uid = ev.user_id
        self.temp_gid = ev.group_id or ""
        self.bid = ev.bot_id
        # 真实源码里多步会话用的是这个格式的 session id，与 Event.session_id 不同
        self.session_id = f"{self.bid}%%%{self.temp_gid}%%%{self.uid}"

    # ---- 发送 ----

    async def send(
        self,
        message: Any = "",
        at_sender: bool = False,
        extra_metadata: Optional[dict] = None,
        wait_recall: bool = False,
    ):
        elements = to_elements(message)
        if at_sender and self.ev.group_id:
            elements = [{"type": "at", "id": str(self.ev.user_id)}] + elements
        if not elements:
            return None
        self.bridge.send(elements, event_id=self.ev._id)
        return None

    async def send_option(self, reply: Any = None, option_list=None, unsuported_platform: bool = False, **kwargs):
        """只发按钮/选项，不等待回复"""
        return await self.send(reply)

    async def t(self, key: str, /, **params) -> str:
        """真实 GsCore 的 i18n：bot.t('...')。兼容层直接返回原文（支持 {p0} 占位）"""
        text = str(key)
        if params:
            try:
                return text.format(**params)
            except Exception:
                return text
        return text

    async def get_lang(self) -> str:
        return "zh_CN"

    async def target_send(self, message: Any = "", target_type: str = "", target_id: str = "", **kwargs):
        elements = to_elements(message)
        if not elements:
            return None
        self.bridge.send(
            elements,
            target={"isGroup": str(target_type).lower() == "group", "channelId": str(target_id), "selfId": self.bot_id},
        )
        return None

    # 平台动作：兼容层不代理这些，给明确日志而不是静默
    async def ban(self, *args, **kwargs):
        self.bridge.log("warn", "插件调用了 bot.ban()，JiuLi 的 GsCore 兼容层暂未代理禁言")
        return None

    async def unsend(self, *args, **kwargs):
        self.bridge.log("warn", "插件调用了 bot.unsend()，JiuLi 的 GsCore 兼容层暂未代理撤回")
        return None

    # ---- 多步会话 ----

    async def receive_resp(
        self,
        reply: Any = None,
        option_list=None,
        unsuported_platform: bool = False,
        is_mutiply: bool = False,
        is_recive: bool = True,
        timeout: float = 60,
        sep: str = "\n",
        command_tips: str = "请输入以下命令之一:",
        command_start_text: str = "",
        at_sender: bool = False,
        **kwargs,
    ) -> Optional[Event]:
        """
        挂起当前处理器，等下一条同会话消息。
        返回 Event（与真实 GsCore 一致：插件取 resp.text）或 None（超时）。
        """
        if reply is not None and is_recive:
            text = str(reply)
            if option_list:
                options = []
                for item in option_list:
                    options.append(getattr(item, "text", None) or str(item))
                text = f"{text}\n{command_tips}\n" + sep.join(options)
            await self.send(text)
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        key = session_key(self.ev)
        _WAITERS[key] = fut
        try:
            ev = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            _WAITERS.pop(key, None)
            return None
        return ev

    async def receive_mutiply_resp(self, *args, **kwargs):
        """群内任意用户的后续消息。兼容层按同会话处理（不做用户过滤）"""
        return await self.receive_resp(*args, **kwargs)

    async def wait_for_key(self, timeout: float = 60) -> Optional[Event]:
        return await self.receive_resp(timeout=timeout)

    def set_event(self, ev: Event):
        self.ev = ev
        return self


__all__ = ["Bot", "resolve_waiter", "session_key", "to_elements"]
