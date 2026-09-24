"""
gsuid_core.utils.image.convert 仿制：convert_img

真实 GsCore 基于 PIL 做图片编码转换。这里同样用 PIL（插件本来就依赖 Pillow），
所以行为基本一致：返回 `base64://...` 字符串或原始 bytes。
没装 Pillow 时只支持「原样透传 bytes / 已是 base64 的字符串」，并给出明确提示。
"""

import base64
from io import BytesIO
from typing import Any, Union

try:  # pragma: no cover
    from PIL import Image
except Exception:
    Image = None  # type: ignore


async def convert_img(img: Any, is_base64: bool = True, is_miao: bool = False) -> Union[str, bytes]:
    """
    @param img: PIL.Image / 文件路径 / bytes / base64:// 字符串
    @param is_base64: True 返回 `base64://...`，False 返回 PNG bytes
    """
    if img is None:
        return b"" if not is_base64 else ""

    # 已经是 base64
    if isinstance(img, str) and img.startswith("base64://"):
        data = base64.b64decode(img[len("base64://"):])
        return img if is_base64 else data

    if isinstance(img, (bytes, bytearray)):
        if Image is None:
            return ("base64://" + base64.b64encode(bytes(img)).decode()) if is_base64 else bytes(img)
        try:
            image = Image.open(BytesIO(bytes(img)))
        except Exception:
            return ("base64://" + base64.b64encode(bytes(img)).decode()) if is_base64 else bytes(img)
    elif isinstance(img, str):
        if Image is None:
            raise RuntimeError("convert_img 需要 Pillow 才能处理文件路径，请先 pip install Pillow")
        image = Image.open(img)
    else:
        image = img

    buffer = BytesIO()
    fmt = "PNG"
    try:
        image.save(buffer, format=fmt)
    except Exception:
        # 带透明通道之外的模式（如 P/RGBA）统一转 RGB 再存
        if Image is not None:
            image.convert("RGB").save(buffer, format="JPEG")
            fmt = "JPEG"
        else:
            raise
    data = buffer.getvalue()
    return ("base64://" + base64.b64encode(data).decode()) if is_base64 else data


async def convert_img_to_bytes(img: Any) -> bytes:
    res = await convert_img(img, is_base64=False)
    return res if isinstance(res, bytes) else b""


__all__ = ["convert_img", "convert_img_to_bytes"]
