"""
gsuid_core 兼容仿制包（JiuLi 生态兼容层）

这不是 GsCore 本体，而是给「只用到公开插件 API」的 GsCore 插件提供的一套等价接口：
插件照原样 import `gsuid_core.xxx`，由本包把注册与消息收发接到 JiuLi 上。

覆盖范围与缺口见 docs/compat-ecosystems.md。核心原则：**宁可 import 失败，也不要假装成功** ——
没实现的模块不提供，插件 import 时报错比运行到一半静默失效更好排查。
"""

__version__ = "4.0.0-jiuli"
