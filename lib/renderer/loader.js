/**
 * 兼容层：渲染后端加载器
 * 插件 `import Renderer from '../../lib/renderer/loader.js'` 后 Renderer.getRenderer() / render()
 */
import renderService from '../core/render/index.js'
export default renderService
export { RendererLoader } from '../core/render/index.js'
