/**
 * 投影器：把 DSH 的事件 / 契约对象转成里程碑条目（纯函数，可单测）。
 *
 * 字段来源见 docs/progress-sync-design.md 第 3 节，全部为实测存在的契约：
 *   goal/changed → GoalView{objective, phase, blockedReason, roundsStarted, maxGoalRounds, activation}
 *   session/event → SessionEvent{turn/end, tool/call, assistant/message(usage), workspace/changes}
 *   todo_write 工具参数为完整待办列表；present 工具参数为交付物清单
 */

import { randomUUID } from 'node:crypto'

import { PLUGIN_VERSION } from './config.js'
import { relativize } from './reporter.js'

export const MILESTONE = {
  GOAL: 'goal',
  DELIVERABLE: 'deliverable',
  REPORT: 'report',
  PLAN: 'plan',
  BLOCKED: 'blocked',
  PHASE: 'phase',
  TURN: 'turn',
  SESSION: 'session',
}

/** GoalOperation → 里程碑 status */
const GOAL_STATUS = {
  create: 'in_progress',
  resume: 'in_progress',
  edit: 'updated',
  pause: 'paused',
  complete: 'completed',
  block: 'blocked',
  clear: 'cleared',
}

/** 这些状态值得走高优先通道，立即发送 */
const HIGH_PRIORITY_STATUS = new Set(['blocked', 'completed', 'failed'])

