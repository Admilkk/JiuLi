"""gsuid_core.segment 仿制：MessageSegment（图片/文本/按钮/文件等消息段工厂）"""

import base64
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from .models import Message

try:  # pragma: no cover
    from PIL import Image
except Exception:
    Image = None  # type: ignore


class MessageSegment:
    """真实源码返回 Message（不是子类），这里保持一致"""

    def __add__(self, other):
        return [self, other]

    @staticmethod
    def _image_data(img: Any) -> str:
        if Image is not None and isinstance(img, Image.Image):
            from io import BytesIO

            buf = BytesIO()
            img.convert("RGBA").save(buf, format="PNG")
            return "base64://" + base64.b64encode(buf.getvalue()).decode()
        if isinstance(img, (bytes, bytearray)):
            return "base64://" + base64.b64encode(bytes(img)).decode()
        text = str(img)
        if text.startswith("http"):
            return f"link://{text}"
        if text.startswith("file://") or text.startswith("base64://"):
            return text
        p = Path(text)
        if p.exists():
            return "base64://" + base64.b64encode(p.read_bytes()).decode()
        return text

    @staticmethod
    def image(img: Any) -> Message:
        return Message("image", MessageSegment._image_data(img))

    @staticmethod
    def text(content: str) -> Message:
        return Message("text", str(content))

    @staticmethod
    def at(user: str) -> Message:
        return Message("at", str(user))

    @staticmethod
    def buttons(buttons: Optional[Union[List[Any], List[List[Any]]]] = None) -> Message:
        return Message("buttons", buttons or [])

    @staticmethod
    def template_buttons(template_id: str) -> Message:
        return Message("template_buttons", template_id)

    @staticmethod
    def markdown(content: str, buttons: Optional[List[Any]] = None) -> List[Message]:
        out = [Message("markdown", content)]
        if buttons:
            out.append(Message("buttons", buttons))
        return out

    @staticmethod
    def template_markdown(template_id: str, para: Dict[str, str], buttons: Optional[List[Any]] = None) -> List[Message]:
        out = [Message("template_markdown", {"template_id": template_id, "para": para})]
        if buttons:
            out.append(Message("buttons", buttons))
        return out

    @staticmethod
    def image_size(size: Tuple[int, int]) -> Message:
        return Message("image_size", size)

    @staticmethod
    def node(content_list: Union[List[Message], List[str], List[bytes]]) -> Message:
        items = []
        for item in content_list:
            if isinstance(item, Message):
                items.append(item)
            elif isinstance(item, (bytes, bytearray)):
                items.append(MessageSegment.image(item))
            else:
                items.append(Message("text", str(item)))
        return Message("node", items)

    @staticmethod
    def record(content: Any) -> Message:
        return Message("record", MessageSegment._image_data(content).replace("link://", ""))

    @staticmethod
    def file(content: Union[Path, str, bytes], file_name: str) -> Message:
        if isinstance(content, (bytes, bytearray)):
            data = "base64://" + base64.b64encode(bytes(content)).decode()
        else:
            text = str(content)
            if text.startswith("http"):
                data = f"link://{text}"
            elif Path(text).exists():
                data = "base64://" + base64.b64encode(Path(text).read_bytes()).decode()
            else:
                data = text
        return Message("file", f"{file_name}|{data}")

    @staticmethod
    def video(content: Any) -> Message:
        return Message("video", MessageSegment._image_data(content))

    @staticmethod
    def log(type: str, content: str) -> Message:
        return Message("log", f"{type}|{content}")


__all__ = ["MessageSegment"]
