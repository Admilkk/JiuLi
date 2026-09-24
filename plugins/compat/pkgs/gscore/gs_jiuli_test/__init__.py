"""
GsCore 兼容层自测插件

覆盖真实 GsCore 插件的典型写法：Plugins 前缀配置、6 种触发器、
多步会话（receive_resp）、图片段、SL 开关。
"""

from gsuid_core.aps import scheduler
from gsuid_core.bot import Bot
from gsuid_core.i18n import t
from gsuid_core.logger import logger
from gsuid_core.models import Event
from gsuid_core.segment import MessageSegment
from gsuid_core.sv import SL, Plugins, SV

Plugins(name="gs_jiuli_test", prefix=["gs"], allow_empty_prefix=True)

sv_test = SV("兼容测试")


@sv_test.on_command("查询深渊")
async def cmd_abyss(bot: Bot, ev: Event):
    logger.info("GsCore 插件被触发：查询深渊")
    await bot.send(f"GsCore 查询深渊：{ev.text or '(空)'}")


@sv_test.on_fullmatch("全匹配")
async def fullmatch(bot: Bot, ev: Event):
    await bot.send("GsCore 全匹配命中")


@sv_test.on_prefix("前缀")
async def prefix(bot: Bot, ev: Event):
    await bot.send(f"GsCore 前缀命中：{ev.text}")


@sv_test.on_suffix("后缀")
async def suffix(bot: Bot, ev: Event):
    await bot.send("GsCore 后缀命中")


@sv_test.on_keyword("关键词")
async def keyword(bot: Bot, ev: Event):
    await bot.send("GsCore 关键词命中")


@sv_test.on_regex(r"正则(?P<num>\d+)")
async def regex(bot: Bot, ev: Event):
    await bot.send(f"GsCore 正则命中：{ev.regex_dict.get('num')}")


@sv_test.on_fullmatch("图片测试")
async def image_test(bot: Bot, ev: Event):
    await bot.send(MessageSegment.image("https://example.com/gs.png"))


@sv_test.on_fullmatch("多步测试")
async def multi_step(bot: Bot, ev: Event):
    resp = await bot.receive_resp("请选择一个选项", ["A", "B"], timeout=5)
    if resp is not None:
        await bot.send(f"你选了：{resp.text}")
    else:
        await bot.send("超时了")


@sv_test.on_fullmatch("开关测试")
async def switch_test(bot: Bot, ev: Event):
    sv = SL.lst.get("兼容测试")
    if sv is not None:
        sv.disable()
    await bot.send("已关闭")


@sv_test.on_fullmatch("不回消息")
async def silent(bot: Bot, ev: Event):
    """匹配但不回复：用于验证「不回复就不拦截」"""
    logger.info("命中但不回复")


@sv_test.on_fullmatch("身份测试")
async def identity(bot: Bot, ev: Event):
    """把桥接层映射过来的身份字段回显出来，用于验证 bot_id/user_id/group_id 没丢"""
    await bot.send(f"身份 {ev.bot_id}/{ev.user_id}/{ev.group_id or '-'}")


@scheduler.scheduled_job("interval", hours=12)
async def scheduled():
    logger.info("GsCore 定时任务执行")
