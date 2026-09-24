"""astrbot.core.agent.tool 仿制：FunctionTool / ToolSet"""

from typing import Any, Callable, Dict, List, Optional


class FunctionTool:
    def __init__(self, name: str = "", description: str = "", parameters: Optional[dict] = None,
                 func: Optional[Callable] = None, **kwargs):
        self.name = name
        self.description = description
        self.parameters = parameters or {}
        self.func = func
        self.__dict__.update(kwargs)

    async def call(self, **kwargs):
        if self.func is None:
            raise NotImplementedError("该工具没有绑定函数")
        ret = self.func(**kwargs)
        if hasattr(ret, "__await__"):
            return await ret
        return ret


class ToolSet:
    def __init__(self, tools: Optional[List[FunctionTool]] = None):
        self.tools = tools or []

    def add(self, tool: FunctionTool):
        self.tools.append(tool)
        return self

    def __iter__(self):
        return iter(self.tools)


class BaseFunctionToolExecutor:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


__all__ = ["BaseFunctionToolExecutor", "FunctionTool", "ToolSet"]
