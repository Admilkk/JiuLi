/** 监听配置文件变化，需绑定 { config, configFile } 作为 this */
export declare function watcher(this: any): Promise<void>;
export default function makeConfig(name: string, config?: any, keep?: any, opts?: any): Promise<any>;
