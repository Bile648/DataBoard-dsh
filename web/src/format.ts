import type { MilestoneKind, MilestoneStatus } from './types'

export const KIND_LABEL: Record<MilestoneKind, string> = {
  goal: '目标',
  deliverable: '交付物',
  report: '报告',
  plan: '待办',
  blocked: '阻塞',
  phase: '阶段',
  turn: '回合',
  session: '会话',
}

export const STATUS_LABEL: Record<MilestoneStatus, string> = {
  started: '已开始',
  in_progress: '进行中',
  updated: '已更新',
  completed: '已完成',
  blocked: '被阻塞',
  paused: '已暂停',
  failed: '失败',
  cleared: '已清除',
  idle: '空闲',
  ended: '已结束',
}

export const PHASE_LABEL: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '被阻塞',
  complete: '已完成',
}

const pad = (value: number) => String(value).padStart(2, '0')

export function formatTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  const date = new Date(ms)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatRelative(ms: number | null | undefined): string {
  if (!ms) return '—'
  const delta = Date.now() - ms
  if (delta < 1000) return '刚刚'
  if (delta < 60_000) return `${Math.floor(delta / 1000)} 秒前`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  return `${Math.floor(delta / 3_600_000)} 小时前`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
