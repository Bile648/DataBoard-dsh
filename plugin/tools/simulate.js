#!/usr/bin/env node
/**
 * 连通性模拟器：不依赖 DSH，直接把合成事件喂给**真实的**投影器 / 合并器 / 发件箱 / 传输层，
 * 验证「插件 → 后端」整条链路。
 *
 * 用法：
 *   node tools/simulate.js
 *   node tools/simulate.js --endpoint http://127.0.0.1:8787 --secret dev-secret-123
 *   node tools/simulate.js --scenario happy        # happy | duplicate | offline | auth
 *
 * 退出码：0=全部通过，1=有失败项（可用于 CI）。
 */

import { promises as fs } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'

import { resolveConfig, endpointFor } from '../src/config.js'
import { Coalescer } from '../src/coalescer.js'
import { Outbox } from '../src/outbox.js'
import { postMilestone, RESULT, checkHealth } from '../src/transport.js'
import { buildEnvelope, projectGoalChange, projectSessionEvent } from '../src/projector.js'
import { buildReport } from '../src/reporter.js'

// ------------------------------------------------------------------ 参数解析

const argv = process.argv.slice(2)
const arg = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const has = (flag) => argv.includes(flag)

const ENDPOINT = arg('--endpoint', process.env.DSH_PROGRESS_ENDPOINT ?? 'http://127.0.0.1:8787')
const SECRET = arg('--secret', process.env.DSH_PROGRESS_SECRET ?? '')
const SCENARIO = arg('--scenario', 'all')
const CWD = process.cwd()

// ------------------------------------------------------------------ 断言工具

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url) {
  const response = await fetch(url)
  return response.json()
}

// ---------------------------------------------------------------- 合成事件源

const session = { id: 'sim-session-0001', title: '进度同步插件联调', header: { cwd: CWD } }
let seq = 0
const event = (type, data) => ({ type, seq: ++seq, time: Date.now(), data })

const DESIGN_DOC = resolvePath(CWD, 'docs/progress-sync-design.md')

function buildScenarioEvents() {
  const now = Date.now()
  return {
    goalCreate: {
      operation: 'create',
      ref: { id: 'goal-sim-1', revision: 1 },
      goal: {
        id: 'goal-sim-1',
        objective: '打通 插件 → Python 后端 → React 前端 的进度同步链路',
        phase: 'active',
        activation: 'armed',
        roundsStarted: 1,
        maxGoalRounds: 5,
        createdAt: now,
        updatedAt: now,
      },
    },
    goalComplete: {
      operation: 'complete',
      ref: { id: 'goal-sim-1', revision: 2 },
      goal: {
        id: 'goal-sim-1',
        objective: '打通 插件 → Python 后端 → React 前端 的进度同步链路',
        phase: 'complete',
        activation: 'armed',
        roundsStarted: 1,
        maxGoalRounds: 5,
        createdAt: now,
        updatedAt: now,
      },
    },
    todoCall: event('tool/call', {
      turn: 1,
      step: 3,
      callId: 'call-todo-1',
      name: 'todo_write',
      arguments: JSON.stringify({
        todos: [
          { content: '搭建 Python 后端', status: 'completed' },
          { content: '实现插件雏形', status: 'completed' },
          { content: '前端展示进度', status: 'in_progress' },
        ],
      }),
    }),
    writeCall: event('tool/call', {
      turn: 1,
      step: 4,
      callId: 'call-write-1',
      name: 'write',
      arguments: JSON.stringify({ file_path: DESIGN_DOC, content: '# 详细设计\n...(省略)' }),
    }),
    presentCall: event('tool/call', {
      turn: 1,
      step: 5,
      callId: 'call-present-1',
      name: 'present',
      arguments: JSON.stringify({
        files: [{ path: DESIGN_DOC, description: '进度同步插件详细设计' }],
      }),
    }),
    changes: event('workspace/changes', {
      turn: 1,
      total: 3,
      added: 412,
      deleted: 18,
      files: [
        { path: 'docs/progress-sync-design.md', added: 380, deleted: 0 },
        { path: 'plugin/src/index.js', added: 30, deleted: 0 },
        { path: 'server/app.py', added: 2, deleted: 18 },
      ],
    }),
    assistantMessage: event('assistant/message', {
      turn: 1,
      step: 6,
      message: {
        role: 'assistant',
        source: { kind: 'model' },
        content: [{ type: 'text', text: '## 阶段小结\n\n后端与插件雏形已完成，前端待接入。\n\n- 后端：Flask，幂等去重已实现\n- 插件：投影/合并/发件箱已就绪' }],
      },
      stream: [],
      usage: { inputTokens: 12000, outputTokens: 3400, totalTokens: 15400 },
    }),
  }
}

// ------------------------------------------------------- 用真实管线跑一遍事件

