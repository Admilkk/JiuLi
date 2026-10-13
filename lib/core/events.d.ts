export default class EventListener {
    prefix: string;
    event: string | string[];
    once: boolean;
    plugins: import("./loader.js").PluginsLoader;
    /**
     * @param data.prefix 事件名称前缀
     * @param data.event 监听的事件
     * @param data.once 是否只监听一次
     */
    constructor(data: {
        prefix?: string;
        event: string | string[];
        once?: boolean;
    });
}
export declare class ListenerLoader {
    /** 已执行过 load() 的适配器：补拉/重载后新增的才需要再加载，避免重复初始化 */
    private loadedAdapters;
    load(): Promise<void>;
    /**
     * 加载还没初始化过的适配器。
     *
     * `Bot.adapter` 由适配器插件在模块顶层 push，超时被牵连、之后补拉回来的适配器文件
     * 只完成了 import；`load()` 只在启动时跑一次，缺了这一步它们就永远不会被初始化。
     * 幂等：已加载过的不重复 `load()`（否则会重复起连接/重复注册路由）。
     */
    loadAdapters(): Promise<void>;
    loadEvent(file: string): Promise<void>;
    loadAdapter(adapter: any): Promise<void>;
}
export declare const listenerLoader: ListenerLoader;
export declare function loadEvents(): Promise<void>;
