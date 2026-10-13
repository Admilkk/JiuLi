const segment = {
    custom(type, data) {
        return { type, ...data };
    },
    raw(data) {
        return { type: 'raw', data };
    },
    button(...data) {
        return { type: 'button', data };
    },
    markdown(data) {
        return { type: 'markdown', data };
    },
    image(file, name) {
        return { type: 'image', file, name };
    },
    at(qq, name) {
        return { type: 'at', qq, name };
    },
    record(file, name) {
        return { type: 'record', file, name };
    },
    video(file, name) {
        return { type: 'video', file, name };
    },
    face(id) {
        return { type: 'face', id };
    },
    file(file, name) {
        return { type: 'file', file, name };
    },
    reply(id, text, qq, time, seq) {
        return { type: 'reply', id, text, qq, time, seq };
    },
};
/** 补齐 icqq 专有元素，仅在 ICQQ-Plugin 存在时生效 */
async function extendFromIcqq() {
    try {
        const spec = `file://${process.cwd()}/plugins/ICQQ-Plugin/node_modules/icqq/lib/message/elements.js`;
        const mod = await import(spec);
        const { deprecate } = await import('node:util');
        for (const i in mod.segment)
            if (!segment[i])
                segment[i] = deprecate(mod.segment[i], `segment.${i} 仅在 icqq 上可用`);
    }
    catch {
        /* ICQQ-Plugin 不存在时忽略 */
    }
}
let extended = false;
/** 异步补齐 icqq 元素，启动时调用一次 */
export async function extendSegment() {
    if (extended)
        return segment;
    extended = true;
    await extendFromIcqq();
    return segment;
}
/** 取全局 segment（兼容层注入的优先）或内核实现 */
export function getSegment() {
    return globalThis.segment || segment;
}
export default segment;