export function parseToolArguments(raw) {
  if (raw && typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(String(raw ?? ''))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

// ------------------------------------------------------------------ 任务状态

export function mapGoal(goal) {
  if (!goal || typeof goal !== 'object') return null
  return {
    id: goal.id ?? null,
    objective: goal.objective ?? null,
    phase: goal.phase ?? null,
    activation: goal.activation ?? null,
    roundsStarted: goal.roundsStarted ?? 0,
    maxGoalRounds: goal.maxGoalRounds ?? null,
    blockedReason: goal.blockedReason ?? null,
    createdAt: goal.createdAt ?? null,
    updatedAt: goal.updatedAt ?? null,
  }
}

export function projectGoalChange(change) {
  const operation = change?.operation ?? 'edit'
  const status = GOAL_STATUS[operation] ?? 'updated'
  const goal = mapGoal(change?.goal)
  const sequenceKey = `goal:${change?.ref?.id ?? goal?.id ?? 'unknown'}`
  return {
    milestone: {
      kind: MILESTONE.GOAL,
      status,
      title: goal?.objective ?? `目标操作：${operation}`,
      at: Date.now(),
      priority: HIGH_PRIORITY_STATUS.has(status) ? 'high' : 'normal',
      sequenceKey,
    },
    task: { goal },
    error: status === 'blocked' && goal?.blockedReason
      ? { code: goal.blockedReason.code, message: goal.blockedReason.message, stage: 'goal' }
      : null,
  }
}

export function todoSnapshotFromArgs(args) {
  const todos = Array.isArray(args?.todos)
    ? args.todos
        .filter((t) => t && typeof t === 'object')
        .map((t) => ({ content: String(t.content ?? ''), status: String(t.status ?? 'pending') }))
    : []
  const counts = { pending: 0, in_progress: 0, completed: 0, total: todos.length }
  for (const todo of todos) {
    if (todo.status === 'completed') counts.completed += 1
    else if (todo.status === 'in_progress') counts.in_progress += 1
    else counts.pending += 1
  }
  return { todos, counts, completionRatio: counts.total ? counts.completed / counts.total : null }
}

export function projectTodoCall(args) {
  const { todos, counts, completionRatio } = todoSnapshotFromArgs(args)
  if (!todos.length) return null
  const allDone = counts.total > 0 && counts.completed === counts.total
  const status = allDone ? 'completed' : 'in_progress'
  return {
    milestone: {
      kind: MILESTONE.PLAN,
      status,
      title: `待办 ${counts.completed}/${counts.total}`,
      at: Date.now(),
      priority: allDone ? 'high' : 'normal',
      sequenceKey: 'plan',
    },
    task: { todos, counts, completionRatio },
  }
}

// -------------------------------------------------------------------- 交付物

export function projectPresentCall(args, { cwd } = {}) {
  const files = Array.isArray(args?.files) ? args.files : []
  const artifacts = files
    .filter((f) => f && typeof f === 'object' && f.path)
    .map((f) => ({
      path: relativize(String(f.path), cwd),
      kind: /\.md$/i.test(String(f.path)) ? 'markdown' : 'file',
      description: f.description ? String(f.description) : null,
    }))
  if (!artifacts.length) return null
  return {
    milestone: {
      kind: MILESTONE.DELIVERABLE,
      status: 'completed',
      title: artifacts[0].description ?? artifacts[0].path,
      at: Date.now(),
      priority: 'high',
      sequenceKey: `deliverable:${artifacts[0].path}`,
    },
    artifacts,
  }
}

export function projectReportTool(toolName, args, { cwd } = {}) {
  const path = args?.file_path ?? args?.path ?? null
  if (!path || !/\.md$/i.test(String(path))) return null
  const artifact = { path: relativize(String(path), cwd), kind: 'markdown', description: null }
  return {
    milestone: {
      kind: MILESTONE.REPORT,
      status: 'completed',
      title: `${toolName === 'edit' ? '更新' : '生成'}报告 ${artifact.path}`,
      at: Date.now(),
      priority: 'normal',
      sequenceKey: `report:${artifact.path}`,
    },
    artifacts: [artifact],
  }
}

// -------------------------------------------------------------- 阶段与阻塞

export function projectWorkflowPhase(title, info = {}) {
  return {
    milestone: {
      kind: MILESTONE.PHASE,
      status: 'in_progress',
      title: title ? `阶段：${title}` : 'workflow 阶段',
      at: Date.now(),
      priority: 'normal',
      sequenceKey: `phase:${info.runId ?? title ?? 'unknown'}`,
    },
  }
}

export function projectError({ stage = 'unknown', code = 'unknown', message = '' } = {}) {
  return {
    milestone: {
      kind: MILESTONE.BLOCKED,
      status: 'failed',
      title: message || `执行失败（${stage}）`,
      at: Date.now(),
      priority: 'high',
      sequenceKey: `blocked:${stage}`,
    },
    error: { code, message, stage },
  }
}

const TURN_END_ERROR = new Set(['error', 'aborted', 'interrupted', 'blocked'])

export function projectTurnEnd(reason) {
  const kind = reason?.kind ?? 'completed'
  if (TURN_END_ERROR.has(kind)) {
    return projectError({
      stage: 'turn',
      code: kind,
      message: reason?.error?.message ?? reason?.reason?.reason ?? `回合结束：${kind}`,
    })
  }
  return {
    milestone: {
      kind: MILESTONE.TURN,
      status: 'completed',
      title: '回合完成',
      at: Date.now(),
      priority: 'normal',
      sequenceKey: 'turn',
    },
  }
}

// -------------------------------------------------------- 事件与工具调用分发

export function projectToolCall(name, rawArguments, context = {}) {
  const args = parseToolArguments(rawArguments)
  switch (name) {
    case 'present':
      return projectPresentCall(args, context)
    case 'todo_write':
      return projectTodoCall(args)
    case 'write':
    case 'edit':
      return projectReportTool(name, args, context)
    default:
      return null
  }
}

/**
 * 从一个 SessionEvent 投影出里程碑条目；不产生里程碑时返回 null。
 * @returns {{milestone: object, task?: object, artifacts?: Array, changes?: object, usage?: object, error?: object}|null}
 */
export function projectSessionEvent(event, context = {}) {
  if (!event || typeof event !== 'object') return null
  switch (event.type) {
    case 'tool/call':
      return projectToolCall(event.data?.name, event.data?.arguments, context)

    case 'turn/end':
      return projectTurnEnd(event.data?.reason)

    case 'workspace/changes': {
      const data = event.data ?? {}
      const files = Array.isArray(data.files) ? data.files : []
      return {
        milestone: {
          kind: MILESTONE.TURN,
          status: 'completed',
          title: `变更 ${data.total ?? files.length} 个文件`,
          at: Date.now(),
          priority: 'normal',
          sequenceKey: `changes:${data.turn ?? event.seq ?? 'unknown'}`,
        },
        changes: {
          turn: data.turn ?? null,
          files: data.total ?? files.length,
          added: data.added ?? 0,
          deleted: data.deleted ?? 0,
          sample: files.slice(0, 10).map((f) => relativize(String(f.path ?? f.display ?? ''), context.cwd)),
        },
      }
    }

    default:
      return null
  }
}

/** 取助手消息的纯文本（报告的第二级来源） */
export function assistantTextFromEvent(event) {
  if (event?.type !== 'assistant/message') return null
  const blocks = event.data?.message?.content
  if (!Array.isArray(blocks)) return null
  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n')
    .trim()
  return text || null
}

export function usageFromEvent(event) {
  if (event?.type !== 'assistant/message') return null
  const usage = event.data?.usage
  if (!usage) return null
  return {
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
  }
}

// ------------------------------------------------------------------ 信封组装

/**
 * 组装最终 POST 载荷（对应设计 5.1）。
 * deliveryId 在这里生成，重试时复用（由 outbox 持有同一条载荷对象）。
 */
export function buildEnvelope(item, { session, config, report = null } = {}) {
  const includeCwd = config?.report?.includeCwd === true
  return {
    schemaVersion: 1,
    deliveryId: randomUUID(),
    emittedAt: Date.now(),
    source: {
      host: 'dsh',
      version: config?.dshVersion ?? null,
      profile: config?.profile ?? null,
      plugin: `dsh-progress/${PLUGIN_VERSION}`,
    },
    session: {
      id: session?.id ?? item.sessionId,
      title: session?.title ?? null,
      cwd: includeCwd ? (session?.cwd ?? null) : null,
      seq: item.seq ?? null,
      url: item.url ?? session?.url ?? null,
    },
    milestone: {
      kind: item.milestone.kind,
      status: item.milestone.status,
      title: item.milestone.title ?? null,
      at: item.milestone.at ?? Date.now(),
      priority: item.milestone.priority ?? 'normal',
      sequenceKey: item.milestone.sequenceKey ?? item.milestone.kind,
    },
    task: item.task ?? null,
    report: report ?? null,
    artifacts: item.artifacts ?? [],
    changes: item.changes ?? null,
    usage: item.usage ?? null,
    error: item.error ?? null,
  }
}