async function runPipeline(config, events, captured) {
  const outbox = new Outbox(config, { log: (m) => has('--verbose') && console.log(`    · ${m}`) })
  const coalescer = new Coalescer({
    windowMs: 120,
    dedupeWindowMs: 0,
    onFlush: (item) => {
      const envelope = buildEnvelope(item, { session: session, config, report: item.report ?? null })
      captured.push(envelope)
      outbox.enqueue(envelope)
    },
    log: (m) => has('--verbose') && console.log(`    · ${m}`),
  })

  const state = { session: { id: session.id, title: session.title, cwd: CWD }, assistantText: null, changes: null, goal: null, seq: 0 }

  const readFile = async (path) => {
    const absolute = isAbsolute(path) ? path : resolvePath(CWD, path)
    return fs.readFile(absolute, 'utf8')
  }

  const emit = async (item) => {
    const report = await buildReport({
      sources: config.report.sources,
      artifacts: item.artifacts ?? [],
      assistantText: state.assistantText,
      readFile,
      maxBytes: config.report.maxBytes,
      context: { milestone: item.milestone, goal: item.task?.goal ?? state.goal, changes: item.changes ?? state.changes, todos: item.task?.todos, counts: item.task?.counts },
    })
    coalescer.push({ ...item, session: state.session, report })
  }

  // 1) 目标创建
  await emit(projectGoalChange(events.goalCreate))
  // 2) 待办快照
  await emit(projectSessionEvent(events.todoCall, { cwd: CWD }))
  // 3) md 报告写入
  await emit(projectSessionEvent(events.writeCall, { cwd: CWD }))
  // 4) 交付物声明（助手消息先入上下文，供报告二级来源使用）
  state.assistantText = events.assistantMessage.data.message.content[0].text
  await emit(projectSessionEvent(events.presentCall, { cwd: CWD }))
  // 5) 工作区变更
  await emit(projectSessionEvent(events.changes, { cwd: CWD }))
  // 6) 目标完成（高优先，立即放行）
  await emit(projectGoalChange(events.goalComplete))

  // 冲刷合并窗口并等待发件箱清空
  coalescer.flush()
  for (let i = 0; i < 40 && outbox.queue.length > 0; i += 1) {
    await outbox.flushDue({ force: true })
    await sleep(50)
  }
  outbox.stop({ timeoutMs: 1000 })
  return outbox
}

// ---------------------------------------------------------------------- 场景

async function scenarioHappy() {
  console.log('\n[场景 1] 正常链路：合成事件 → 插件管线 → 后端')
  const config = resolveConfig({ endpoint: ENDPOINT, secret: SECRET, coalesceWindowMs: 120, outbox: { persistPath: '' } })

  const health = await checkHealth({ endpoint: ENDPOINT })
  if (!check('后端健康检查可达', health.ok, `${endpointFor({ endpoint: ENDPOINT }, '/dsh/progress/v1/health')} → ${health.status}`)) {
    return
  }
  check(
    '后端签名校验模式与本次运行一致',
    Boolean(health.body?.signatureRequired) === Boolean(SECRET),
    `后端 requireSignature=${health.body?.signatureRequired}, 本次带密钥=${Boolean(SECRET)}`,
  )

  const captured = []
  const outbox = await runPipeline(config, buildScenarioEvents(), captured)
  const stats = outbox.status()
  check('发件箱全部投递成功（无失败/无丢弃）', stats.acked > 0 && stats.queued === 0 && stats.dropped === 0, `acked=${stats.acked}, queued=${stats.queued}, dropped=${stats.dropped}`)

  const listed = await getJson(`${endpointFor({ endpoint: ENDPOINT }, '/dsh/progress/v1/milestones')}?limit=50&sessionId=${session.id}`)
  const items = listed.items ?? []
  const envs = items.map((i) => i.envelope)
  check('后端已收到里程碑', envs.length >= 4, `收到 ${envs.length} 条`)

  const kinds = envs.map((e) => e.milestone.kind)
  check('包含 goal / plan / deliverable / turn 四类节点', ['goal', 'plan', 'deliverable', 'turn'].every((k) => kinds.includes(k)), `kinds=${[...new Set(kinds)].join(',')}`)

  const deliverable = envs.find((e) => e.milestone.kind === 'deliverable')
  check('交付物里程碑携带 md 报告正文', Boolean(deliverable?.report?.body?.length > 100), `source=${deliverable?.report?.source}, bytes=${deliverable?.report?.bytes}`)
  check('报告来源为 present（读到了真实文件）', deliverable?.report?.source === 'present', `source=${deliverable?.report?.source}`)
  check('报告带 sha256 摘要', /^[0-9a-f]{64}$/.test(deliverable?.report?.sha256 ?? ''), deliverable?.report?.sha256?.slice(0, 16) + '…')

  const done = envs.find((e) => e.milestone.kind === 'goal' && e.milestone.status === 'completed')
  check('目标完成节点存在', Boolean(done), `title=${done?.milestone?.title}`)
  check('目标完成节点为高优先级（跳过合并窗口）', done?.milestone?.priority === 'high')

  const plan = envs.find((e) => e.milestone.kind === 'plan')
  check('待办快照计数正确', plan?.task?.counts?.total === 3 && plan?.task?.counts?.completed === 2, JSON.stringify(plan?.task?.counts))

  const state = await getJson(`${endpointFor({ endpoint: ENDPOINT }, '/dsh/progress/v1/state')}?sessionId=${session.id}`)
  check('后端折叠出会话状态快照', state?.item?.goal?.phase === 'complete', `goal.phase=${state?.item?.goal?.phase}, 里程碑数=${state?.item?.milestoneCount}`)
  return captured
}

