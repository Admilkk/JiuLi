"""gsuid_core.ai_core.rag 仿制：知识库查询（兼容层没有 RAG，返回空）"""

from typing import Any, List


async def query_knowledge(query: str, *args: Any, **kwargs: Any) -> List[Any]:
    return []


def register_knowledge(*args: Any, **kwargs: Any):
    return None


__all__ = ["query_knowledge", "register_knowledge"]
