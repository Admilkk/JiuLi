"""
AstrBot 兼容层自测插件

覆盖真实 AstrBot 插件的典型写法：Star 子类、@filter.command（带参数）、
@filter.regex、@filter.event_message_type、@filter.permission_type、
消息组件构造（Plain/At/Image）、链式结果与 event.send。
"""

import astrbot.api.message_components as Comp
from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.star import Context, Star, StarTools


class JiuliTestPlugin(Star):
    def __init__(self, context: Context, config: dict = None):
        super().__init__(context, config)

    @filter.command("astr命令")
    async def astr_command(self, event: AstrMessageEvent, name: str = "世界"):
        """AstrBot 指令自测"""
        logger.info("AstrBot 插件被触发")
        chain = [Comp.At(qq=event.get_sender_id()), Comp.Plain(f" 你好 {name}！")]
        yield event.chain_result(chain)

    @filter.command("astr图片")
    async def astr_image(self, event: AstrMessageEvent):
        chain = [
            Comp.Plain("看图："),
            Comp.Image.fromURL("https://example.com/astr.png"),
        ]
        yield event.chain_result(chain)

    @filter.regex(r"astr正则\d+")
    async def astr_regex(self, event: AstrMessageEvent):
        yield event.plain_result("AstrBot 正则命中")

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def astr_listen(self, event: AstrMessageEvent):
        if event.message_str == "astr监听":
            yield event.plain_result("AstrBot 监听命中")

    @filter.command("astr发送")
    async def astr_send(self, event: AstrMessageEvent):
        await event.send(MessageChain().message("AstrBot 直接发送命中"))

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("astr管理")
    async def astr_admin(self, event: AstrMessageEvent):
        yield event.plain_result(f"管理员指令命中：{event.role}")

    @filter.command("astr主动")
    async def astr_proactive(self, event: AstrMessageEvent):
        umo = event.unified_msg_origin
        await self.context.send_message(umo, MessageChain().message("AstrBot 主动消息命中"))

    @filter.command("astr数据目录")
    async def astr_data_dir(self, event: AstrMessageEvent):
        path = StarTools.get_data_dir("astrbot_plugin_jiuli_test")
        yield event.plain_result(f"数据目录：{path.name}")

    async def terminate(self):
        logger.info("JiuliTestPlugin 已卸载")
