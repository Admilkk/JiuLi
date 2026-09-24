"""gsuid_core.data_store 仿制：资源路径解析"""

from pathlib import Path
from typing import List, Optional, Union


def get_res_path(_path: Optional[Union[str, List[str], Path]] = None) -> Path:
    """
    None → data/
    "a"  → data/a/
    列表 → data/a/b/
    Path → 原样返回
    """
    if _path is None:
        return Path("data")
    if isinstance(_path, Path):
        return _path
    if isinstance(_path, str):
        return Path("data") / _path
    return Path("data").joinpath(*[str(i) for i in _path])


__all__ = ["get_res_path"]
