"""
gsuid_core.aps 仿制：定时任务

真实 GsCore 用 APScheduler。装了 apscheduler 就直接用真的（行为最一致）；
没装则退化为一个只支持 interval / 简单 cron 的轻量实现，够把插件的每日任务跑起来。
"""

import asyncio
import inspect
import time
from typing import Any, Callable, Dict, List

_HAS_APS = False
try:  # pragma: no cover - 取决于环境是否装了 apscheduler
    from apscheduler.schedulers.asyncio import AsyncIOScheduler

    scheduler = AsyncIOScheduler()
    _HAS_APS = True
except Exception:
    pass


class _FallbackJob:
    def __init__(self, func: Callable, trigger: str, kwargs: Dict[str, Any]):
        self.func = func
        self.trigger = trigger
        self.kwargs = kwargs
        self.interval = _interval_seconds(trigger, kwargs)
        self.at = _daily_seconds(trigger, kwargs)
        self.task = None

    async def _run_forever(self):
        while True:
            if self.at is not None:
                now = time.localtime()
                delta = (self.at - (now.tm_hour * 3600 + now.tm_min * 60 + now.tm_sec)) % 86400 or 86400
                await asyncio.sleep(delta)
            else:
                await asyncio.sleep(self.interval or 60)
            try:
                ret = self.func()
                if inspect.isawaitable(ret):
                    await ret
            except Exception as err:  # 定时任务出错不能拖垮调度器
                print(f"[gsuid_core.aps] 定时任务 {getattr(self.func, '__name__', self.func)} 出错：{err}")

    def start(self):
        self.task = asyncio.get_running_loop().create_task(self._run_forever())

    def remove(self):
        if self.task:
            self.task.cancel()


def _interval_seconds(trigger: str, kwargs: Dict[str, Any]):
    if trigger != "interval":
        return None
    total = 0
    for unit, factor in (("weeks", 604800), ("days", 86400), ("hours", 3600), ("minutes", 60), ("seconds", 1)):
        total += int(kwargs.get(unit) or 0) * factor
    return total or 60


def _daily_seconds(trigger: str, kwargs: Dict[str, Any]):
    if trigger != "cron":
        return None
    if kwargs.get("hour") is None:
        return None
    return int(kwargs.get("hour") or 0) * 3600 + int(kwargs.get("minute") or 0) * 60


class _FallbackScheduler:
    def __init__(self):
        self.jobs: List[_FallbackJob] = []

    def scheduled_job(self, trigger: str = "interval", **kwargs):
        def decorator(func: Callable) -> Callable:
            self.jobs.append(_FallbackJob(func, trigger, kwargs))
            return func

        return decorator

    def add_job(self, func: Callable, trigger: str = "interval", **kwargs):
        job = _FallbackJob(func, trigger, kwargs)
        self.jobs.append(job)
        return job

    def start(self):
        for job in self.jobs:
            job.start()

    def shutdown(self, wait: bool = False):
        for job in self.jobs:
            job.remove()


if not _HAS_APS:
    scheduler = _FallbackScheduler()  # type: ignore[assignment]

__all__ = ["scheduler"]
