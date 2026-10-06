/**
 * 发件箱：有界队列 + 重试状态机 + 可选落盘。
 *
 * 状态机（见设计 6.2）：
 *   queued ──send──▶ sending ──2xx/409──▶ acked
 *                       ├─ 可重试 ──▶ retry_wait ──▶ queued
 *                       └─ 重试耗尽 ──▶ parked
 *   queued ──队列满──▶ dropped（丢最旧并计数）
 *
 * 约束：绝不无界增长；同一时刻串行发送，保证单会话内顺序。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

import { postMilestone, computeBackoff, RESULT } from './transport.js'

export class Outbox {
  constructor(config, { log = () => {} } = {}) {
    this.config = config
    this.log = log
    this.queue = []
    this.parked = []
    this.stats_ = { enqueued: 0, acked: 0, duplicates: 0, dropped: 0, parked: 0, permanentFailures: 0 }
    this.sending = false
    this.stopped = true
    this.timer = null
    this.persistPath = config.outbox?.persistPath || ''
    this.restore()
  }

  // ------------------------------------------------------------ 持久化（可选）

  restore() {
    if (!this.persistPath || !existsSync(this.persistPath)) return
    try {
      const data = JSON.parse(readFileSync(this.persistPath, 'utf8'))
      this.queue = Array.isArray(data.items) ? data.items : []
      this.parked = Array.isArray(data.parked) ? data.parked : []
      if (this.queue.length) this.log(`从 ${this.persistPath} 恢复 ${this.queue.length} 条待发里程碑`)
    } catch (error) {
      this.log(`恢复发件箱失败：${error.message}`)
    }
  }

  persist() {
    if (!this.persistPath) return
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true })
      const tmp = `${this.persistPath}.tmp`
      writeFileSync(tmp, JSON.stringify({ items: this.queue, parked: this.parked.slice(-100) }), 'utf8')
      renameSync(tmp, this.persistPath)
    } catch (error) {
      this.log(`发件箱落盘失败：${error.message}`)
    }
  }

  // ------------------------------------------------------------------- 入队

  enqueue(envelope) {
    const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8')
    const maxEntries = this.config.outbox?.maxEntries ?? 500
    const maxBytes = this.config.outbox?.maxBytes ?? 4194304

    // 有界：超限就丢最旧，绝不无界增长
    while (
      this.queue.length >= maxEntries ||
      (this.pendingBytes() + bytes > maxBytes && this.queue.length > 0)
    ) {
      const dropped = this.queue.shift()
      this.stats_.dropped += 1
      this.log(`发件箱已满，丢弃最旧里程碑 ${dropped?.envelope?.deliveryId ?? '?'}`)
    }

    this.queue.push({ envelope, attempts: 0, nextAttemptAt: 0, bytes })
    this.stats_.enqueued += 1
    this.persist()
  }

  pendingBytes() {
    return this.queue.reduce((sum, item) => sum + item.bytes, 0)
  }

  // ----------------------------------------------------------------- 发送循环

  start(intervalMs = 250) {
    if (!this.stopped) return
    this.stopped = false
    this.timer = setInterval(() => {
      this.flushDue().catch((error) => this.log(`发件箱循环异常：${error?.message || error}`))
    }, intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  async stop({ timeoutMs = 5000 } = {}) {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // 优雅关闭：尽力冲刷，超时即放弃（未发出的内容仍在持久化文件里）
    const deadline = Date.now() + timeoutMs
    while (this.queue.length > 0 && Date.now() < deadline) {
      const sent = await this.flushDue({ force: true })
      if (!sent) break
    }
    this.persist()
  }

  /** 发送所有到期的条目；返回本轮是否实际发送过 */
  async flushDue({ force = false } = {}) {
    if (this.sending) return false
    this.sending = true
    let sentAny = false
    try {
      while (this.queue.length > 0) {
        const head = this.queue[0]
        if (!force && head.nextAttemptAt > Date.now()) break
        const outcome = await this.attempt(head)
        sentAny = true
        if (outcome === 'retry') break // 退避中，等下一轮
      }
    } finally {
      this.sending = false
    }
    return sentAny
  }

  async attempt(item) {
    const { retry } = this.config
    const result = await postMilestone(item.envelope, {
      endpoint: this.config.endpoint,
      secret: this.config.secret,
      token: this.config.token,
      timeoutMs: this.config.timeoutMs,
    })
    item.attempts += 1
    item.lastResult = result.result
    item.lastStatus = result.status

    if (result.result === RESULT.OK || result.result === RESULT.DUPLICATE) {
      this.queue.shift()
      this.stats_.acked += 1
      if (result.result === RESULT.DUPLICATE) this.stats_.duplicates += 1
      this.log(
        `已同步 ${item.envelope.milestone.kind}/${item.envelope.milestone.status} ` +
          `delivery=${item.envelope.deliveryId.slice(0, 8)} status=${result.status}`,
      )
      this.persist()
      return 'acked'
    }

    if (result.result === RESULT.PERMANENT) {
      this.queue.shift()
      this.stats_.permanentFailures += 1
      this.parked.push({ envelope: item.envelope, reason: result.reason || `HTTP ${result.status}`, at: Date.now() })
      this.parked = this.parked.slice(-100)
      this.log(
        `永久失败（不重试）${item.envelope.milestone.kind} HTTP ${result.status}` +
          `${result.body?.error ? `: ${result.body.error}` : ''}`,
      )
      this.persist()
      return 'parked'
    }

    // 暂时失败：退避重试
    if (item.attempts >= (retry?.attempts ?? 5)) {
      this.queue.shift()
      this.stats_.parked += 1
      this.parked.push({ envelope: item.envelope, reason: result.reason || `HTTP ${result.status}`, at: Date.now() })
      this.parked = this.parked.slice(-100)
      this.log(`重试耗尽，转入 parked：${item.envelope.milestone.kind}（${result.reason || result.status}）`)
      this.persist()
      return 'parked'
    }

    const delay = computeBackoff(item.attempts, retry)
    item.nextAttemptAt = Date.now() + delay
    this.log(
      `投递失败，${delay}ms 后第 ${item.attempts + 1} 次重试：` +
        `${result.reason || `HTTP ${result.status}`}`,
    )
    this.persist()
    return 'retry'
  }

  status() {
    return {
      ...this.stats_,
      queued: this.queue.length,
      parkedCount: this.parked.length,
      pendingBytes: this.pendingBytes(),
      oldestQueuedAt: this.queue[0]?.envelope?.emittedAt ?? null,
    }
  }
}
