"""astrbot.core.agent.message 仿制：LLM 消息内容块（TextPart 等）"""

from typing import Any, Dict


class BasePart:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class TextPart(BasePart):
    type = "text"

    def __init__(self, text: str = "", **kwargs):
        super().__init__(text=text, **kwargs)

    def mark_as_temp(self):
        self.temp = True
        return self


class ImagePart(BasePart):
    type = "image"

    def __init__(self, image_url: str = "", **kwargs):
        super().__init__(image_url=image_url, **kwargs)


class AudioPart(BasePart):
    type = "audio"

    def __init__(self, audio_url: str = "", **kwargs):
        super().__init__(audio_url=audio_url, **kwargs)


__all__ = ["AudioPart", "BasePart", "ImagePart", "TextPart"]
