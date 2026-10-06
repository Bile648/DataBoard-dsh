/** 后端接口封装。基地址可用 VITE_API_BASE 覆盖（默认指向本地 Python 后端）。 */

import type { HealthResponse, MilestoneRecord, SessionState } from './types'

// 注意：在非 Vite 环境（如 Node 下的渲染冒烟测试）里 import.meta.env 为 undefined，
// 因此必须用可选链，否则读取 env 属性会直接抛错。
export const API_BASE: string =
  (import.meta.env?.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:8787'

const url = (path: string) => `${API_BASE.replace(/\/+$/, '')}${path}`

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(url(path), { headers: { Accept: 'application/json' } })
  if (!response.ok) {
    throw new Error(`${path} → HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

export const fetchHealth = () => getJson<HealthResponse>('/dsh/progress/v1/health')

export const fetchMilestones = (limit = 100) =>
  getJson<{ ok: boolean; items: MilestoneRecord[] }>(`/dsh/progress/v1/milestones?limit=${limit}`)

export const fetchSessions = () =>
  getJson<{ ok: boolean; items: SessionState[] }>('/dsh/progress/v1/sessions')

export const fetchState = (sessionId: string) =>
  getJson<{ ok: boolean; item: SessionState }>(
    `/dsh/progress/v1/state?sessionId=${encodeURIComponent(sessionId)}`,
  )
