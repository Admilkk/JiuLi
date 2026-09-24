"""astrbot.api.provider 仿制：Provider 相关类型（兼容层不接模型，全部为占位）"""

import enum
from typing import Any, List, Optional


class ProviderType(enum.Enum):
    CHAT_COMPLETION = enum.auto()
    SPEECH_TO_TEXT = enum.auto()
    TEXT_TO_SPEECH = enum.auto()
    EMBEDDING = enum.auto()
    RERANK = enum.auto()


class ProviderMetaData:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class ProviderRequest:
    def __init__(self, prompt: str = "", system_prompt: str = "", **kwargs):
        self.prompt = prompt
        self.system_prompt = system_prompt
        self.image_urls: List[str] = []
        self.audio_urls: List[str] = []
        self.contexts: List[Any] = []
        self.extra_user_content_parts: List[Any] = []
        self.func_tool = None
        self.session_id = ""
        self.conversation = None
        self.__dict__.update(kwargs)


class LLMResponse:
    def __init__(self, role: str = "assistant", completion_text: str = "", **kwargs):
        self.role = role
        self.completion_text = completion_text
        self.raw_completion = kwargs.get("raw_completion")
        self.tools_call_name: List[str] = []
        self.tools_call_args: List[dict] = []
        self.tools_call_ids: List[str] = []
        self.__dict__.update(kwargs)


class Provider:
    def __init__(self, *args, **kwargs):
        pass

    def meta(self) -> ProviderMetaData:
        return ProviderMetaData()


class Personality:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


STTProvider = Provider
TTSProvider = Provider
EmbeddingProvider = Provider
RerankProvider = Provider

__all__ = [
    "EmbeddingProvider",
    "LLMResponse",
    "Personality",
    "Provider",
    "ProviderMetaData",
    "ProviderRequest",
    "ProviderType",
    "RerankProvider",
    "STTProvider",
    "TTSProvider",
]
