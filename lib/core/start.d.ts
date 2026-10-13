export declare const DIRS: string[];
export declare function ensureDirs(): Promise<void>;
export declare function initRedisOrFallback(): Promise<any>;
export declare function start(): Promise<any>;
/** 子进程请求重启时的退出码（守护进程据此重新拉起） */
export declare const RESTART_CODE = 255;
/**
 * 守护进程：在同一终端内拉起/重启主进程
 * 主进程以退出码 255 退出时重新拉起；正常退出或崩溃则结束守护。
 * 255 也用于「端口冲突」等可自愈场景，故设连续失败上限：拉起来就跑不动通常是根因没修
 * （端口被别的实例长期占用等），此时停下并给指引，比无限重拉刷日志更有用。
 */
export declare const MAX_AUTO_RESTARTS = 5;
/** 短于这个时长就退出算「没起来」；跑够这么久说明这次重启是正常的，连续失败计数清零 */
export declare const FAST_FAIL_MS = 30000;
export declare function supervise(): Promise<void>;
