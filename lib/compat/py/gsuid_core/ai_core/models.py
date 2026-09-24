"""gsuid_core.ai_core.models 仿制"""

from typing import Any, Dict, Optional


class ToolContext:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class ToolResult:
    def __init__(self, content: Any = "", **kwargs):
        self.content = content
        self.__dict__.update(kwargs)


class KnowledgeBaseItem:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


__all__ = ["KnowledgeBaseItem", "ToolContext", "ToolResult"]
