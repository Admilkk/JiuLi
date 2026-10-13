interface HandlerItem {
    priority: number;
    fn: (...args: any[]) => any;
    ns: string;
    self: any;
    key: string;
}
declare const Handler: {
    add(cfg: {
        ns: string;
        fn: any;
        self?: any;
        priority?: number;
        key?: string;
        event?: string;
    }): void;
    del(ns: string, key?: string): void;
    callAll(key: string, e: any, args?: any): Promise<any>;
    call(key: string, e: any, args?: any, allHandler?: boolean): Promise<any>;
    has(key: string): boolean;
    list(): Record<string, HandlerItem[]>;
};
export default Handler;
