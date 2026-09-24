"""gsuid_core.utils.message 仿制：给主人/多目标发消息"""

from typing import Any, List, Optional

from ..bot import Bot


async def send_msg_to_master(content: Any, bot: Optional[Bot] = None) -> bool:
    """主人推送：兼容层直接打日志（没有主人账号表）"""
    if bot is not None:
        await bot.send(f"[发给主人] {content}")
    else:
        import sys

        sys.stderr.write(f"[gsuid_core.utils.message] 主人消息：{content}\n")
    return True


async def send_diff_msg(bot: Bot, code: Any, msgs: Any) -> None:
    """按返回码取不同文案发给用户"""
    text = msgs.get(code, msgs.get("default", str(code))) if isinstance(msgs, dict) else str(msgs)
    await bot.send(text)


__all__ = ["send_diff_msg", "send_msg_to_master"]
