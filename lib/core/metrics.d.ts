/** 插件性能指标，按来源文件聚合，供 #性能 指令与慢插件告警使用 */
import type { PluginEntry, PluginMetric } from './types.js';
declare class Metrics {
    map: Map<string, PluginMetric>;
    private warned;
    /** scene：这次执行的触发场景（群/用户），带上才能看出是「谁」把它跑慢的 */
    record(entry: PluginEntry, ms: number, scene?: string): void;
    remove(key: string): void;
    list(): PluginMetric[];
    reset(): void;
    /** 文本总结（#性能 指令） */
    summary(limit?: number): string;
}
declare const _default: Metrics;
export default _default;
