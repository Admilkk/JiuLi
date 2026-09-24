/**
 * 兼容层的路径解析
 *
 * 兼容目录固定是 `<插件目录>/compat`。插件目录可由 JIULI_PLUGINS_DIR 覆盖（多实例 / 测试隔离），
 * 所以不能把 'plugins/compat' 写死 —— 写死的话隔离测试会去动真实目录。
 */
import path from 'node:path'

/** 插件根目录 */
export function pluginsRoot() {
  return process.env.JIULI_PLUGINS_DIR || 'plugins'
}

/** 兼容层自己的目录（<插件目录>/compat） */
export function compatRoot() {
  return path.resolve(pluginsRoot(), 'compat')
}

/** 某个生态的外来插件目录（<插件目录>/compat/pkgs/<eco>） */
export function ecoPkgs(eco) {
  return path.resolve(compatRoot(), 'pkgs', eco)
}
