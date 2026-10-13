/**
 * 当前正在加载的插件 key；不在任何加载上下文里时返回 undefined。
 * @returns plugins/ 下的相对 key（如 `hl-douyin-plugin`、`example/foo.js`）
 */
export declare function currentLoadingKey(): string | undefined;
/**
 * 在「正在加载 key」的上下文里执行 fn。用于包住 `await import(插件入口)`。
 *
 * 全局变量只在同步阶段有效（fn 返回 Promise 时立即恢复，避免并行导入看到错的值），
 * 异步部分由 ALS 负责 —— 这正是原来出错的地方。
 *
 * @param key plugins/ 下的相对 key
 * @param fn 一般是 `async () => { ... await import(...) ... }`
 * @returns fn 的返回值
 */
export declare function runAsLoading<T>(key: string, fn: () => T): T;
