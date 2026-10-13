import BasePlugin from './core/plugin.js';
import type { JiuLiEvent, Rule, Task, HandlerConfig, RenderOptions } from './core/types.js';
import { logger, chalk } from './core/log.js';
export type { JiuLiEvent, Rule, Task, HandlerConfig, PluginOptions, RenderOptions, Adapter, Segment, Sender, ReplyData, PluginMetric, } from './core/types.js';
export { logger, chalk };
export { default as cfg } from './core/config/index.js';
export { default as util } from './core/util.js';
export { default as segment, getSegment } from './core/segment.js';
export { default as metrics } from './core/metrics.js';
export { default as Runtime } from './core/runtime.js';
export { default as Handler } from './core/handler.js';
export { default as renderService } from './core/render/index.js';
export { default as common } from './core/common.js';
export { default as makeConfig, watcher as configWatcher } from './core/plugin-config.js';
/** 当前 Bot 实例 */
export declare function getBot(): any;
/** JiuLi 原生插件基类 */
export declare class JiuLiPlugin extends BasePlugin {
    /** 插件目录名，由 loader 注入，用于定位渲染与数据目录 */
    __key: string;
    e: JiuLiEvent;
    /** 插件私有数据目录 data/plugins/<插件名>，首次访问自动创建 */
    get dataDir(): string;
    /** 插件 resources/ 路径前缀，渲染模板中以 pluResPath 引用 */
    get resDir(): string;
    /**
     * 渲染模板为图片，返回可直接 e.reply() 的内容，失败返回 false
     * @param tpl 相对插件 resources 目录的模板路径，如 'help/index'
     */
    render(tpl: string, data?: any, opts?: RenderOptions): Promise<any>;
    /** 渲染模板并返回 base64:// 字符串，失败返回 false */
    renderBase64(tpl: string, data?: any, opts?: RenderOptions): Promise<string | false>;
}
export interface CommandOptions {
    event?: string;
    permission?: 'master' | 'owner' | 'admin' | 'all' | string;
    log?: boolean;
    priority?: number;
    name?: string;
}
export interface AppDescriptor {
    __type: 'command' | 'task' | 'accept' | 'handler' | 'hook';
    [key: string]: any;
}
/** 分发前钩子：候选插件按优先级依次执行，返回 false 拦截本次分发（JiuLi 原生扩展） */
export declare function beforeMessage(fnc: (e: JiuLiEvent) => any, options?: {
    priority?: number;
}): AppDescriptor;
/** 分发后钩子：无论是否命中插件都会执行 */
export declare function afterMessage(fnc: (e: JiuLiEvent) => any, options?: {
    priority?: number;
}): AppDescriptor;
/** 命令：正则 → 处理函数；fnc 返回 false 时继续匹配后续规则 */
export declare function command(reg: RegExp | string, fnc: (e: JiuLiEvent, match?: RegExpMatchArray) => any, options?: CommandOptions): AppDescriptor;
/** 定时任务；options.log=false 不显示日志，options.skip 为上次未完成时跳过 */
export declare function task(cron: string, fnc: (...args: any[]) => any, options?: {
    name?: string;
    log?: boolean;
    skip?: boolean;
}): AppDescriptor;
/** 事件监听（通知/请求等），等价于插件级 accept；event 如 notice.group.poke */
export declare function accept(event: string, fnc: (e: JiuLiEvent) => any, options?: {
    priority?: number;
}): AppDescriptor;
/** 注册跨插件 handler，其他插件以 e.runtime.handler.call(key, e, args) 调用 */
export declare function handler(key: string, fnc: (...args: any[]) => any, options?: {
    priority?: number;
}): AppDescriptor;
export interface DefinePluginOptions {
    name: string;
    dsc?: string;
    priority?: number;
    /** 插件级事件，默认取第一个 accept / command 的 event，否则 message */
    event?: string;
    apps?: AppDescriptor[];
}
/** 定义插件，返回可被内核加载的类；apps 中的描述符会被转成插件规则 */
export declare function definePlugin(options: DefinePluginOptions): {
    new (e?: any): {
        [key: string]: any;
        /** DSL 形态下插件级 accept（动态注入） */
        accept?: (e: JiuLiEvent) => any;
        /** 插件目录名，由 loader 注入，用于定位渲染与数据目录 */
        __key: string;
        e: JiuLiEvent;
        /** 插件私有数据目录 data/plugins/<插件名>，首次访问自动创建 */
        get dataDir(): string;
        /** 插件 resources/ 路径前缀，渲染模板中以 pluResPath 引用 */
        get resDir(): string;
        /**
         * 渲染模板为图片，返回可直接 e.reply() 的内容，失败返回 false
         * @param tpl 相对插件 resources 目录的模板路径，如 'help/index'
         */
        render(tpl: string, data?: any, opts?: RenderOptions): Promise<any>;
        /** 渲染模板并返回 base64:// 字符串，失败返回 false */
        renderBase64(tpl: string, data?: any, opts?: RenderOptions): Promise<string | false>;
        name: string;
        dsc: string;
        event: string;
        priority: number;
        task: Task | Task[];
        rule: Rule[];
        handler?: HandlerConfig | HandlerConfig[];
        namespace?: string;
        init(): Promise<any>;
        useConfig(defaults?: Record<string, any>, opts?: any): Promise<any>;
        _configPromise?: Promise<any>;
        reply(msg?: any, quote?: boolean, data?: any): false | Promise<any>;
        conKey(isGroup?: boolean): string;
        setContext(type: string, isGroup?: boolean, time?: number, timeout?: string): any;
        getContext(type?: string, isGroup?: boolean): any;
        finish(type: string, isGroup?: boolean): void;
        awaitContext(...args: any[]): Promise<unknown>;
        resolveContext(context: any): void;
        renderImg(pluginName: string, tpl: string, data?: any, cfg?: any): Promise<any>;
    };
};
/** 默认导出：常用 API 集合，方便 `import jiuli from 'jiuli'` */
declare const _default: {
    JiuLiPlugin: typeof JiuLiPlugin;
    definePlugin: typeof definePlugin;
    command: typeof command;
    task: typeof task;
    accept: typeof accept;
    handler: typeof handler;
    beforeMessage: typeof beforeMessage;
    afterMessage: typeof afterMessage;
    getBot: typeof getBot;
    cfg: {
        config: Record<string, any>;
        watcher: Record<string, any>;
        _package?: Record<string, any>;
        mergedCache: Map<string, any>;
        groupCache: Map<string, any>;
        get userDir(): string;
        initCfg(): void;
        get master(): Record<string, string[]>;
        get masterQQ(): Array<number | string>;
        get uin(): string[];
        get qq(): string[];
        get package(): Record<string, any>;
        get frameworkName(): string;
        get frameworkVersion(): string;
        getCompat(): any;
        getPerf(): any;
        getGroup(bot_id?: string | number, group_id?: string | number): Record<string, any>;
        getOther(): Record<string, any>;
        getdefSet(name: string): any;
        getConfig(name: string): any;
        getAllCfg(name: string): Record<string, any>;
        invalidate(name: string): void;
        getYaml(type: string, name: string): any;
        watch(file: string, name: string, type?: string): void;
        change_bot(): Promise<void>;
    } & Record<string, any>;
    logger: import("chalk").ChalkInstance & {
        trace: (...args: any[]) => void;
        debug: (...args: any[]) => void;
        info: (...args: any[]) => void;
        mark: (...args: any[]) => void;
        warn: (...args: any[]) => void;
        error: (...args: any[]) => void;
        fatal: (...args: any[]) => void;
        logger: {
            defaultLogger: import("./core/log.js").LoggerChannel;
            commandLogger: import("./core/log.js").LoggerChannel;
            errorLogger: import("./core/log.js").LoggerChannel;
        } & import("./core/log.js").LoggerChannel;
        setLevel(level: import("./core/log.js").LogLevel): void;
        getLevel(): import("./core/log.js").LogLevel;
        setWriteFile(enable: boolean): void;
    };
};
export default _default;