async function scenarioDuplicate(captured) {
  console.log('\n[场景 2] 幂等：同一 deliveryId 重投 → 应返回 409 且不重复入库')
  if (!captured?.length) return check('存在可重投的载荷', false, '场景 1 未捕获到载荷')
  const envelope = captured.find((e) => e.milestone.kind === 'goal') ?? captured[0]
  const before = (await getJson(`${endpointFor({ endpoint: ENDPOINT }, '/dsh/progress/v1/milestones')}?limit=500`)).items?.length ?? 0
  const first = await postMilestone(envelope, { endpoint: ENDPOINT, secret: SECRET })
  const second = await postMilestone(envelope, { endpoint: ENDPOINT, secret: SECRET })
  const after = (await getJson(`${endpointFor({ endpoint: ENDPOINT }, '/dsh/progress/v1/milestones')}?limit=500`)).items?.length ?? 0
  check('首次重投被识别为重复（409）', first.status === 409, `status=${first.status}, result=${first.result}`)
  check('重复投递被分类为成功（插件据此出队）', first.result === RESULT.DUPLICATE)
  check('重复投递未新增记录', second.status === 409 && after === before, `before=${before}, after=${after}`)
}

async function scenarioAuth() {
  console.log('\n[场景 3] 鉴权：错误密钥 → 应被拒绝 401')
  if (!SECRET) {
    console.log('  [SKIP] 未配置密钥（后端未开启签名校验）')
    return
  }
  const envelope = buildEnvelope(
    {
      sessionId: session.id,
      milestone: { kind: 'goal', status: 'in_progress', title: '鉴权测试', priority: 'normal', sequenceKey: 'auth-test' },
    },
    { session, config: { report: { includeCwd: false } } },
  )
  const bad = await postMilestone(envelope, { endpoint: ENDPOINT, secret: 'wrong-secret' })
  check('错误签名被拒绝', bad.status === 401, `status=${bad.status}, reason=${bad.body?.error ?? ''}`)
  check('鉴权失败被归类为永久失败（不重试）', bad.result === RESULT.PERMANENT)

  const unsigned = await postMilestone(envelope, { endpoint: ENDPOINT, secret: '' })
  check('缺失签名被拒绝', unsigned.status === 401, `status=${unsigned.status}`)
}

async function scenarioOffline() {
  console.log('\n[场景 4] 对端不可用：应可重试、不崩溃、条目留在队列')
  const deadEndpoint = 'http://127.0.0.1:9' // 保留端口，必然连不上
  const config = resolveConfig({ endpoint: deadEndpoint, secret: SECRET, retry: { attempts: 2, baseMs: 50 }, outbox: { persistPath: '' } })
  const outbox = new Outbox(config, { log: () => {} })
  const envelope = buildEnvelope(
    { sessionId: session.id, milestone: { kind: 'goal', status: 'in_progress', title: '离线测试', priority: 'normal', sequenceKey: 'offline' } },
    { session, config: { report: { includeCwd: false } } },
  )
  outbox.enqueue(envelope)
  await outbox.flushDue({ force: true })
  const stats = outbox.status()
  check('投递失败后条目保留在队列（不丢数据）', stats.queued === 1, `queued=${stats.queued}`)
  check('重试计入 attempts 并进入退避', stats.acked === 0 && stats.dropped === 0, `acked=${stats.acked}, dropped=${stats.dropped}`)
  await outbox.stop({ timeoutMs: 100 })
}

// ------------------------------------------------------------------------ 主流程

async function main() {
  console.log('=== DSH 进度同步 · 连通性模拟 ===')
  console.log(`端点: ${ENDPOINT}`)
  console.log(`密钥: ${SECRET ? '已配置' : '未配置（跳过鉴权场景）'}`)
  console.log(`场景: ${SCENARIO}`)

  let captured = []
  const run = async (name, fn) => {
    if (SCENARIO !== 'all' && SCENARIO !== name) return
    await fn()
  }

  await run('happy', async () => {
    captured = (await scenarioHappy()) ?? []
  })
  await run('duplicate', () => scenarioDuplicate(captured))
  await run('auth', () => scenarioAuth())
  await run('offline', () => scenarioOffline())

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length) {
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('模拟器异常：', error)
  process.exitCode = 1
})
