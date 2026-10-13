/** 插件基类：兼容云崽 `extends plugin`，也是 JiuLi 原生类形态插件的基类 */
import type { JiuLiEvent, PluginOptions, Rule, Task, HandlerConfig } from './types.js';
declare const stateArr: Record<string, Record<string, any>>;
export default class plugin {
    name: string;
    dsc: string;
    event: string;
    /** 数字越小优先级越高 */
    priority: number;
    task: Task | Task[];
    rule: Rule[];
    handler?: HandlerConfig | HandlerConfig[];
    namespace?: string;
    /** 当前事件，由 loader 注入 */
    e: JiuLiEvent;
    /** 旧插件常以 this.group_id / this.user_id 等简写访问上下文，由 loader 挂载 */
    [key: string]: any;
    constructor({ name, dsc, handler, namespace, event, priority, task, rule, }?: PluginOptions);
    /** 插件加载时调用，返回 "return" 可跳过加载；原生插件覆盖 onLoad()，由本方法转发 */
    init(): Promise<any>;
    /** 首次调用以 defaults 生成 config/<插件名>.yaml，之后复用同一 Promise */
    useConfig(defaults?: Record<string, any>, opts?: any): Promise<any>;
    _configPromise?: Promise<any>;
    /**
     * 回复消息
     * @param msg 发送的消息
     * @param quote 是否引用回复
     * @param data.recallMsg 群聊是否撤回消息，0-120秒，0不撤回
     * @param data.at 是否at用户
     */
    reply(msg?: any, quote?: boolean, data?: any): false | Promise<any>;
    conKey(isGroup?: boolean): string;
    /**
     * 设置上下文
     * @param type 执行方法
     * @param isGroup 是否群聊
     * @param time 操作时间（秒）
     * @param timeout 操作超时回复
     */
    setContext(type: string, isGroup?: boolean, time?: number, timeout?: string): any;
    getContext(type?: string, isGroup?: boolean): any;
    finish(type: string, isGroup?: boolean): void;
    awaitContext(...args: any[]): Promise<unknown>;
    resolveContext(context: any): void;
    /** 渲染并发送图片；优先 miao-plugin 的 Common.render，不可用时走内核渲染 */
    renderImg(pluginName: string, tpl: string, data?: any, cfg?: any): Promise<any>;
}
export { stateArr };
