/**
 * 兼容包：md5（内核使用 node:crypto 实现，零依赖）
 */
import { createHash } from 'node:crypto'

export default function md5(data) {
  return createHash('md5').update(data).digest('hex')
}
