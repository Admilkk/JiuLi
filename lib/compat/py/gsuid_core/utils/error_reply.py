"""gsuid_core.utils.error_reply 仿制：把异常转成给用户看的一行提示"""

from typing import Optional, Union

_ERROR_TIP = {
    -51: "请先绑定cookie",
    -50: "请先绑定stoken",
    -1: "请求失败，请稍后重试",
}


def get_error(error_msg: Union[int, str, Exception], msg: Optional[str] = None) -> str:
    if isinstance(error_msg, Exception):
        error_msg = str(error_msg)
    if isinstance(error_msg, int):
        tip = _ERROR_TIP.get(error_msg, f"请求失败（错误码 {error_msg}）")
    else:
        tip = f"请求失败：{error_msg}"
    if msg:
        tip = f"{msg}\n{tip}"
    return f"[玖璃·GsCore 兼容]\n{tip}"


__all__ = ["get_error"]
