/**
 * 后端接口封装。
 *
 * 生产环境由后端同源托管前端，因此这里全部用**相对路径**，Cookie 自然随请求发送。
 * 开发环境由 Vite 的 proxy 转发到后端（见 vite.config.ts），同样不涉及跨域。
 */

import type {
  AdminUser,
  HealthStats,
  IngestTokenInfo,
  LoginResult,
  MilestoneRecord,
  SessionState,
  User,
} from './types'

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const message =
      (payload as { error?: string } | null)?.error ?? `请求失败（HTTP ${response.status}）`
    throw new ApiError(message, response.status)
  }
  return payload as T
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

// --------------------------------------------------------------------- 认证

/** 返回当前用户；未登录返回 null（不抛异常，便于首屏判断） */
export async function fetchMe(): Promise<User | null> {
  try {
    const data = await request<{ user: User }>('/api/auth/me')
    return data.user
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null
    throw error
  }
}

export const login = (username: string, password: string) =>
  post<LoginResult>('/api/auth/login', { username, password })

export const logout = () => post<{ ok: boolean }>('/api/auth/logout')

export const changePassword = (currentPassword: string, newPassword: string) =>
  post<{ ok: boolean }>('/api/auth/password', { currentPassword, newPassword })

// ------------------------------------------------------------------- 看板数据

export const fetchHealth = () => request<HealthStats>('/api/health')

export const fetchMilestones = (limit = 100) =>
  request<{ items: MilestoneRecord[] }>(`/api/milestones?limit=${limit}`)

export const fetchSessions = () => request<{ items: SessionState[] }>('/api/sessions')

export const fetchState = (sessionId: string) =>
  request<{ item: SessionState }>(`/api/state?sessionId=${encodeURIComponent(sessionId)}`)

// --------------------------------------------------------------------- 管理

export const fetchIngestToken = () => request<IngestTokenInfo>('/api/admin/ingest-token')

export const rotateIngestToken = () => post<IngestTokenInfo>('/api/admin/ingest-token/rotate')

export const fetchUsers = () => request<{ items: AdminUser[] }>('/api/admin/users')

export const createUser = (payload: {
  username: string
  password: string
  isAdmin: boolean
  displayName?: string
}) => post<{ user: AdminUser }>('/api/admin/users', payload)

export const deleteUser = (username: string) =>
  request<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' })

export const resetUserPassword = (username: string, password: string) =>
  post<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(username)}/password`, { password })

export const clearMilestones = () => post<{ removed: number }>('/api/admin/milestones/clear')
