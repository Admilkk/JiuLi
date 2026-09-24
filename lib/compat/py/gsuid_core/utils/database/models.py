"""
gsuid_core.utils.database.models 仿制：Bind / User / Push 与框架表

只实现真实插件最常用的那批方法（用 JSON 落盘），签名与真实源码一致。
没实现的方法**故意不定义** —— 插件用到时会 AttributeError 明确报错，
而不是返回空数据让业务静默错下去。
"""

import time
from typing import Any, Dict, List, Optional

from .base_models import BaseBotIDModel, BaseIDModel, BaseModel


class Bind(BaseModel):
    __table_name__ = "bind"

    @classmethod
    async def get_uid_list_by_game(cls, user_id: str, bot_id: str = "", game_name: str = "") -> List[str]:
        rows = await cls.select_rows(user_id=user_id, bot_id=bot_id, game_name=game_name)
        return [str(r.get("uid")) for r in rows if r.get("uid")]

    @classmethod
    async def get_uid_by_game(cls, user_id: str, game_name: str = "", bot_id: str = "") -> Optional[str]:
        rows = await cls.get_uid_list_by_game(user_id, bot_id, game_name)
        return rows[0] if rows else None

    @classmethod
    async def bind_exists(cls, user_id: str, uid: str, game_name: str = "", bot_id: str = "") -> bool:
        return await cls.data_exist(user_id=user_id, uid=uid, game_name=game_name, bot_id=bot_id)

    @classmethod
    async def insert_uid(
        cls,
        user_id: str,
        uid: str,
        bot_id: str = "",
        game_name: str = "",
        group_id: Optional[str] = None,
        **kwargs,
    ) -> bool:
        if await cls.bind_exists(user_id, uid, game_name, bot_id):
            return True
        await cls.insert_data(
            user_id=str(user_id),
            uid=str(uid),
            bot_id=str(bot_id),
            game_name=game_name,
            group_id=str(group_id) if group_id else None,
            **kwargs,
        )
        return True

    @classmethod
    async def delete_uid(cls, user_id: str, uid: str, game_name: str = "", bot_id: str = "") -> bool:
        return await cls.delete_row(user_id=user_id, uid=uid, game_name=game_name, bot_id=bot_id)

    @classmethod
    async def get_all_uid_list_by_game(cls, user_id: str, bot_id: str = "") -> List[str]:
        return await cls.get_uid_list_by_game(user_id, bot_id)

    @classmethod
    async def switch_uid_by_game(cls, user_id: str, uid: str, game_name: str = "", bot_id: str = "") -> bool:
        return await cls.update_data({"uid": str(uid)}, user_id=user_id, game_name=game_name, bot_id=bot_id)

    @classmethod
    async def get_bind_group_list(cls, uid: str, game_name: str = "") -> List[str]:
        return await cls.get_distinct_list("group_id", uid=uid, game_name=game_name)

    @classmethod
    async def get_bind_group(cls, uid: str, game_name: str = "") -> Optional[str]:
        groups = await cls.get_bind_group_list(uid, game_name)
        return groups[0] if groups else None

    @classmethod
    async def get_group_all_uid(cls, group_id: str, game_name: str = "") -> List[str]:
        return await cls.get_distinct_list("uid", group_id=group_id, game_name=game_name)


class User(BaseModel):
    __table_name__ = "user"

    @classmethod
    async def select_data_by_uid(cls, uid: str, **kwargs) -> Optional[Dict[str, Any]]:
        return await cls.select_data(uid=str(uid), **kwargs)

    @classmethod
    async def get_user_attr(cls, user_id: str, attr: str, bot_id: str = "", **kwargs):
        row = await cls.select_data(user_id=str(user_id), bot_id=str(bot_id), **kwargs)
        return row.get(attr) if row else None

    @classmethod
    async def get_user_attr_by_uid(cls, uid: str, attr: str, bot_id: str = "", **kwargs):
        row = await cls.select_data(uid=str(uid), bot_id=str(bot_id), **kwargs)
        return row.get(attr) if row else None

    @classmethod
    async def get_user_cookie_by_uid(cls, uid: str, **kwargs) -> Optional[str]:
        return await cls.get_user_attr_by_uid(uid, "cookie", **kwargs)

    @classmethod
    async def get_user_stoken_by_uid(cls, uid: str, **kwargs) -> Optional[str]:
        return await cls.get_user_attr_by_uid(uid, "stoken", **kwargs)

    @classmethod
    async def mark_invalid(cls, uid: str, **kwargs) -> bool:
        return await cls.update_data({"status": "invalid"}, uid=str(uid), **kwargs)

    @classmethod
    async def cookie_validate(cls, uid: str, **kwargs) -> bool:
        status = await cls.get_user_attr_by_uid(uid, "status", **kwargs)
        return status != "invalid"

    @classmethod
    async def get_all_cookie(cls, bot_id: str = "") -> List[Dict[str, Any]]:
        return await cls.select_rows(bot_id=str(bot_id))

    get_all_stoken = get_all_cookie

    @classmethod
    async def get_all_user(cls, bot_id: str = "") -> List[Dict[str, Any]]:
        return await cls.select_rows(bot_id=str(bot_id))

    @classmethod
    async def get_all_push_user_list(cls) -> List[Dict[str, Any]]:
        return await cls.select_rows(push_switch=True)

    @classmethod
    async def get_all_sign_user_list(cls) -> List[Dict[str, Any]]:
        return await cls.select_rows(sign_switch=True)

    @classmethod
    async def delete_user_data_by_uid(cls, uid: str) -> bool:
        return await cls.delete_row(uid=str(uid))


class Cache(BaseIDModel):
    __table_name__ = "cache"

    @classmethod
    async def select_cache_cookie(cls, uid: str) -> Optional[str]:
        row = await cls.select_data(uid=str(uid))
        return row.get("cookie") if row else None

    @classmethod
    async def insert_cache_data(cls, uid: str, cookie: str, **kwargs) -> bool:
        if await cls.data_exist(uid=str(uid)):
            return await cls.update_data({"cookie": cookie}, uid=str(uid))
        await cls.insert_data(uid=str(uid), cookie=cookie, **kwargs)
        return True

    @classmethod
    async def delete_all_cache(cls) -> bool:
        return await cls.delete_row()


class Push(BaseBotIDModel):
    __table_name__ = "push"


class GsBind(Bind):
    __table_name__ = "gs_bind"


class GsUser(User):
    __table_name__ = "gs_user"


class GsCache(Cache):
    __table_name__ = "gs_cache"


class GsPush(Push):
    __table_name__ = "gs_push"


class GsUID(BaseIDModel):
    __table_name__ = "gs_uid"


class Subscribe(BaseIDModel):
    __table_name__ = "subscribe"


class CoreUser(BaseModel):
    __table_name__ = "core_user"


class CoreGroup(BaseBotIDModel):
    __table_name__ = "core_group"


class CoreTag(BaseIDModel):
    __table_name__ = "core_tag"


__all__ = [
    "Bind",
    "Cache",
    "CoreGroup",
    "CoreTag",
    "CoreUser",
    "GsBind",
    "GsCache",
    "GsPush",
    "GsUID",
    "GsUser",
    "Push",
    "Subscribe",
    "User",
]
