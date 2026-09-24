/**
 * AstrBot（Star）兼容宿主
 *
 * 同 GsCore：插件必须是 Python（装饰器 + async generator + super().__init_subclass__），
 * 所以同样走 Python 边车，由 astrbot 仿制包把事件派发给真实插件。
 */
import { createPythonHost } from './_python.js'
import { ecoPkgs } from '../paths.js'

export default createPythonHost({
  id: 'astrbot',
  name: 'AstrBot',
  boot: 'boot_astrbot.py',
  pluginDir: ecoPkgs('astrbot'),
  readyTimeout: 90000,
})
