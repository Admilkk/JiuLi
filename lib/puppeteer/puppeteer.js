/**
 * 兼容层：puppeteer 渲染入口
 * 旧插件 `import puppeteer from '../../lib/puppeteer/puppeteer.js'` 后
 * 调用 puppeteer.screenshot(name, data) / puppeteer.screenshots(name, data)
 */
import renderService from '../core/render/index.js'
export default renderService
