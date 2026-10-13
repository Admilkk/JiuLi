/** common 工具（兼容云崽 lib/common/common.js） */
import fs from 'node:fs';
/** 发送私聊消息 */
export function relpyPrivate(user_id, msg, bot_id) {
    return globalThis.Bot.sendFriendMsg(bot_id, user_id, msg);
}
export function sleep(...args) {
    return globalThis.Bot.sleep(...args);
}
/** 下载失败时记录日志并返回 false */
export async function downFile(url, file, opts) {
    try {
        return await globalThis.Bot.download(url, file, opts);
    }
    catch (err) {
        ;
        globalThis.logger?.error?.('下载文件错误', err);
        return false;
    }
}
export function mkdirs(dirname) {
    if (fs.existsSync(dirname))
        return true;
    fs.mkdirSync(dirname, { recursive: true });
    return true;
}
/** 优先使用群/好友会话自带的转发实现 */
export function makeForwardMsg(e, msg = [], dec) {
    const forwardMsg = [];
    if (dec)
        forwardMsg.push({ message: dec });
    for (const message of Array.isArray(msg) ? msg : [msg])
        forwardMsg.push({ message });
    if (e?.group?.makeForwardMsg)
        return e.group.makeForwardMsg(forwardMsg);
    if (e?.friend?.makeForwardMsg)
        return e.friend.makeForwardMsg(forwardMsg);
    return globalThis.Bot.makeForwardMsg(forwardMsg);
}
export default { relpyPrivate, sleep, downFile, mkdirs, makeForwardMsg };
