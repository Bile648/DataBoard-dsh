#!/usr/bin/env node
/**
 * 连通性模拟器：不依赖 DSH，直接把合成事件喂给**真实的**投影器 / 合并器 / 发件箱 / 传输层，
 * 验证「插件 → 后端 → 看板接口」整条链路，并覆盖鉴权与幂等语义。
 *
 * 用法：
 *   node tools/simulate.js --token dshi_xxx --password '管理员密码'
 *   node tools/simulate.js --token dshi_xxx --password xxx --verbose
 *   node tools/simulate.js --secret dev-secret-123 --password xxx   # HMAC 兼容路径
 *   node tools/simulate.js --scenario auth --token dshi_xxx
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
const TOKEN = arg('--token', process.env.DSH_PROGRESS_TOKEN ?? '')
const SECRET = arg('--secret', process.env.DSH_PROGRESS_SECRET ?? '')
const USERNAME = arg('--user', 'admin')
const PASSWORD = arg('--password', process.env.DSH_PROGRESS_PASSWORD ?? '')
const SCENARIO = arg('--scenario', 'all')
const CWD = process.cwd()

// ------------------------------------------------------------------ 断言工具

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// -------------------------------------------------- 看板接口（需要登录会话）

let sessionCookie = null

async function login() {
  const response = await fetch(`${ENDPOINT}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  })
  if (!response.ok) {
    throw new Error(`登录失败 HTTP ${response.status}（用户名 ${USERNAME}）`)
  }
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  if (!cookie) throw new Error('登录响应没有 Set-Cookie')
  sessionCookie = cookie
  return cookie
}

async function apiGet(path) {
  const response = await fetch(`${ENDPOINT}${path}`, {
    headers: sessionCookie ? { Cookie: sessionCookie } : {},
  })
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`)
  return response.json()
}

// ---------------------------------------------------------------- 合成事件源

const session = { id: 'sim-session-0001', title: '进度同步插件联调', header: { cwd: CWD } }
let seq = 0
const event = (type, data) => ({ type, seq: ++seq, time: Date.now(), data })

const DESIGN_DOC = resolvePath(CWD, 'docs/progress-sync-design.md')

function buildScenarioEvents() {
  const now = Date.now()
  const goal = {
    id: 'goal-sim-1',
    objective: '打通 插件 → Python 后端 → React 看板 的进度同步链路',
    phase: 'active',
    activation: 'armed',
    roundsStarted: 1,
    maxGoalRounds: 5,
    createdAt: now,
    updatedAt: now,
  }
  return {
    goalCreate: { operation: 'create', ref: { id: 'goal-sim-1', revision: 1 }, goal },
    goalComplete: { operation: 'complete', ref: { id: 'goal-sim-1', revision: 2 }, goal: { ...goal, phase: 'complete' } },
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
      arguments: JSON.stringify({ files: [{ path: DESIGN_DOC, description: '进度同步插件详细设计' }] }),
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
        content: [{ type: 'text', text: '## 阶段小结\n\n后端与插件雏形已完成，前端待接入。' }],
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
      const envelope = buildEnvelope(item, { session, config, report: item.report ?? null })
      captured.push(envelope)
      outbox.enqueue(envelope)
    },
    log: (m) => has('--verbose') && console.log(`    · ${m}`),
  })

  const state = {
    session: { id: session.id, title: session.title, cwd: CWD },
    assistantText: null,
    changes: null,
    goal: null,
    artifacts: [],
    seq: 0,
  }

  const readFile = async (path) => {
    const absolute = isAbsolute(path) ? path : resolvePath(CWD, path)
    return fs.readFile(absolute, 'utf8')
  }

  const emit = async (item) => {
    if (item.artifacts?.length) {
      const seen = new Set()
      state.artifacts = [...item.artifacts, ...state.artifacts].filter((artifact) => {
        const key = artifact?.path ?? JSON.stringify(artifact)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }
    const report = await buildReport({
      sources: config.report.sources,
      artifacts: item.artifacts?.length ? item.artifacts : state.artifacts,
      assistantText: state.assistantText,
      readFile,
      maxBytes: config.report.maxBytes,
      context: {
        milestone: item.milestone,
        goal: item.task?.goal ?? state.goal,
        changes: item.changes ?? state.changes,
        todos: item.task?.todos,
        counts: item.task?.counts,
      },
    })
    coalescer.push({ ...item, session: state.session, report })
  }

  await emit(projectGoalChange(events.goalCreate))
  await emit(projectSessionEvent(events.todoCall, { cwd: CWD }))
  await emit(projectSessionEvent(events.writeCall, { cwd: CWD }))
  state.assistantText = events.assistantMessage.data.message.content[0].text
  await emit(projectSessionEvent(events.presentCall, { cwd: CWD }))
  await emit(projectSessionEvent(events.changes, { cwd: CWD }))
  await emit(projectGoalChange(events.goalComplete))

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
  console.log('\n[场景 1] 正常链路：合成事件 → 插件管线 → 后端 → 看板接口')

  const config = resolveConfig({
    endpoint: ENDPOINT,
    token: TOKEN,
    secret: SECRET,
    coalesceWindowMs: 120,
    outbox: { persistPath: '' },
  })

  const health = await checkHealth({ endpoint: ENDPOINT })
  if (!check('摄入端健康检查可达', health.ok, `HTTP ${health.status}`)) return []

  const captured = []
  const outbox = await runPipeline(config, buildScenarioEvents(), captured)
  const stats = outbox.status()
  check(
    '发件箱全部投递成功（无失败/无丢弃）',
    stats.acked > 0 && stats.queued === 0 && stats.dropped === 0,
    `acked=${stats.acked}, queued=${stats.queued}, dropped=${stats.dropped}`,
  )

  if (!PASSWORD) {
    console.log('  [SKIP] 未提供 --password，跳过看板接口校验')
    return captured
  }

  const listed = await apiGet(`/api/milestones?limit=50&sessionId=${session.id}`)
  const envelopes = (listed.items ?? []).map((item) => item.envelope)
  check('看板接口已收到里程碑', envelopes.length >= 4, `收到 ${envelopes.length} 条`)

  const kinds = envelopes.map((e) => e.milestone.kind)
  check(
    '包含 goal / plan / deliverable / turn 四类节点',
    ['goal', 'plan', 'deliverable', 'turn'].every((k) => kinds.includes(k)),
    [...new Set(kinds)].join(','),
  )

  const deliverable = envelopes.find((e) => e.milestone.kind === 'deliverable')
  check(
    '交付物里程碑携带 md 报告正文（来源为真实文件）',
    deliverable?.report?.source === 'present' && (deliverable?.report?.bytes ?? 0) > 1000,
    `source=${deliverable?.report?.source}, bytes=${deliverable?.report?.bytes}`,
  )
  check('报告带 sha256 摘要', /^[0-9a-f]{64}$/.test(deliverable?.report?.sha256 ?? ''))

  const done = envelopes.find((e) => e.milestone.kind === 'goal' && e.milestone.status === 'completed')
  check('目标完成节点存在且为高优先', Boolean(done) && done?.milestone?.priority === 'high')
  check(
    '目标完成节点继承了交付物报告（未降级为助手短消息）',
    done?.report?.source === 'present' && (done?.report?.bytes ?? 0) > 1000,
    `source=${done?.report?.source}`,
  )

  const plan = envelopes.find((e) => e.milestone.kind === 'plan')
  check(
    '待办快照计数正确',
    plan?.task?.counts?.total === 3 && plan?.task?.counts?.completed === 2,
    JSON.stringify(plan?.task?.counts),
  )

  const state = await apiGet(`/api/state?sessionId=${session.id}`)
  check('后端折叠出会话状态快照', state?.item?.goal?.phase === 'complete', `goal.phase=${state?.item?.goal?.phase}`)
  return captured
}

async function scenarioDuplicate(captured) {
  console.log('\n[场景 2] 幂等：同一 deliveryId 重投 → 应返回 409 且不重复入库')
  if (!captured?.length) return check('存在可重投的载荷', false, '场景 1 未捕获到载荷')
  const envelope = captured.find((e) => e.milestone.kind === 'goal') ?? captured[0]
  const before = (await apiGet('/api/milestones?limit=500')).items?.length ?? 0
  const first = await postMilestone(envelope, { endpoint: ENDPOINT, token: TOKEN, secret: SECRET })
  const second = await postMilestone(envelope, { endpoint: ENDPOINT, token: TOKEN, secret: SECRET })
  const after = (await apiGet('/api/milestones?limit=500')).items?.length ?? 0
  check('首次重投被识别为重复（409）', first.status === 409, `status=${first.status}`)
  check('重复投递被归类为成功（插件据此出队）', first.result === RESULT.DUPLICATE)
  check('重复投递未新增记录', second.status === 409 && after === before, `before=${before}, after=${after}`)
}

async function scenarioAuth() {
  console.log('\n[场景 3] 摄入鉴权：令牌 / 缺失凭据 / 错误签名')
  const fresh = (label) =>
    buildEnvelope(
      {
        sessionId: 'sim-auth-probe',
        milestone: {
          kind: 'goal',
          status: 'in_progress',
          title: `[连通性测试] ${label}`,
          priority: 'normal',
          sequenceKey: `auth-${label}`,
        },
      },
      { session: { id: 'sim-auth-probe', title: '鉴权探测' }, config: { report: { includeCwd: false } } },
    )

  if (TOKEN) {
    const good = await postMilestone(fresh('valid-token'), { endpoint: ENDPOINT, token: TOKEN })
    check('有效摄入令牌被接受', good.status === 202, `status=${good.status}`)

    const bad = await postMilestone(fresh('bad-token'), { endpoint: ENDPOINT, token: 'dshi_definitely_wrong' })
    check('错误摄入令牌被拒绝', bad.status === 401, `status=${bad.status}`)
    check('鉴权失败被归类为永久失败（不重试）', bad.result === RESULT.PERMANENT)
  } else {
    console.log('  [SKIP] 未提供 --token，跳过令牌用例')
  }

  const anonymous = await postMilestone(fresh('no-credentials'), { endpoint: ENDPOINT })
  check('无凭据投递被拒绝', anonymous.status === 401, `status=${anonymous.status}, error=${anonymous.body?.error ?? ''}`)

  if (SECRET) {
    const badSig = await postMilestone(fresh('bad-signature'), { endpoint: ENDPOINT, secret: 'wrong-secret' })
    check('错误 HMAC 签名被拒绝', badSig.status === 401, `status=${badSig.status}`)
  }

  if (PASSWORD) {
    const anonRead = await fetch(`${ENDPOINT}/api/milestones?limit=1`)
    check('未登录读取看板被拒绝', anonRead.status === 401, `status=${anonRead.status}`)
  }
}

async function scenarioOffline() {
  console.log('\n[场景 4] 对端不可用：应可重试、不崩溃、条目留在队列')
  const deadEndpoint = 'http://127.0.0.1:9' // 保留端口，必然连不上
  const config = resolveConfig({
    endpoint: deadEndpoint,
    token: TOKEN,
    retry: { attempts: 2, baseMs: 50 },
    outbox: { persistPath: '' },
  })
  const outbox = new Outbox(config, { log: () => {} })
  const envelope = buildEnvelope(
    {
      sessionId: 'sim-offline',
      milestone: { kind: 'goal', status: 'in_progress', title: '离线测试', priority: 'normal', sequenceKey: 'offline' },
    },
    { session: { id: 'sim-offline' }, config: { report: { includeCwd: false } } },
  )
  outbox.enqueue(envelope)
  await outbox.flushDue({ force: true })
  const stats = outbox.status()
  check('投递失败后条目保留在队列（不丢数据）', stats.queued === 1, `queued=${stats.queued}`)
  check('未产生丢弃', stats.dropped === 0 && stats.acked === 0)
  await outbox.stop({ timeoutMs: 100 })
}

// ------------------------------------------------------------------------ 主流程

async function main() {
  console.log('=== DSH 进度同步 · 连通性模拟 ===')
  console.log(`端点: ${ENDPOINT}`)
  console.log(`凭据: ${TOKEN ? '摄入令牌' : SECRET ? 'HMAC 签名' : '无（鉴权用例会失败）'}`)
  console.log(`场景: ${SCENARIO}`)

  if (PASSWORD) {
    try {
      await login()
      console.log(`已登录为 ${USERNAME}`)
    } catch (error) {
      console.error(`登录失败：${error.message}`)
      process.exitCode = 1
      return
    }
  }

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
