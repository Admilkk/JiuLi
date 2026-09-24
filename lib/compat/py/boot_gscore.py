"""
GsCore（早苗 / gsuid_core）兼容引导脚本

做四件事：
  1. 把插件目录加进 sys.path，逐个 import 插件模块（触发器是 import 的副作用，没有清单文件）
  2. 按 Plugins 配置展开命令前缀（与真实 GsCore 一致）
  3. 跑启动前/启动后钩子，拉起 scheduler
  4. 把 JiuLi 的事件翻成 GsCore 的 Event，按 SV 优先级依次匹配触发器并调用 handler

匹配与派发语义照 gsuid_core 源码（handler.py / trigger.py）实现：
  - on_message 单独先派发（不参与 block）
  - 其余触发器按 (是否带前缀, SV 优先级) 排序；block=True 命中后停止后续
  - receive_resp 的多步会话在触发器匹配之前先消费消息
"""

import asyncio
import copy
import importlib
import os
import sys
import traceback
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from jiuli_bridge import spawn  # noqa: E402  放在 sys.path 调整之后

from gsuid_core.aps import scheduler  # noqa: E402
from gsuid_core.bot import Bot, resolve_waiter  # noqa: E402
from gsuid_core.models import Event  # noqa: E402
from gsuid_core.server import after_hooks, before_hooks  # noqa: E402
from gsuid_core.sv import SL, SV, _PREFIXLESS_TYPES  # noqa: E402

PLUGIN_DIR = Path(os.environ.get("JIULI_PLUGIN_DIR", "plugins/compat/pkgs/gscore"))


# 插件加载


def iter_plugin_modules():
    """产出 (插件名, 模块名)：目录型（有 __init__.py）与单文件型都支持"""
    if not PLUGIN_DIR.exists():
        return
    for entry in sorted(os.listdir(PLUGIN_DIR)):
        full = PLUGIN_DIR / entry
        if entry.startswith((".", "_")):
            continue
        if full.is_dir():
            if (full / "__init__.py").exists():
                yield entry, entry
        elif full.suffix == ".py":
            yield full.stem, full.stem


def load_plugins(bridge):
    loaded = []
    if str(PLUGIN_DIR) not in sys.path:
        sys.path.insert(0, str(PLUGIN_DIR))

    # 订阅推送需要往 JiuLi 发消息，把桥接实例交给它
    from gsuid_core.subscribe import gs_subscribe

    gs_subscribe.bind(bridge)

    for name, module_name in iter_plugin_modules():
        try:
            importlib.import_module(module_name)
            loaded.append(name)
            bridge.log("info", f"已加载 GsCore 插件 {name}")
        except Exception:
            bridge.log("error", f"GsCore 插件 {name} 加载失败：\n{traceback.format_exc()}")

    _expand_prefixes(bridge)
    bridge.on_event(handle_event)
    return loaded


def _expand_prefixes(bridge):
    """
    真实 GsCore 会把 Plugins 里声明的前缀加到每个触发器关键词前面：
    prefix=['gs'] + on_command('查询深渊')  →  'gs查询深渊' / '查询深渊'（allow_empty_prefix 时）
    """
    for sv in SV.registry:
        # Plugins 是按插件名（目录名）配置的，不是按 SV 名
        plugins = sv.plugins or SL.plugins.get(sv.self_plugin_name) or SL.plugins.get(sv.name)
        if not plugins:
            continue
        for type_name, triggers in list(sv.TL.items()):
            if type_name in _PREFIXLESS_TYPES:
                continue
            expanded = {}
            for keyword, trigger in triggers.items():
                if type_name == "regex":
                    # 正则保持原样，前缀只在匹配时用来裁剪文本
                    for prefix in plugins.get_prefixs() or [""]:
                        clone = copy.copy(trigger)
                        clone.prefix = prefix
                        expanded[keyword] = clone
                    continue
                for prefix in plugins.get_prefixs() or [""]:
                    head = f"{prefix}{keyword}"
                    expanded[head] = trigger.__class__(
                        type_name, head, trigger.func, prefix="", block=trigger.block, to_me=trigger.to_me
                    )
            sv.TL[type_name] = expanded
        bridge.log("debug", f"插件 {plugins.name} 前缀展开完成")


