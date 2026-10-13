import type { JiuLiEvent, PluginEntry } from './types.js';
/**
 * 把插件的 priority 规整成可参与比较的数字。
 *
 * 只兜「会算出 NaN」的输入：`undefined`（漏传 / 占位类没设）、`NaN`、以及非 number。
 * `-Infinity` / `Infinity` 是云崽生态的正常写法（系统插件大量用 `-Infinity`），原样保留 ——
 * 所以这里不能用 `Number.isFinite` 判断。
 *
 * 导出给测试复用，保证「测试断言的排序口径」与「框架实际排序口径」是同一套。
 */
export declare function priorityRank(n: unknown): number;
declare class PluginsLoader {
    /** 赋值时重建事件索引，兼容插件直接替换 priority 的用法 */
    private _priority;
    get priority(): PluginEntry[];
    set priority(list: PluginEntry[]);
    handler: Record<string, any>;
    task: any[];
    /** JIULI_PLUGINS_DIR 可指定，用于测试/多实例隔离 */
    dir: string;
    /** 事件索引：post_type → 插件条目 */
    eventIndex: Map<string, PluginEntry[]>;
    /** 无插件类的文件（适配器/胶水），#重载 时跳过以免重复副作用 */
    inertFiles: Set<string>;
    /** 加载阶段是否已结束（用于判断插件是否"迟到就绪"） */
    loaded: boolean;
    /** 插件 init 实例，卸载时用于回调 onUnload */
    private initInstances;
    groupCD: Record<string, boolean>;
    singleCD: Record<string, boolean>;
    /** 消息去重（1s） */
    msgThrottle: Record<string, boolean>;
    watcher: Record<string, any>;
    /**
     * 重载风暴熔断：只统计**机器自激**的重载时刻表（人工改文件不计，见 noteReload）。
     * 开发时一分钟里存十几次代码是常态，不该被当成风暴；插件自己边加载边改写文件才是。
     */
    private reloadMarks;
    /** 被熔断的插件（暂停其重载监听，`#重载 <插件名>` 恢复） */
    private pausedReload;
    /** 所有重载（含人工）的时间戳，只用于"这频率不像人在改文件"的告警 */
    private globalReloadMarks;
    private lastGlobalRateWarn;
    /** 各插件最近一次「模块求值窗口」：文件 mtime 落在这里 = 那次加载自己写出来的 */
    private loadWindows;
    /** 已就"自激改写"告警过的文件（首次 error，之后 debug，别刷屏） */
    private selfWriteWarned;
    taskMap: Map<string, Set<any>>;
    pluginCountMap: Map<string, number>;
    pluginCount: number;
    /** 因插件超时而未导入的文件：收尾汇总列出，并允许补拉一次 */
    private abandoned;
    private retriedAbandoned;
    /** 批量补拉中：逐个 import 不各自重建索引，结束时统一重建一次 */
    private bulkRetry;
    load_time: Record<string, number>;
    /**
     * 插件首次加载的顺序号，重载时保持不变。
     * priority 相同的插件靠它决定谁先匹配（见 sortPriority），不这么做的话重载会把插件
     * 挤到同优先级队伍的最后，抢指令的结果就变了。
     */
    private pluginOrder;
    private orderSeq;
    eventCache: WeakMap<object, {
        source: string;
        event: string[];
    }>;
    eventMap: Record<string, string[]>;
    /** 星铁命令前缀 */
    srReg: RegExp;
    /** 绝区零前缀 */
    zzzReg: RegExp;
    /** 计数缓冲：内存聚合 + 定时写回 */
    private countBuffer;
    private countTimer?;
    /** 只做兼容别名、不作为插件源的目录（云崽的 plugins/other/ 转发到 system/） */
    aliasDirs: Set<string>;
    getPlugins(): Promise<{
        name: string;
        path: string;
    }[]>;
    /** isRefresh 时先卸载再加载 */
    load(isRefresh?: boolean): Promise<void>;
    /**
     * 补拉被超时牵连、本轮完全没导入的文件；逐个补，避免再出现同批卡住。
     * 每个文件仍有自己的超时，整体在后台跑，不阻塞启动收尾。
     * 期间挂起逐条重建，结束后统一建一次索引 / 排序 / 定时任务。
     */
    private retryAbandoned;
    /**
     * 报告本轮没导入的文件（被超时牵连 / 从没轮到）。
     *
     * 推迟几秒再判：worker 把文件 shift 出来后要等 import 完成才写 load_time，
     * 当场判定会把「正在求值」的文件误报成未加载。没导入的文件 load_time 永远不会出现，
     * 所以推迟不会漏报，只会去掉误报。
     */
    private reportNeverImported;
    /** 迟到的插件（超过 plugin_load_timeout 才就绪）：补进索引与定时任务，避免"下次重载才生效" */
    private lateAttach;
    buildEventIndex(): void;
    /**
     * 排序插件：优先级升序（小的先匹配），**并用「首次加载顺序」兜底**。
     *
     * 原来只有 `a.priority - b.priority`，priority 相同时靠 Array.sort 的稳定性维持
     * 「扫描顺序即匹配顺序」。而重载是把该插件的条目删掉、重新 push 到数组末尾 ——
     * 于是重载过的插件在同优先级里掉到最末，谁抢到指令就变了。生态插件的 priority 大量
     * 写 `-Infinity`（还互相重叠，比如 miao 的 `#更新面板` 与 system/update.js 的
     * `^#更新`），实测重载 miao-plugin 之后 `#更新面板` 被系统更新插件顶掉，重启才恢复。
     *
     * 注意 `-Infinity - -Infinity = NaN`，而 NaN 是假值，`||` 会兜到顺序号比较 ——
     * 正好是想要的「同优先级按加载顺序」。
     *
     * ⚠️ 但 `undefined - 数字` 也是 NaN，而它和「同为 -Infinity」不是一回事：
     * 一旦有条目的 priority 是 undefined（插件漏传、或占位/降级类没设这个字段），
     * 该条目与任何人比较都会退化成按 order 比 —— 比较函数**不再满足传递性**
     * （实测 `卸载枫叶(-1e42) < placeholder(undefined) < atme更新(-Infinity)`，
     * 但 `cmp(卸载枫叶, atme更新) = Infinity`）。V8 的 sort 在比较函数不一致时
     * 结果不可预测，会把**整张表的顺序打乱**，表现为「某条指令被别的插件抢走」，
     * 而且没有任何报错。实测一个 undefined 条目能让 317 条里的 304 条错位。
     *
     * 所以这里先把 priority 规整成数字：只兜「会算出 NaN」的输入（undefined / NaN /
     * 非 number），统一按基类默认值 5000 处理，再排序。
     * ⚠️ 不能用 `Number.isFinite` —— 那会把生态惯例的 `-Infinity` 一起兜掉，
     * 而 `-Infinity` 是正常用法（系统插件大量使用），必须原样保留。
     */
    private sortPriority;
    /** 候选插件：事件索引命中桶 + 通配桶 */
    private candidates;
    /**
     * 把插件加载错误翻译成「看得懂 + 有下一步」的一行提示；完整堆栈留给 debug 级别
     * @returns text 提示文本；pkg 是否属于「缺依赖」（汇总后统一提示安装）
     */
    describeLoadError(error: any, file: {
        name: string;
    }): {
        text: string;
        pkg: boolean;
    };
    importPlugin(file: {
        name: string;
        path: string;
    }, packageErr?: any[]): Promise<boolean>;
    loadPlugin(file: {
        name: string;
        path: string;
    }, p: any): Promise<void>;
    registerHandlers(pluginInstance: any, namespace?: any): void;
    /** 缺依赖的汇总提示（单个插件的报错已在 importPlugin 里逐条给出） */
    packageTips(packageErr: any[]): void;
    /** 最近的消息记录（供 #诊断 排查"为什么没回复"） */
    recent: {
        receive: Array<{
            time: number;
            scene: string;
            content: string;
            matched: string;
        }>;
        send: Array<{
            time: number;
            scene: string;
            content: string;
            plugin: string;
        }>;
    };
    private pushRecent;
    deal(e: JiuLiEvent): Promise<void>;
    /** 同一用户 10 秒内只提示一次"无响应" */
    private hintThrottle;
    /**
     * 执行原生插件钩子（beforeMessage / afterMessage）
     * 类形态定义同名方法即可；DSL 形态的 beforeMessage(fn) / afterMessage(fn) 会绑定为同名方法
     */
    private runHooks;
    /**
     * 这条消息看起来像"用户在敲指令"吗（默认要求 `#` 前缀）。
     *
     * `no_handler_tip` 只在这种消息上提示：普通聊天会被插件的宽泛规则匹配到，
     * 插件本来就不回话，再补一句"没有响应"反而像机器人坏了。前缀可在
     * `bot.yaml → no_handler_tip_prefix` 里改（逗号分隔多个，写 `*` 表示不限制前缀）。
     */
    private looksLikeCommand;
    /** 事件表达式与实际事件逐段比对，支持 * 通配 */
    filtEvent(e: JiuLiEvent | null, v: any): boolean;
    /** 权限检查；master/owner/admin 校验失败时直接回复用户 */
    filtPermission(e: JiuLiEvent, v: any): boolean;
    dealText(text?: string): string;
    /** 解析消息，补齐 e.msg / e.img / e.isGroup / e.isMaster 等派生字段 */
    dealEvent(e: JiuLiEvent, groupCfg?: any): void;
    /**
     * 「只响应主人」：群配置层开关（`onlyReplyMaster: 1`），默认关。
     *
     * 和 `permission: master` 的区别：那个是按**指令**声明、且会回一句"没有权限"；
     * 这个是整层过滤，非主人的消息什么都不回（连提示都没有），适合把机器人当私人助手。
     * 私聊同样受约束 —— 它回答的是"谁能用这个机器人"。
     *
     * 必须在派生字段齐了之后调用（e.isMaster 是 dealEvent 里算的），否则会把主人一起拦掉。
     */
    checkMasterOnly(e: JiuLiEvent, groupCfg?: any): boolean;
    /** 包装 e.reply：拼装 at/引用、记录发送日志，并在失败时捕获异常 */
    reply(e: JiuLiEvent): void;
    private pushCount;
    flushCount(): Promise<void>;
    saveCount(e: JiuLiEvent, type: string): Promise<boolean>;
    collectTask(task: any, name: string, key: string): void;
    startTask(name: string, i: any): Promise<void>;
    createTask(): void;
    checkLimit(e: JiuLiEvent, config?: any): boolean;
    setLimit(e: JiuLiEvent, config?: any): void;
    onlyReplyAt(e: JiuLiEvent, groupCfg?: any): boolean;
    /** 命中 other 中的黑名单即拦截；白名单存在时未命中即拦截 */
    checkBlack(e: JiuLiEvent): boolean;
    /** groupCfg 的 disable 列表命中即禁用；enable 列表存在时不在其中即禁用 */
    checkDisable(p: {
        plugin: any;
        e: JiuLiEvent;
    }, groupCfg?: any): boolean;
    unloadPlugin(key: string, closeWatcher?: boolean): Promise<void>;
    changePlugin(key: string): Promise<boolean>;
    /**
     * 热重载求值失败后的恢复。
     *
     * 重载会让整张模块图按新顺序重新求值；插件若把循环 import 和顶层副作用混在一起，
     * 新顺序可能撞上 TDZ（`Cannot access 'Data' before initialization`），而冷启动顺序是好的
     * —— 表现为「重载后该插件指令全没了，重启才恢复」。这种失败可能被插件自己的
     * `Promise.allSettled` 吞掉，框架只看到一堆 ERROR，所以这里只能靠重启恢复。
     *
     * 用两分钟的节流兜底：真坏到起不来时只重启一次，之后明确提示手动处理，不反复重启。
     */
    private recoverReload;
    /** plugins/ 下的相对路径 → 插件 key，命名与 getPlugins 保持一致 */
    private keyOf;
    /** 适配器 / 胶水文件（无插件类） */
    isInert(key: string): boolean;
    /**
     * 找出这个文件真正属于哪个**已加载**的插件（用于热重载分类）。
     *
     * `keyOf` 的规则是「两层算自己、更深归第一层」，对标准布局（`plugins/<插件>/apps/x.js`）没错；
     * 但遇到「扁平目录里再套目录」——`plugins/example/devdrill/index.js`，而 `example/` 本身没有
     * index.js（它是"加载目录下所有 js"的形态）—— 就会算成 `example`，于是改 / 删一个文件会动到
     * 整个 `example` 目录下的所有插件。这里在已加载的 key 里挑最长的祖先 key 兜住这类布局。
     */
    private ownerKeyOf;
    private isLoaded;
    /** 文件是否存在（删除事件里判断"插件目录还在不在"） */
    private fileExists;
    /** 按 key 加载；已加载则重载 */
    reloadKey(key: string): Promise<boolean | void>;
    private loadKey;
    /**
     * 这个 .js 变化值不值得**重载整个插件**
     *
     * 起因（实测 OOM 事故）：miao 的 `components/Cfg.js` 在模块求值时就 `saveCfg()`，
     * 也就是**每次 miao 被求值都会重写 `plugins/miao-plugin/config/cfg.js`**；
     * 而框架对 `plugins/**` 下任何 `.js` 变化都重载整个插件 → 重载又写一遍 →
     * 2 秒一轮的自激循环，每轮都新求值一整张模块图（ESM 缓存不释放旧图）→ 30 秒打爆 1GB。
     *
     * 规则：
     * - 插件**私有配置 / 数据目录**（`config/`、`data/`、`resources/`、`temp/`）里的 `.js`，
     *   只有"看起来是插件模块"（有插件结构：plugin 类 / rule / apps / task / handler / fnc / reg…）
     *   才重载 —— 纯 `export const xxx = false` 这种配置/数据不重载。
     * - 其它位置（入口、`apps/`、`lib/`、`model/`、自建目录）一律照旧重载，
     *   插件开发者改工具函数、改子应用都能即时生效。
     * - `unlink` 不判定（文件已经没了，读不到内容；删除本来就少见，保守处理）。
     */
    private isPluginModule;
    /** 见 isPluginModule 注释；这里只负责「读文件 + 决定」 */
    private shouldReloadJs;
    /**
     * 记录一次重载；**机器自激**的重载短时间内反复出现就熔断（暂停它的重载监听）
     *
     * 只统计"文件是插件自己在加载时写出来的"那种重载：
     * - 人工在编辑器里改文件（mtime 落在所有求值窗口之外）**不计入** ——
     *   开发者一分钟里存十几次代码是常态，被当成风暴暂停掉就没法调插件了；
     * - 插件边加载边改写文件（miao 的 config/cfg.js 就是）才算，因为这才是会 OOM 的自激循环：
     *   每轮重载都会永久占用一张模块图（ESM 缓存不释放），顶着循环跑几十秒就能打爆内存。
     *
     * 另外还有一条"全局频率"兜底：任何来源的重载一分钟超过 reload_global_limit 次，
     * 说明这频率不像人在改文件，打一条 ERROR 提醒（不暂停，避免误伤批量格式化之类）。
     */
    private noteReload;
    /**
     * 这个文件的修改时间是"机器写的"吗：落在最近某次插件模块求值的窗口内。
     *
     * 插件在模块顶层改写文件时，写入必然发生在求值期间 → mtime 落在窗口里；
     * 人在编辑器里保存，mtime 落在窗口里（毫秒级）的概率极低 —— 这就是区分
     * "开发者连续改代码" 与 "插件自激重载风暴" 的依据。
     *
     * @returns 窗口属于哪个插件（key）；null = 没落在任何窗口里（视为人工改动）
     */
    private machineWriteOwner;
    /** 当前因重载风暴被暂停监听的插件 key（#重载 提示用） */
    get pausedReloadList(): string[];
    /**
     * 解除重载熔断：手动 `#重载 <插件名>` 是明确的用户动作，理应重新监听。
     *
     * 为什么不放在 changePlugin 里自动清：watcher 触发的重载也走 changePlugin，
     * 一进一出就把计数清了，熔断永远不会触发。所以只由指令层显式调用。
     */
    resumeReload(key?: string): boolean;
    /**
     * 监听整个 plugins/ 目录：新增 js 自动加载、修改自动重载、删除自动卸载
     * 非 js 资源变化不触发重载（渲染层自带缓存失效）
     */
    watchPlugins(): void;
    /** 兼容旧调用 */
    watch(): void;
    /** closeWatchers：file_watch=false 时改由 config 用 NullWatcher 接管 */
    closeWatchers(): void;
}
declare const _default: PluginsLoader;
export default _default;
export { PluginsLoader };
