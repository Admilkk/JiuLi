/**
 * 兼容层：云崽插件基类
 * 旧插件 `import plugin from '../../lib/plugins/plugin.js'` 或直接使用全局 plugin
 */
import plugin from '../core/plugin.js'
globalThis.plugin ||= plugin
export default plugin