# 事件派发


def _event_of(raw: dict) -> Event:
    """
    通用事件（camelCase）→ GsCore 的 Event（snake_case）。
    必须逐字段映射：插件读 ev.user_id / ev.group_id / ev.bot_id 做绑定与数据库查询，
    漏一个字段业务就会"查不到绑定"，而且不报错。
    """
    ev = Event(
        {
            "bot_id": raw.get("selfId") or "",
            "bot_self_id": raw.get("selfId") or "",
            "user_id": raw.get("userId") or "",
            "group_id": raw.get("groupId") or None,
            "user_type": "group" if raw.get("isGroup") else "direct",
            "sender": raw.get("sender") or {},
            "msg_id": raw.get("messageId") or "",
            "raw_text": raw.get("text") or "",
            "elements": raw.get("elements") or [],
            "post_type": raw.get("postType") or "message",
            "is_tome": bool((raw.get("raw") or {}).get("atBot")),
            "_id": raw.get("_id"),
        }
    )
    ev.WS_BOT_ID = ev.bot_id
    ev.real_bot_id = ev.bot_id
    # 私聊视为直视机器人（与真实源码一致）
    if not ev.group_id:
        ev.is_tome = True
    return ev


async def _call(sv, trigger, ev, bridge):
    """复制事件、填充 command/text、调用 handler"""
    _event = copy.deepcopy(ev)
    _event.task_id = f"{sv.name}-{trigger.keyword}"
    await trigger.get_command(_event)
    bot = Bot(bridge, _event)
    ret = trigger.func(bot, _event)
    if hasattr(ret, "__await__"):
        await ret
    return True


async def handle_event(raw: dict, bridge) -> bool:
    before = bridge.sent
    ev = _event_of(raw)

    # 多步会话优先：正在 receive_resp 的会话，这条消息直接交给它
    if resolve_waiter(ev):
        bridge.log("debug", f"receive_resp 消费了 {ev.user_id} 的消息")
        return True

    # on_message 单独先派发，且不参与 block
    for sv in SV.registry:
        if not sv.available:
            continue
        for trigger in sv.TL.get("message", {}).values():
            await _call(sv, trigger, ev, bridge)
            return bridge.sent > before

    candidates = []
    for sv in SV.registry:
        if not sv.available:
            continue
        for type_name, triggers in sv.TL.items():
            if type_name == "message":
                continue
            for trigger in triggers.values():
                if trigger.check_command(ev):
                    candidates.append((sv, trigger))

    if not candidates:
        return False

    # (是否带前缀, SV 优先级)：带前缀的排在前面
    candidates.sort(key=lambda pair: (not bool(pair[1].prefix), pair[0].priority or 5))

    blocked = False
    for sv, trigger in candidates:
        await _call(sv, trigger, ev, bridge)
        if getattr(trigger, "block", False):
            bridge.log("debug", f"{sv.name}/{trigger.keyword} block=True，停止后续触发器")
            blocked = True
            break

    # 拦截条件：插件真的发了消息，或命中了 block=True 的触发器。
    # 只「匹配上但没回复」不算拦截 —— 否则一个 on_message 就能吞掉 JiuLi 所有云崽插件。
    return bridge.sent > before or blocked


# 启动


async def main():
    import jiuli_bridge

    async def run_load(bridge):
        plugins = load_plugins(bridge)
        # 启动前钩子（阻塞）
        for hook in before_hooks():
            try:
                ret = hook()
                if hasattr(ret, "__await__"):
                    await ret
            except Exception:
                bridge.log("error", f"on_core_start_before 钩子出错：\n{traceback.format_exc()}")
        # 定时任务
        try:
            if hasattr(scheduler, "start") and not getattr(scheduler, "running", True):
                scheduler.start()
        except Exception:
            bridge.log("warn", f"scheduler 启动失败：{traceback.format_exc()}")
        # 启动后钩子（后台）
        for hook in after_hooks():
            try:
                ret = hook()
                if hasattr(ret, "__await__"):
                    asyncio.create_task(ret)
            except Exception:
                bridge.log("error", f"on_core_start 钩子出错：\n{traceback.format_exc()}")
        return plugins

    return await jiuli_bridge.spawn(run_load, "GsCore")


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)
