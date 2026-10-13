/** 发送私聊消息 */
export declare function relpyPrivate(user_id: any, msg: any, bot_id?: any): any;
export declare function sleep(...args: any[]): any;
/** 下载失败时记录日志并返回 false */
export declare function downFile(url: string, file: string, opts?: any): Promise<any>;
export declare function mkdirs(dirname: string): boolean;
/** 优先使用群/好友会话自带的转发实现 */
export declare function makeForwardMsg(e: any, msg?: any, dec?: string): any;
declare const _default: {
    relpyPrivate: typeof relpyPrivate;
    sleep: typeof sleep;
    downFile: typeof downFile;
    mkdirs: typeof mkdirs;
    makeForwardMsg: typeof makeForwardMsg;
};
export default _default;
