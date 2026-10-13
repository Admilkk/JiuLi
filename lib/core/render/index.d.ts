import path from 'node:path';
export declare class RendererLoader {
    renderers: Map<string, any>;
    dir: string;
    script_renderers: any[];
    noscript_renderers: any[];
    loaded: boolean;
    load(): Promise<this>;
    getRenderer(name?: string | undefined): any;
    render(name: string, data: any): Promise<any>;
    /** 渲染并包成 segment.image（兼容云崽 puppeteer.screenshot） */
    screenshot(name: string, data: any): Promise<any>;
    /** 分片截图（兼容云崽 puppeteer.screenshots） */
    screenshots(name: string, data: any): Promise<false | any[]>;
    /** 当前真正干活的渲染后端（浏览器相关接口都转发给它） */
    get backend(): any;
    /**
     * 兼容云崽 puppeteer.browserInit()：返回已启动的浏览器实例。
     * 插件拿它自己 newPage 截图（如「谁艾特我」「水群统计」这类自带 HTML 的插件）。
     */
    browserInit(): Promise<any>;
    get browser(): any;
    get browserIsOpen(): boolean;
    /** 重启浏览器（下次截图时重新拉起） */
    restart(force?: boolean): Promise<any>;
    stop(): Promise<any>;
}
declare const _default: RendererLoader;
export default _default;
export { path };
