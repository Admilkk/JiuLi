/**
 * 兼容层：插件加载器单例
 * 插件可读取 loader.priority / load_time / dealText / filtEvent / checkDisable 等
 */
import loader from '../core/loader.js'
export default loader
export { PluginsLoader } from '../core/loader.js'
