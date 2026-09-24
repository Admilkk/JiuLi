"""gsuid_core.utils.database.api 仿制：get_uid 等便捷查询"""

import re
from typing import Any, Optional, Type

from ...models import Event


async def get_uid(
    bot,
    ev: Event,
    bind_model: Type,
    game_name: Optional[str] = None,
    get_user_id: bool = False,
    pattern: str = r"\d+",
    **kwargs,
):
    """
    真实语义：先看消息里有没有直接给的 uid，没有再查该用户的绑定。
    返回 (uid, user_id) 或 uid（取决于 get_user_id）。
    """
    text = (ev.raw_text or "") + " " + (ev.text or "")
    matched = re.findall(pattern, text)
    for candidate in matched:
        if len(candidate) >= 9:  # 游戏 uid 普遍 9 位以上
            return (candidate, ev.user_id) if get_user_id else candidate

    if game_name:
        uid = await bind_model.get_uid_by_game(ev.user_id, game_name, ev.bot_id)
    else:
        uids = await bind_model.get_uid_list_by_game(ev.user_id, ev.bot_id)
        uid = uids[0] if uids else None
    if get_user_id:
        return (uid, ev.user_id)
    return uid


async def get_uid_list(bot, ev: Event, bind_model: Type, game_name: Optional[str] = None, **kwargs):
    if game_name:
        return await bind_model.get_uid_list_by_game(ev.user_id, ev.bot_id, game_name)
    return await bind_model.get_uid_list_by_game(ev.user_id, ev.bot_id)


__all__ = ["get_uid", "get_uid_list"]
