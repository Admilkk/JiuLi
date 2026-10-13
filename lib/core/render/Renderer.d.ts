export default class Renderer {
    id: string;
    type: string;
    render: (...args: any[]) => any;
    support_script: boolean;
    dealTpl: typeof Renderer.dealTpl;
    constructor(data: any);
    static dir: string;
    static html: Record<string, string>;
    static watcher: Record<string, any>;
    /** 生成的 HTML 路径 → 该路径上正在进行的截图队列尾 */
    static tplQueue: Map<string, Promise<void>>;
    /** 生成 HTML 的落盘路径；name 带层级时文件名只取最后一段 */
    static getTplPath(name: string, data: any): string;
    /**
     * 按 HTML 路径串行执行渲染：同一路径的并发渲染会互相覆盖刚写好的模板，
     * 后写入的那份会被先到的 page.goto 读到，截出别人的内容。
     * 不同路径仍然并发。
     */
    static withTpl<T>(name: string, data: any, render: () => Promise<T>): Promise<T>;
    static createDir(dirname: string): boolean;
    /** 读取模板，首次读取后写入静态缓存并监听变更 */
    static readTpl(tplFile: string): string | false;
    static dealTpl(name: string, data: any): string | false;
    static watch(tplFile: string): void;
}
