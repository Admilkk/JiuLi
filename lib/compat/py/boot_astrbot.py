"""
AstrBot（Star）兼容引导脚本

做四件事：
  1. 扫描插件目录，加载含 main.py 的插件（metadata.yaml 覆盖元数据，_conf_schema.json 生成配置）
  2. 实例化 Star 子类并幂等二次绑定 handler
  3. 调 initialize() / on_astrbot_loaded 钩子
  4. 把 JiuLi 事件翻成 AstrMessageEvent，按 priority 顺序跑 filter 链、调用 handler、把 yield 的结果发回去

派发前必须写好的字段（真实源码由 pipeline 写，不写就会出现「管理员指令对所有人放行」这类问题）：
  role、is_wake、is_at_or_wake_command、message_obj.type / .group、platform_meta.name / .id
"""

import asyncio
import inspect
import os
import sys
import traceback
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from jiuli_bridge import spawn  # noqa: E402

from astrbot._event import AiocqhttpMessageEvent, chain_to_elements, element_to_component  # noqa: E402
from astrbot._filter import (  # noqa: E402
    EventType,
    _ParamError,
    star_handlers_registry,
)
from astrbot._message import (  # noqa: E402
    AstrBotMessage,
    Group,
    MessageEventResult,
    MessageMember,
    MessageType,
    PlatformMetadata,
)
from astrbot._star import (  # noqa: E402
    Context,
    StarTools,
    call_initialize,
    load_plugins,
    star_registry,
)

PLUGIN_DIR = Path(os.environ.get("JIULI_PLUGIN_DIR", "plugins/compat/pkgs/astrbot"))

# AstrBot 默认唤醒前缀
WAKE_PREFIX = ["/"]

PLATFORM_NAME = "aiocqhttp"


# 事件构造


def _build_message(raw: dict) -> AstrBotMessage:
    msg = AstrBotMessage()
    is_group = bool(raw.get("isGroup"))
    msg.type = MessageType.GROUP_MESSAGE if is_group else MessageType.FRIEND_MESSAGE
    msg.self_id = raw.get("selfId") or ""
    msg.session_id = raw.get("channelId") or raw.get("userId") or ""
    msg.message_id = raw.get("messageId") or ""
    msg.timestamp = int((raw.get("time") or 0) / 1000) or 0
    sender = raw.get("sender") or {}
    msg.sender = MessageMember(user_id=raw.get("userId") or "", nickname=sender.get("name") or sender.get("nick"))
    if is_group:
        msg.group = Group(group_id=str(raw.get("groupId") or ""), group_name=(raw.get("raw") or {}).get("group_name"))
    msg.message = [element_to_component(el) for el in raw.get("elements") or []]
    msg.message_str = raw.get("text") or ""
    # raw_message 留在本进程内（真实源码里也是平台原始对象）
    msg.raw_message = raw.get("raw")
    return msg


def _is_wake(raw: dict) -> bool:
    return True


def _strip_wake_prefix(text: str):
    for prefix in WAKE_PREFIX:
        if prefix and text.startswith(prefix):
            return text[len(prefix):].lstrip(), True
    return text, False


# 派发


async def _run_handler(entry, event, bridge) -> bool:
    """跑一个 handler：filter 链 → 调用 → 发送 yield 出来的结果"""
    cfg = event.get_extra("_config") or {}
    # 每个 handler 重新解析参数：CommandFilter 会写 parsed_params，
    # 不清空的话上一个指令的参数会串给下一个 handler（真实源码里 params 是随 filter 走的）
    event.set_extra("parsed_params", [])
    for flt in entry.event_filters:
        try:
            if not flt.filter(event, cfg):
                return False
        except _ParamError as err:
            # 参数不全：真实 AstrBot 会把错误原因回给用户
            await event.send(MessageEventResult().message(str(err)))
            event.stop_event()
            return True
        except Exception:
            bridge.log("error", f"{entry.handler_full_name} 的过滤器出错：\n{traceback.format_exc()}")
            return False

    params = event.get_extra("parsed_params") or []
    handler = entry.handler
    try:
        if inspect.isasyncgenfunction(entry.raw_handler or handler):
            async for result in handler(event, *params):
                await _send_result(event, result)
        else:
            ret = handler(event, *params)
            if inspect.isasyncgen(ret):
                async for result in ret:
                    await _send_result(event, result)
            elif inspect.isawaitable(ret):
                result = await ret
                if result is not None:
                    await _send_result(event, result)
            elif ret is not None:
                await _send_result(event, ret)
    except Exception:
        bridge.log("error", f"插件 {entry.handler_full_name} 执行出错：\n{traceback.format_exc()}")
        for hook in _handlers_of(EventType.OnPluginErrorEvent):
            try:
                await _call_hook(hook, event)
            except Exception:
                pass
        return True
    return True


