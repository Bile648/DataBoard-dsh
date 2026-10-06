/** 与后端载荷一一对应的类型定义（见 docs/progress-sync-design.md 第 5 节） */

export type MilestoneKind =
  | 'goal'
  | 'deliverable'
  | 'report'
  | 'plan'
  | 'blocked'
  | 'phase'
  | 'turn'
  | 'session'

export type MilestoneStatus =
  | 'started'
  | 'in_progress'
  | 'updated'
  | 'completed'
  | 'blocked'
  | 'paused'
  | 'failed'
  | 'cleared'
  | 'idle'
  | 'ended'

export interface Goal {
  id: string | null
  objective: string | null
  phase: 'active' | 'paused' | 'blocked' | 'complete' | null
  activation: string | null
  roundsStarted: number
  maxGoalRounds: number | null
  blockedReason: { code: string; message: string } | null
  createdAt: number | null
  updatedAt: number | null
}

export interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface Counts {
  pending: number
  in_progress: number
  completed: number
  total: number
}

export interface Artifact {
  path: string
  kind: string
  description?: string | null
  bytes?: number | null
}

export interface Report {
  format: 'markdown'
  title: string | null
  body: string
  bytes: number
  truncated: boolean
  source: 'present' | 'assistant-message' | 'synthesized'
  sha256: string
}

export interface Changes {
  turn: number | null
  files: number
  added: number
  deleted: number
  sample: string[]
}

export interface MilestoneEnvelope {
  schemaVersion: number
  deliveryId: string
  emittedAt: number
  source: { host: string; version: string | null; profile: string | null; plugin: string }
  session: { id: string; title: string | null; cwd: string | null; seq: number | null; url: string | null }
  milestone: {
    kind: MilestoneKind
    status: MilestoneStatus
    title: string | null
    at: number
    priority: 'normal' | 'high'
    sequenceKey: string
  }
  task: { goal?: Goal | null; todos?: Todo[]; counts?: Counts; completionRatio?: number | null } | null
  report: Report | null
  artifacts: Artifact[]
  changes: Changes | null
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null
  error: { code: string; message: string; stage: string } | null
}

export interface MilestoneRecord {
  receivedAt: number
  envelope: MilestoneEnvelope
  meta: { signature?: string; remote?: string; userAgent?: string; receivedAt?: number }
}

export interface SessionState {
  sessionId: string
  session: { id?: string; title?: string | null; cwd?: string | null }
  goal: Goal | null
  todos: Todo[]
  counts: Counts | Record<string, never>
  completionRatio: number | null
  lastStatus: MilestoneStatus | null
  lastKind: MilestoneKind | null
  lastMilestoneAt: number | null
  milestoneCount: number
  latestReport: Report | null
  artifacts: Artifact[]
  lastSeq: number | null
}

/** 已登录用户 */
export interface User {
  id: number
  username: string
  displayName: string | null
  isAdmin: boolean
  createdAt: number
  lastLoginAt: number | null
}

/** 管理员用户列表里的一项（与 User 同构，单独命名便于以后扩展） */
export type AdminUser = User

export interface LoginResult {
  ok: boolean
  user: User
  expiresAt: number
}

/** 看板统计（需登录） */
export interface HealthStats {
  ok: boolean
  milestones: number
  sessions: number
  users: number
  authRequired: boolean
}

export interface IngestTokenInfo {
  ok: boolean
  token: string
  managedByEnv: boolean
  snippet: string
}
