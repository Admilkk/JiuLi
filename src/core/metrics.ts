/**
 * 插件性能指标
 *
 * 记录每个插件（按来源文件聚合）的处理次数、总耗时、最大耗时，
 * 并在超过阈值时打印慢插件日志。数据供 #性能 指令使用。
 */
import type { PluginEntry, PluginMetric } from './types.js'
import cfg from './config/index.js'
import { logger } from './log.js'

class Metrics {
  map = new Map<string, PluginMetric>()
  private warned = new Map<string, number>()

  record(entry: PluginEntry, ms: number) {
    if (cfg.getPerf().metrics === false) return
    const key = entry.key
    let metric = this.map.get(key)
    if (!metric) {
      metric = { name: entry.name, key, count: 0, total: 0, max: 0, last: 0, lastAt: 0 }
      this.map.set(key, metric)
    }
    metric.name = entry.name
    metric.count++
    metric.total += ms
    metric.last = ms
    metric.lastAt = Date.now()
    if (ms > metric.max) metric.max = ms

    const threshold = Number(cfg.getPerf().slow_plugin_ms ?? 3000)
    if (threshold > 0 && ms >= threshold) {
      const last = this.warned.get(key) ?? 0
      if (Date.now() - last > 60000) {
        this.warned.set(key, Date.now())
        logger.warn(`[慢插件] ${entry.name}(${key}) 本次耗时 ${ms}ms，超过阈值 ${threshold}ms`)
      }
    }
  }

  remove(key: string) {
    for (const k of this.map.keys()) if (k === key || k.startsWith(`${key}/`)) this.map.delete(k)
  }

  list(): PluginMetric[] {
    return [...this.map.values()].sort((a, b) => b.total - a.total)
  }

  reset() {
    this.map.clear()
    this.warned.clear()
  }

  /** 文本总结（#性能 指令） */
  summary(limit = 15) {
    const list = this.list()
    if (!list.length) return '暂无性能数据（config/jiuli.yaml → perf.metrics）'
    const lines = ['插件性能统计（按总耗时排序）', '']
    for (const i of list.slice(0, limit))
      lines.push(
        `${i.name.padEnd(12, ' ')} 调用${String(i.count).padStart(5)}次 总${(i.total / 1000).toFixed(2)}s 均${(
          i.total / i.count
        ).toFixed(1)}ms 最大${i.max}ms`,
      )
    return lines.join('\n')
  }
}

export default new Metrics()