async def _send_result(event, result) -> None:
    if result is None:
        return
    if isinstance(result, str):
        result = MessageEventResult().message(result)
    elements = chain_to_elements(result)
    if elements:
        event._bridge.send(elements, event_id=event._event_id)


def _handlers_of(event_type: EventType):
    return [h for h in star_handlers_registry if h.event_type == event_type and h.enabled]


async def _call_hook(entry, event=None, *extra):
    handler = entry.handler
    args = [a for a in (event, *extra) if a is not None]
    try:
        ret = handler(*args) if not event else handler(event, *extra)
        if inspect.isawaitable(ret):
            await ret
    except Exception:
        pass


async def handle_event(raw: dict, bridge) -> bool:
    msg = _build_message(raw)
    text, stripped = _strip_wake_prefix(msg.message_str or "")

    platform_meta = PlatformMetadata(name=PLATFORM_NAME, id="jiuli", description="JiuLi")
    event = AiocqhttpMessageEvent(text, msg, platform_meta, msg.session_id)
    event._bridge = bridge
    event._event_id = raw.get("_id")
    event.bot = event.bot  # 已在 __init__ 里建好（_BotStub）

    # —— pipeline 必须写入的字段 ——
    sender_role = (raw.get("sender") or {}).get("role")
    event.role = "admin" if (raw.get("isMaster") or sender_role in ("owner", "admin")) else "member"
    event.is_wake = _is_wake(raw)
    event.is_at_or_wake_command = bool(
        not raw.get("isGroup") or raw.get("raw", {}).get("atBot") or raw.get("raw", {}).get("hasAlias") or stripped
    )
    event.set_extra("_config", bridge.globalConfigOf() if hasattr(bridge, "globalConfigOf") else {})

    # 钩子：等待 LLM 请求之前（这里只在需要时跑，普通消息不触发）
    for hook in _handlers_of(EventType.OnWaitingLLMRequestEvent):
        await _call_hook(hook, event)

    handled = False
    before = bridge.sent
    for entry in _handlers_of(EventType.AdapterMessageEvent):
        if await _run_handler(entry, event, bridge):
            handled = True
            if event.is_stopped():
                break
    # 拦截条件：插件真的发了消息，或主动 stop_event()。
    # 只「filter 通过但没回复」不算拦截（否则一个 event_message_type(ALL) 监听会吞掉所有云崽插件）
    return handled and (bridge.sent > before or event.is_stopped())


# 启动


async def main():
    import jiuli_bridge

    async def run_load(bridge):
        context = Context(bridge=bridge, config={})
        StarTools.initialize(context)
        plugins = load_plugins(PLUGIN_DIR, context, bridge)
        # initialize() 钩子
        for meta in star_registry:
            if meta.activated:
                try:
                    await call_initialize(meta)
                except Exception:
                    bridge.log("error", f"{meta.name} initialize() 出错：\n{traceback.format_exc()}")
        # on_astrbot_loaded
        for entry in _handlers_of(EventType.OnAstrBotLoadedEvent):
            try:
                ret = entry.handler()
                if inspect.isawaitable(ret):
                    await ret
            except Exception:
                bridge.log("error", f"on_astrbot_loaded 钩子出错：\n{traceback.format_exc()}")
        bridge.on_event(handle_event)
        return plugins

    return await jiuli_bridge.spawn(run_load, "AstrBot")


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)
