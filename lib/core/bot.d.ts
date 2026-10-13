import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { JiuLiEvent } from './types.js';
export default class JiuLiBot extends EventEmitter {
    stat: {
        start_time: number;
        online: number;
    };
    bot: this;
    bots: Record<string, any>;
    /** 机器人账号列表（特化数组） */
    uin: any;
    /** 适配器列表（按 path 去重） */
    adapter: any;
    express: any;
    server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;
    httpsServer: any;
    url: string;
    wss: import("ws").Server<typeof import("ws").default, typeof http.IncomingMessage>;
    wsf: Record<string, any[]>;
    fs: Record<string, any>;
    fileTimers: Map<string, NodeJS.Timeout>;
    constructor();
    private pluginLayers;
    private pluginWs;
    /** 插件在加载期挂的事件监听：key → [{ event, listener }] */
    private pluginListeners;
    /**
     * 当前正在加载的插件 key（由 loader 在 import 前后设置）。
     * 读的是 AsyncLocalStorage 里的上下文，不是全局变量 —— 插件并行导入时全局量会被
     * 别的插件改掉，导致路由被记到别人名下（见 lib/core/loading.ts 的说明）。
     */
    private get loadingKey();
    /** 包装 express 路由方法，记录每个插件注册的层；重载时先清理旧层，避免路由重复注册 */
    private wrapExpress;
    /**
     * 包装事件订阅方法，记录「哪个插件在加载期挂了哪些监听」，卸载 / 重载时移除。
     *
     * express 路由与 WS 路径一直是这么管的，事件监听漏了：插件在**模块顶层** `Bot.on(...)` 是
     * 生态插件很常见的写法（xiaofei 的 `guild.message`、yenai 的 `message.group` 点赞），
     * 而热重载会重新求值整张模块图 —— 旧那份监听留在 EventEmitter 上，每重载一次多一份，
     * 一条消息被处理 N 次（实测重载三次：监听数 2→5，一条消息命中 4 次）。
     *
     * 只记录**加载上下文里**的调用：插件在运行期（指令、定时任务里）动态挂的监听不算「插件资源」，
     * 不参与清理，免得把用户运行时才建的东西删掉。
     */
    private wrapEventMethods;
    /** 插件卸载/重载前清理它注册的路由与 WS 路径 */
    cleanupPluginResources(key: string): {
        routes: number;
        ws: number;
        listeners: number;
    };
    serverAuth(req: any): any;
    serverStatus(req: any): void;
    serverHandle(req: any): void;
    serverExit(req: any): Promise<void>;
    wsConnect(req: any, socket: any, head: any): any;
    serverEADDRINUSE(err: any, https?: boolean): Promise<void>;
    serverError(err: any, req: any, res: any, _next?: any): any;
    serverLoad(https?: boolean): Promise<void>;
    httpsLoad(): Promise<void>;
    run(): Promise<void>;
    fileToUrl(file: any, opts?: any): Promise<any>;
    setFileTimeout(name: string, file: any, time?: number): void;
    expireFile(name: string, file: any): void;
    cleanupBotConnection(ws: any): void;
    fileSend(req: any): void;
    prepareEvent(data: JiuLiEvent): void;
    /** 逐级 emit：message.group.normal → message.group → message */
    em(name?: string, data?: JiuLiEvent): void;
    getFriendArray(): any[];
    getFriendList(): any[];
    getFriendMap(): Map<any, any>;
    get fl(): Map<any, any>;
    getGroupArray(): any[];
    getGroupList(): any[];
    getGroupMap(): Map<any, any>;
    get gl(): Map<any, any>;
    get gml(): Map<any, any>;
    pickFriend(user_id: any, strict?: boolean): any;
    get pickUser(): (user_id: any, strict?: boolean) => any;
    pickGroup(group_id: any, strict?: boolean): any;
    pickMember(group_id: any, user_id: any): any;
    sendFriendMsg(bot_id: any, user_id: any, ...args: any[]): any;
    sendGroupMsg(bot_id: any, group_id: any, ...args: any[]): any;
    /** 等待下一条符合条件的文本消息 */
    getTextMsg(fnc?: any): Promise<string>;
    /** 等待主人消息 */
    getMasterMsg(): Promise<string>;
    /** 给全部主人发送消息 */
    sendMasterMsg(msg: any, bot_array?: any, sleep?: number): Promise<any>;
    makeForwardMsg(msg: any): {
        type: string;
        data: any;
    };
    makeForwardArray(msg?: any, node?: any): {
        type: string;
        data: any;
    };
    sendForwardMsg(send: any, msg: any): Promise<any[]>;
    redisExit(): Promise<any>;
    exit(code?: number): Promise<any>;
    restart(): Promise<void>;
}
