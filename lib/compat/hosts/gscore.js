/**
 * GsCore（早苗 / gsuid_core）兼容宿主
 *
 * 插件是普通 Python 模块（import 即注册，没有清单文件），且大量依赖 PIL/SQLModel，
 * 所以走 Python 边车：Node 只做事件转换与进程托管，插件的世界保持 Python。
 */
import { createPythonHost } from './_python.js'
import { ecoPkgs } from '../paths.js'

export default createPythonHost({
  id: 'gscore',
  name: 'GsCore',
  boot: 'boot_gscore.py',
  pluginDir: ecoPkgs('gscore'),
  readyTimeout: 90000,
})
