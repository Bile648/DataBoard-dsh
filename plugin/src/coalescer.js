/**
 * 合并器：把高频里程碑压成大节点。
 *
 * 规则（见设计第 2 节去噪规则）：
 *   - priority='high' 的节点（阻塞、目标完成）**立即放行**，不参与合并；
 *   - 普通节点在 windowMs 窗口内按 (sessionId:kind:sequenceKey) 聚合，只保留最新状态，
 *     计数类字段累加、artifacts 合并；
 *   - 同 (sessionId:sequenceKey) 且状态相同的节点在 dedupeWindowMs 内丢弃。
 *
 * 定时器由外部注入（DSH 内接 ctx.timer），便于测试与不占用事件回调。
 */

import { MILESTONE } from './projector.js'

const ACCUMULATING = new Set([MILESTONE.TURN, MILESTONE.REPORT, MILESTONE.PLAN])

export class Coalescer {
  constructor({
    windowMs = 3000,
    dedupeWindowMs = 30000,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onFlush = () => {},
    log = () => {},
  } = {}) {
    this.windowMs = windowMs
    this.dedupeWindowMs = dedupeWindowMs
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.onFlush = onFlush
    this.log = log

    this.pending = new Map()
    this.timer = null
    this.lastEmitted = new Map()
    this.stats = { immediate: 0, buffered: 0, flushed: 0, deduped: 0, merged: 0 }
  }

  /** 推送一个待发条目：{ sessionId, milestone, task?, report?, artifacts?, changes?, ... } */
  push(item) {
    const key = this.keyOf(item)
    const sequenceKey = `${item.sessionId}:${item.milestone.sequenceKey ?? item.milestone.kind}`
    const now = this.now()

    const last = this.lastEmitted.get(sequenceKey)
    if (last && last.status === item.milestone.status && now - last.at < this.dedupeWindowMs) {
      this.stats.deduped += 1
      return
    }

    if (item.milestone.priority === 'high') {
      // 立即放行前必须先把「同键」的待发条目冲刷出去：
      // 否则高优先节点会越过窗口内的旧状态，服务端按到达顺序折叠时状态会回退。
      const sameKeyPending = this.pending.get(key)
      if (sameKeyPending) {
        this.pending.delete(key)
        this.emit(sameKeyPending)
      }
      this.stats.immediate += 1
      this.emit({ ...item })
      return
    }

    const existing = this.pending.get(key)
    if (existing) {
      this.pending.set(key, this.mergeInto(existing, item))
      this.stats.merged += 1
    } else {
      this.pending.set(key, item)
    }
    this.stats.buffered += 1
    this.schedule()
  }

  keyOf(item) {
    const sequenceKey = item.milestone.sequenceKey ?? item.milestone.kind
    return `${item.sessionId}:${item.milestone.kind}:${sequenceKey}`
  }

  mergeInto(base, incoming) {
    if (!base) return { ...incoming }
    const merged = { ...base, ...incoming }
    // 计数累加：变更行的增删是累加语义
    if (base.changes && incoming.changes && ACCUMULATING.has(incoming.milestone.kind)) {
      merged.changes = {
        ...incoming.changes,
        added: (base.changes.added ?? 0) + (incoming.changes.added ?? 0),
        deleted: (base.changes.deleted ?? 0) + (incoming.changes.deleted ?? 0),
        files: (base.changes.files ?? 0) + (incoming.changes.files ?? 0),
        sample: [...new Set([...(base.changes.sample ?? []), ...(incoming.changes.sample ?? [])])].slice(0, 10),
      }
    }
    // 产物清单取并集
    if (base.artifacts?.length || incoming.artifacts?.length) {
      const seen = new Set()
      merged.artifacts = [...(base.artifacts ?? []), ...(incoming.artifacts ?? [])].filter((a) => {
        const id = a?.path ?? a?.sha256 ?? JSON.stringify(a)
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
    }
    // 报告取更完整的一份
    if (base.report && incoming.report) {
      merged.report = (incoming.report.bytes ?? 0) >= (base.report.bytes ?? 0) ? incoming.report : base.report
    }
    return merged
  }

  schedule() {
    if (this.timer !== null) return
    this.timer = this.setTimer(() => {
      this.timer = null
      this.flush()
    }, this.windowMs)
    if (typeof this.timer?.unref === 'function') this.timer.unref()
  }

  /** 强制冲刷所有待发条目（例如 session/flush 或进程退出时） */
  flush() {
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    const items = [...this.pending.values()]
    this.pending.clear()
    for (const item of items) this.emit(item)
    if (items.length) this.log(`合并窗口冲刷 ${items.length} 条里程碑`)
    return items.length
  }

  emit(item) {
    const sequenceKey = `${item.sessionId}:${item.milestone.sequenceKey ?? item.milestone.kind}`
    this.lastEmitted.set(sequenceKey, { status: item.milestone.status, at: this.now() })
    this.stats.flushed += 1
    this.onFlush(item)
  }

  status() {
    return { ...this.stats, pending: this.pending.size, windowOpen: this.timer !== null }
  }
}
