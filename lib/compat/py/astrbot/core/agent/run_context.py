"""astrbot.core.agent.run_context 仿制"""

from typing import Any, Dict, List


class AgentContext:
    def __init__(self, **kwargs):
        self.messages: List[Any] = []
        self.tools: List[Any] = []
        self.__dict__.update(kwargs)


RunContext = AgentContext

__all__ = ["AgentContext", "RunContext"]
