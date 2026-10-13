/**
 * 渲染后端加载器：扫描 renderers/<name>/index.js（默认导出 (config) => renderer）
 * 后端契约 { id, type, render(name, data) }，渲染时依序尝试并返回首个成功结果。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'yaml';
import { logger } from '../log.js';
import cfg from '../config/index.js';
import util from '../util.js';
/** 优先用兼容层注入的全局 segment，否则回退到 oicq 包 */
async function getSegment() {
    const g = globalThis;
    if (g.segment)
        return g.segment;
    try {
        const spec = 'oicq';
        const mod = await import(spec);
        return mod.segment;
    }
    catch {
        return undefined;
    }
}
export class RendererLoader {
    constructor() {
        this.renderers = new Map();
        this.dir = 'renderers';
        this.script_renderers = [];
        this.noscript_renderers = [];
        this.loaded = false;
    }
    async load() {
        if (this.loaded)
            return this;
        this.loaded = true;
        if (!fs.existsSync(this.dir)) {
            util.makeLog('warn', '未找到 renderers 目录，渲染功能不可用', 'Render');
            return this;
        }
        const subFolders = fs.readdirSync(this.dir, { withFileTypes: true }).filter(d => d.isDirectory());
        for (const subFolder of subFolders) {
            const name = subFolder.name;
            try {
                /** 动态 import 的相对说明符以本文件为基准，故必须传绝对路径 URL */
                const rendererUrl = pathToFileURL(path.resolve(this.dir, name, 'index.js')).href;
                const rendererFn = (await import(rendererUrl)).default;
                const configFile = `${this.dir}/${name}/config.yaml`;
                const configDefault = `${this.dir}/${name}/config_default.yaml`;
                if (!fs.existsSync(configFile) && fs.existsSync(configDefault))
                    fs.copyFileSync(configDefault, configFile);
                const rendererCfg = fs.existsSync(configFile) ? yaml.parse(fs.readFileSync(configFile, 'utf8')) : {};
                const renderer = rendererFn(rendererCfg);
                if (!renderer?.id || !renderer?.type || typeof renderer.render !== 'function') {
                    util.makeLog('warn', `渲染后端 ${renderer?.id || name} 不可用`, 'Render');
                    continue;
                }
                this.renderers.set(renderer.id, renderer);
                util.makeLog('info', `渲染后端 ${logger.green(renderer.id)} 已就绪 · 类型 ${renderer.type} · 支持 script ${renderer.support_script ? '是' : '否'}${typeof renderer.info === 'string' ? ` · ${renderer.info}` : ''}`, 'Render');
            }
            catch (err) {
                util.makeLog('error', `渲染后端 ${name} 加载失败 · ${err?.message || err}`, 'Render');
            }
        }
        const renderers = [...this.renderers.values()];
        this.script_renderers = [
            ...renderers.filter(i => i.support_script),
            ...renderers.filter(i => !i.support_script),
        ];
        this.noscript_renderers = [
            ...renderers.filter(i => !i.support_script),
            ...renderers.filter(i => i.support_script),
        ];
        return this;
    }
    getRenderer(name = cfg.renderer?.name) {
        return this.renderers.get(name) || this;
    }
    async render(name, data) {
        if (!this.loaded)
            await this.load();
        const { default: Renderer } = await import('./Renderer.js');
        const html = Renderer.readTpl(data.tplFile);
        if (!html)
            return false;
        for (const i of String(html).includes('</script>') ? this.script_renderers : this.noscript_renderers)
            try {
                const res = await i.render(name, data);
                if (res)
                    return res;
            }
            catch (err) {
                util.makeLog('error', `渲染后端 ${i.id} 渲染出错 · ${err?.message || err}`, 'Render');
            }
        return false;
    }
    /** 渲染并包成 segment.image（兼容云崽 puppeteer.screenshot） */
    async screenshot(name, data) {
        const img = await this.render(name, data);
        if (!img)
            return img;
        const segment = await getSegment();
        return segment ? segment.image(img) : img;
    }
    /** 分片截图（兼容云崽 puppeteer.screenshots） */
    async screenshots(name, data) {
        data.multiPage = true;
        const imgs = (await this.render(name, data)) || [];
        const segment = await getSegment();
        const ret = [];
        for (const img of Array.isArray(imgs) ? imgs : [imgs])
            ret.push(img ? (segment ? segment.image(img) : img) : img);
        return ret.length > 0 ? ret : false;
    }
    /** 当前真正干活的渲染后端（浏览器相关接口都转发给它） */
    get backend() {
        return this.renderers.get(cfg.renderer?.name) || [...this.renderers.values()][0];
    }
    /**
     * 兼容云崽 puppeteer.browserInit()：返回已启动的浏览器实例。
     * 插件拿它自己 newPage 截图（如「谁艾特我」「水群统计」这类自带 HTML 的插件）。
     */
    async browserInit() {
        if (!this.loaded)
            await this.load();
        const backend = this.backend;
        if (!backend)
            return false;
        if (backend.browser)
            return backend.browser;
        return backend.browserInit ? backend.browserInit() : false;
    }
    get browser() {
        return this.backend?.browser;
    }
    get browserIsOpen() {
        return Boolean(this.backend?.browser);
    }
    /** 重启浏览器（下次截图时重新拉起） */
    async restart(force = true) {
        return this.backend?.restart?.(force);
    }
    async stop() {
        return this.backend?.stop?.(this.backend.browser);
    }
}
export default new RendererLoader();
export { path };
