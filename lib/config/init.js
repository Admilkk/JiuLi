/**
 * 兼容层：启动初始化
 * 内核已在 start() 中完成同等流程，此文件保留给手工调用 init() 的旧代码
 */
import { setLog } from '../core/log.js'
import { ensureDirs, initRedisOrFallback } from '../core/start.js'

export default async function init() {
  setLog()
  await ensureDirs()
  await initRedisOrFallback()
}
