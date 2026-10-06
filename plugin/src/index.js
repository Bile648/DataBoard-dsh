/**
 * DSH 宿主插件入口（cordis 插件形态）。
 *
 * 硬性约束（设计 6.1）：
 *   - `session/event` 是 fire-and-forget 的 emit，**回调内绝不做网络或磁盘 I/O**；
 *     回调只做「投影 + 入队」，异步装配由 setImmediate 脱离事件回调执行。
 *   - 所有监听与定时器经 ctx.effect 注册，卸载 / HMR 时自动清理。
 */

import { promises as nodeFs } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'

import { resolveConfig, PLUGIN_NAME, PLUGIN_VERSION } from './config.js'
import { Coalescer } from './coalescer.js'
import { Outbox } from './outbox.js'
import {
  MILESTONE,
  buildEnvelope,
  projectGoalChange,
  projectSessionEvent,
  projectError,
  projectWorkflowPhase,
  assistantTextFromEvent,
  usageFromEvent,
} from './projector.js'
import { buildReport } from './reporter.js'

export const name = PLUGIN_NAME
export const inject = ['timer']

export function apply(ctx, input = {}) {
  const config = resolveConfig(input)
  if (!config.enabled) {
    ctx.logger?.info?.(`[${PLUGIN_NAME}] 已禁用，跳过注册`)
    return
  }

  const log = (message) => ctx.logger?.info?.(`[${PLUGIN_NAME}] ${message}`)
  const warn = (message) => ctx.logger?.warn?.(`[${PLUGIN_NAME}] ${message}`)

  const outbox = new Outbox(config, { log })
  const coalescer = new Coalescer({
    windowMs: config.coalesceWindowMs,
    dedupeWindowMs: config.dedupeWindowMs,
    onFlush: (item) => {
      // 合并窗口冲刷后才组信封：deliveryId 在此生成，重试期间保持不变
      const envelope = buildEnvelope(item, { session: item.session, config, report: item.report ?? null })
      outbox.enqueue(envelope)
    },
    log,
  })
  outbox.start()

  /** 每个会话的累积上下文（助手收尾消息、变更概览、待办、目标） */
  const sessions = new Map()
  const sessionOf = (session) => {
    const id = session?.id ?? 'unknown'
    if (!sessions.has(id)) {
      sessions.set(id, {
        session: { id, title: session?.title ?? null, cwd: session?.header?.cwd ?? session?.cwd ?? null },
        assistantText: null,
        usage: null,
        changes: null,
        todos: null,
        counts: null,
        goal: null,
        artifacts: [],
        seq: 0,
      })
    }
    const state = sessions.get(id)
    if (session?.title) state.session.title = session.title
    const cwd = session?.header?.cwd ?? session?.cwd
    if (cwd) state.session.cwd = cwd
    return state
  }

  // ------------------------------------------------------------ 异步装配队列

  const pending = []
  let draining = false

  const enqueueMilestone = (item, state) => {
    pending.push({ item, state })
    if (!draining) {
      draining = true
      setImmediate(drain) // 脱离事件回调的同步路径
    }
  }

  async function drain() {
    try {
      while (pending.length) {
        const { item, state } = pending.shift()
        const report = await assembleReport(item, state)
        coalescer.push({
          ...item,
          session: state.session,
          report,
          url: config.previewUrl ? `${config.previewUrl}/#/session/${state.session.id}` : null,
        })
      }
    } catch (error) {
      warn(`装配里程碑失败：${error?.message || error}`)
    } finally {
      draining = false
    }
  }

  async function assembleReport(item, state) {
    if (!config.report?.inline) return null
    if (![MILESTONE.GOAL, MILESTONE.DELIVERABLE, MILESTONE.REPORT, MILESTONE.PLAN, MILESTONE.BLOCKED].includes(item.milestone.kind)) {
      return null
    }
    return buildReport({
      sources: config.report?.sources,
      // 里程碑自带交付物就用自己的；否则继承会话最近一次的交付物 ——
      // 否则「目标完成」这类大节点会因为自身没有产物而退化成助手短消息。
      artifacts: item.artifacts?.length ? item.artifacts : (state.artifacts ?? []),
      assistantText: state.assistantText,
      readFile: makeFileReader(state, warn),
      maxBytes: config.report?.maxBytes,
      context: {
        milestone: item.milestone,
        goal: item.task?.goal ?? state.goal,
        todos: item.task?.todos ?? state.todos,
        counts: item.task?.counts ?? state.counts,
        changes: item.changes ?? state.changes,
      },
    })
  }

  /** 优先走 ctx.fs（受 DSH 沙箱策略约束）；不可用时回退到 node:fs 并告警 */
  function makeFileReader(state, warn) {
    const cwd = state.session.cwd ?? process.cwd()
    const fsService = typeof ctx.get === 'function' ? ctx.get('fs') : undefined
    return async (path) => {
      const absolute = isAbsolute(path) ? path : resolvePath(cwd, path)
      if (fsService?.resolve && fsService?.readText) {
        const target = await fsService.resolve(absolute, { cwd })
        return fsService.readText(target)
      }
      warn(`ctx.fs 不可用，回退 node:fs 读取 ${path}（生产环境应走 ctx.fs 以遵守沙箱策略）`)
      return nodeFs.readFile(absolute, 'utf8')
    }
  }

  // ---------------------------------------------------------------- 事件监听

  const track = (state, item, session, event) => {
    if (item?.task?.goal) state.goal = item.task.goal
    if (item?.task?.todos) {
      state.todos = item.task.todos
      state.counts = item.task.counts
    }
    if (item?.changes) state.changes = item.changes
    if (item?.artifacts?.length) {
      // 交付物累积（新的在前，按路径去重），供后续里程碑继承
      const seen = new Set()
      state.artifacts = [...item.artifacts, ...(state.artifacts ?? [])].filter((artifact) => {
        const key = artifact?.path ?? JSON.stringify(artifact)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }
    if (event?.seq) state.seq = event.seq
    const text = assistantTextFromEvent(event)
    if (text) state.assistantText = text
    const usage = usageFromEvent(event)
    if (usage) state.usage = usage
    if (item) enqueueMilestone({ ...item, seq: event?.seq ?? state.seq }, state)
  }

  const disposers = []

  // 1) 会话事件：工具调用、回合结束、工作区变更
  disposers.push(
    ctx.on('session/event', (session, event) => {
      if (!session?.id || !event?.type) return
      const state = sessionOf(session)
      // 累计 usage/文本，即使不产生里程碑
      const text = assistantTextFromEvent(event)
      if (text) state.assistantText = text
      const usage = usageFromEvent(event)
      if (usage) state.usage = usage
      if (event.seq) state.seq = event.seq

      const item = projectSessionEvent(event, { cwd: state.session.cwd })
      if (!item) return
      if (!isEnabled(item.milestone.kind)) return
      track(state, item, session, event)
    }),
  )

  // 2) 目标状态：最接近「任务状态」的权威来源
  disposers.push(
    ctx.on('goal/changed', (payload) => {
      const agent = payload?.agent
      if (!isEnabled(MILESTONE.GOAL)) return
      const state = sessionOf({ id: agent?.id, title: null })
      const item = projectGoalChange(payload?.change)
      track(state, item, null, null)
    }),
  )

  // 3) 阻塞与失败：高优先通道
  disposers.push(
    ctx.on('agent/error', (payload) => {
      if (!isEnabled(MILESTONE.BLOCKED)) return
      const state = sessionOf({ id: payload?.agent?.id })
      const error = payload?.error ?? {}
      track(
        state,
        projectError({
          stage: `turn ${payload?.turn ?? '?'} step ${payload?.step ?? '?'}`,
          code: error.code ?? 'unknown',
          message: error.message ?? String(error),
        }),
        null,
        null,
      )
    }),
  )

  // 4) workflow 阶段
  disposers.push(
    ctx.on('workflow/phase', (info, title) => {
      if (!isEnabled(MILESTONE.PHASE)) return
      const state = sessions.get(info?.sessionId) ?? sessionOf({ id: info?.sessionId ?? 'workflow' })
      track(state, projectWorkflowPhase(title, info), null, null)
    }),
  )

  // 5) 冲刷检查点：会话 flush 时强制把合并窗口内的内容推出去
  disposers.push(
    ctx.on('session/flush', () => {
      coalescer.flush()
    }),
  )

  // 6) 会话生命周期（默认关闭）
  if (isEnabled(MILESTONE.SESSION)) {
    disposers.push(
      ctx.on('session/created', (session) => {
        const state = sessionOf(session)
        track(
          state,
          { milestone: { kind: MILESTONE.SESSION, status: 'started', title: '会话开始', priority: 'normal', sequenceKey: 'session' } },
          session,
          null,
        )
      }),
    )
  }

  function isEnabled(kind) {
    const key = kind === MILESTONE.BLOCKED ? 'blocked' : kind
    return config.milestones?.[key] !== false
  }

  // ------------------------------------------------------------ 生命周期收尾

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch (error) {
        warn(`卸载监听失败：${error?.message || error}`)
      }
    }
    coalescer.flush()
    outbox.stop({ timeoutMs: 5000 }).catch((error) => warn(`关闭发件箱失败：${error?.message || error}`))
  })

  log(`已启用 → ${config.endpoint}（版本 ${PLUGIN_VERSION}）`)
}

export default { name, inject, apply }
