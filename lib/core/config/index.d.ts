declare class Cfg {
    config: Record<string, any>;
    watcher: Record<string, any>;
    _package?: Record<string, any>;
    /** getAllCfg 合并结果缓存，配置变更时失效 */
    mergedCache: Map<string, any>;
    /** 群配置 4 层合并结果缓存，(bot_id,group_id) → 配置 */
    groupCache: Map<string, any>;
    /** 用户配置目录，可用 JIULI_CONFIG_DIR 覆盖（测试/多实例隔离） */
    get userDir(): string;
    constructor();
    /** 初始化配置目录：default_config → 用户配置目录 */
    initCfg(): void;
    /** 主人账号 [bot_id, user_id][] */
    get master(): Record<string, string[]>;
    get masterQQ(): Array<number | string>;
    /** 机器人账号 */
    get uin(): string[];
    get qq(): string[];
    /** package.json；启用框架伪装时对外以框架标识替换 name / version */
    get package(): Record<string, any>;
    /** 对外暴露的框架名，仅 compat.spoof_yunzai 时显示为 trss-yunzai */
    get frameworkName(): string;
    /** 对外版本号；默认 3.1.3，避免老插件判定"版本过低" */
    get frameworkVersion(): string;
    getCompat(): any;
    getPerf(): any;
    /** 群配置 4 层合并：default → bot:default → group → bot:group */
    getGroup(bot_id?: string | number, group_id?: string | number): Record<string, any>;
    /** other 配置 */
    getOther(): Record<string, any>;
    getdefSet(name: string): any;
    getConfig(name: string): any;
    /** default_config 与用户配置合并；结果缓存于消息分发热路径，配置变更时失效 */
    getAllCfg(name: string): Record<string, any>;
    /** 使某配置及其群配置缓存失效（含 getYaml 自己的解析缓存，否则写完配置再读还是旧值） */
    invalidate(name: string): void;
    getYaml(type: string, name: string): any;
    watch(file: string, name: string, type?: string): void;
    change_bot(): Promise<void>;
}
declare const cfg: Cfg & Record<string, any>;
export default cfg;
