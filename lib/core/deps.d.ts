export interface SystemDep {
    /** 命令名 */
    cmd: string;
    /** 缺了会影响什么 */
    desc: string;
    /** Linux 各发行版的包名 */
    pkg: {
        apt: string;
        dnf: string;
        yum: string;
    };
    /** Windows 的 winget 包 id */
    winget?: string;
    /** macOS 的 brew 包名 */
    brew?: string;
}
/** 需要自检的外部命令 */
export declare const SYSTEM_DEPS: SystemDep[];
/** 探测命令路径，命中则记入缓存 */
export declare function depPath(dep: SystemDep | string): Promise<string>;
/** 当前缺失的依赖 */
export declare function missingDeps(): Promise<SystemDep[]>;
/** 是否具备自动安装条件：Linux + root，且没设 JIULI_NO_AUTO_INSTALL=1 */
export declare function canAutoInstall(): boolean;
/**
 * 自检并补装缺失的外部命令
 *
 * 调用方应当 fire-and-forget（安装 ffmpeg 这类包可能要几十秒），不要阻塞启动。
 * 返回是否全部就绪。
 */
export declare function ensureDeps(): Promise<boolean>;
