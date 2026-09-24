"""gsuid_core.pool 仿制：线程池辅助"""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

_executor = ThreadPoolExecutor(max_workers=10, thread_name_prefix="gsuid")


async def to_thread(func: Callable, *args: Any, **kwargs: Any) -> Any:
    loop = asyncio.get_running_loop()
    if kwargs:
        from functools import partial

        func = partial(func, **kwargs)
    return await loop.run_in_executor(_executor, func, *args)


def run_sync(coro):
    return asyncio.run(coro)


__all__ = ["run_sync", "to_thread"]
