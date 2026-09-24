"""gsuid_core.gss 仿制：全局服务对象（gss.active_bot 那类用法）"""

from typing import Any, Dict


class _GSS:
    def __init__(self):
        self.active_bot: Dict[str, Any] = {}
        self.gs_token = ""
        self.is_core_install = False

    def __getattr__(self, item):
        # 未定义的属性返回 None 而不是抛错：插件常在启动期探测
        return None


gss = _GSS()

__all__ = ["gss"]
