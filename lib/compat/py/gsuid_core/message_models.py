"""gsuid_core.message_models 仿制：Button 等消息模型"""

from typing import List, Optional

from .models import Message, MessageReceive


class Button:
    """
    真实源码是 msgspec.Struct。注意 `permisson` 的拼写就是少一个 i —— 必须照抄，
    否则插件用关键字构造时会 TypeError。
    """

    def __init__(
        self,
        text: str = "",
        data: str = "",
        pressed_text: Optional[str] = None,
        style: int = 1,
        action: int = -1,
        permisson: int = 2,
        specify_role_ids: Optional[List[str]] = None,
        specify_user_ids: Optional[List[str]] = None,
        unsupport_tips: str = "您的客户端暂不支持该功能, 请升级后适配...",
        prefix: str = "",
        **kwargs,
    ):
        self.text = text
        self.data = data
        self.pressed_text = pressed_text
        self.style = style
        self.action = action
        self.permisson = permisson
        self.permission = permisson  # 拼错的那个也留一份只读别名
        self.specify_role_ids = specify_role_ids or []
        self.specify_user_ids = specify_user_ids or []
        self.unsupport_tips = unsupport_tips
        self.prefix = prefix
        self._edited = False

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "data": self.data,
            "pressed_text": self.pressed_text,
            "style": self.style,
            "action": self.action,
            "permisson": self.permisson,
            "specify_role_ids": self.specify_role_ids,
            "specify_user_ids": self.specify_user_ids,
            "unsupport_tips": self.unsupport_tips,
        }


ButtonType = List[Button]

__all__ = ["Button", "ButtonType", "Message", "MessageReceive"]
