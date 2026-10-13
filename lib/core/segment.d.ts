/** 消息元素工厂 segment；lib/modules/oicq 指向本实现，旧插件从 'oicq' 包名导入 */
export interface SegmentFactory {
    [key: string]: (...args: any[]) => any;
}
declare const segment: SegmentFactory;
/** 异步补齐 icqq 元素，启动时调用一次 */
export declare function extendSegment(): Promise<SegmentFactory>;
/** 取全局 segment（兼容层注入的优先）或内核实现 */
export declare function getSegment(): SegmentFactory;
export default segment;
