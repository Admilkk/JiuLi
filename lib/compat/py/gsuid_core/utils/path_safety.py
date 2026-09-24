"""gsuid_core.utils.path_safety 仿制：路径穿越防护"""

import os
from pathlib import Path
from typing import Union


class PathEscapeError(Exception):
    pass


def is_safe_filename(name: str) -> bool:
    return bool(name) and name not in (".", "..") and "/" not in name and "\\" not in name and "\0" not in name


def safe_join(base: Union[str, Path], *paths: str) -> Path:
    base_path = Path(base).resolve()
    target = base_path.joinpath(*paths).resolve()
    try:
        target.relative_to(base_path)
    except ValueError:
        raise PathEscapeError(f"路径越界：{target} 不在 {base_path} 内")
    return target


__all__ = ["PathEscapeError", "is_safe_filename", "safe_join"]
