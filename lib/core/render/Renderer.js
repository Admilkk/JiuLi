/**
 * 模板渲染器（art-template，兼容云崽）
 * 渲染产物必须落盘 temp/html/：模板内的相对资源路径依赖 html 文件位置。
 */
import template from 'art-template';
import chokidar from 'chokidar';
import path from 'node:path';
import fs from 'node:fs';
import util from '../util.js';
export default class Renderer {
    constructor(data) {
        this.id = data.id || 'renderer';
        this.type = data.type || 'image';
        this.render = this[data.render || 'render'];
        this.support_script = data.support_script ?? true;
        this.dealTpl = Renderer.dealTpl.bind(Renderer);
    }
    static { this.dir = './temp/html'; }
    static { this.html = {}; }
    static { this.watcher = {}; }
    /** 生成的 HTML 路径 → 该路径上正在进行的截图队列尾 */
    static { this.tplQueue = new Map(); }
    /** 生成 HTML 的落盘路径；name 带层级时文件名只取最后一段 */
    static getTplPath(name, data) {
        return `./temp/html/${name}/${data.saveId ?? path.basename(String(name))}.html`;
    }
    /**
     * 按 HTML 路径串行执行渲染：同一路径的并发渲染会互相覆盖刚写好的模板，
     * 后写入的那份会被先到的 page.goto 读到，截出别人的内容。
     * 不同路径仍然并发。
     */
    static async withTpl(name, data, render) {
        const key = path.resolve(this.getTplPath(name, data));
        const previous = this.tplQueue.get(key) || Promise.resolve();
        let release;
        const current = new Promise(resolve => {
            release = resolve;
        });
        this.tplQueue.set(key, current);
        /** 前一个渲染抛错也要放行：否则本路径的队列尾永远不 resolve */
        try {
            await previous;
        }
        catch { }
        try {
            return await render();
        }
        finally {
            release();
            if (this.tplQueue.get(key) === current)
                this.tplQueue.delete(key);
        }
    }
    static createDir(dirname) {
        if (fs.existsSync(dirname))
            return true;
        if (this.createDir(path.dirname(dirname))) {
            fs.mkdirSync(dirname);
            return true;
        }
        return false;
    }
    /** 读取模板，首次读取后写入静态缓存并监听变更 */
    static readTpl(tplFile) {
        if (!this.html[tplFile]) {
            try {
                this.html[tplFile] = fs.readFileSync(tplFile, 'utf8');
            }
            catch {
                util.makeLog('error', `模板文件不存在或无法读取 · ${tplFile}`, 'Render');
                return false;
            }
            this.watch(tplFile);
        }
        return this.html[tplFile];
    }
    static dealTpl(name, data) {
        const html = this.readTpl(data.tplFile);
        if (!html)
            return false;
        // 模板内通过 resPath 引用静态资源
        data.resPath = './resources/';
        const tmpHtml = template.render(html, data);
        const savePath = this.getTplPath(name, data);
        this.createDir(path.dirname(savePath));
        fs.writeFileSync(savePath, tmpHtml);
        util.makeLog('debug', `模板已渲染 · ${data.tplFile} → ${savePath}`, 'Render');
        return savePath;
    }
    static watch(tplFile) {
        if (this.watcher[tplFile])
            return;
        const watcher = chokidar.watch(tplFile);
        watcher.on('change', () => {
            delete this.html[tplFile];
            util.makeLog('info', `模板已更新（缓存失效）· ${tplFile}`, 'Render');
        });
        this.watcher[tplFile] = watcher;
    }
}
