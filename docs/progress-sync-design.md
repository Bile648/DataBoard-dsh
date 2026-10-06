# 详细设计：开发进度里程碑同步插件（DSH → 外部配套服务）

> 状态：**设计稿，未编码**。范围已按讨论收敛为「只报大节点」：**md 报告（供开发者阅读）+ 任务状态**。
> 接口形态未定，第 4 节是一份可直接拿去对齐的提案。

---

## 1. 设计目标与非目标

### 目标
1. 在**大节点**上向外部服务 POST 一条自包含的里程碑记录：任务状态 + 可读的 markdown 报告 + 变更概览。
2. **不依赖模型记得上报**（自动化），但对阻塞/完成这类关键节点也要能立即发。
3. 对端不可用时不丢数据、恢复后按序补发、不重复。
4. 绝不拖慢代理主循环。

### 非目标
- ❌ 逐次工具调用的流水账（明确不要）
- ❌ 上报代码内容、工具参数、提示词、reasoning（**md 报告正文是唯一例外**，见 §9）
- ❌ 文件级 diff 正文（只报计数与路径样例）
- ❌ 双向控制（不通过外部服务反向驱动 DSH）

---

## 2. 里程碑模型：什么算"一个大节点"

事件源 → 里程碑的映射表（source 列均为本机实测存在的契约）：

| 里程碑 kind | 触发源 | 触发条件 | 映射后的 status | 默认 |
|---|---|---|---|---|
| `goal` | `goal/changed`（host emit） | 任意 goal 变更 | `create`/`resume`→`in_progress`；`complete`→`completed`；`block`→`blocked`；`pause`→`paused`；`clear`→`cleared`；`edit`→`updated` | ✅ |
| `deliverable` | `session/event` → `tool/call` name=`present` | 交付物被声明 | `completed`（附报告正文） | ✅ |
| `report` | `session/event` → `tool/call` name=`write`/`edit` 且目标为 `.md` | 生成了 md 报告 | `completed`（附报告正文） | ⚠️ 合并窗口内聚合成一条 |
| `plan` | `session/event` → `tool/call` name=`todo_write` | todo 完整快照变化 | 由计数推导：全完成→`completed`，否则 `in_progress` | ✅ 仅在计数变化时报 |
| `blocked` | `agent/error`、`turn/end` reason=`error`/`aborted`、goal `block` | 立即 | `blocked` / `failed` | ✅ **高优先通道** |
| `phase` | `workflow/phase`、`workflow/end` | workflow 进入阶段 | `in_progress` / `completed` | ✅ |
| `turn` | `session/event` → `turn/end` reason=`completed` | 该 turn 有文件变更 | `completed` | ❌ 默认关（噪音大） |
| `session` | `session/created`、`agent/status`→idle、`session/disposed` | 会话生命周期 | `started` / `idle` / `ended` | ❌ 默认关 |

**去噪规则**（关键设计约束）：
- 普通节点使用 **3 秒合并窗口**；窗口内同类 milestone 合并为一条（保留最新 status，累加变更计数）。
- `blocked` / `goal completed` **走优先通道，0 延迟直发**，且不被合并。
- `plan` 只在**完成计数变化**时上报（避免 in_progress 抖动刷屏）。
- 同一 `(sessionId, kind, goalId)` 的连续同 status 事件在 30 秒内去重。

---

## 3. 数据来源映射（每个字段从哪来，全部实测确认）

| 载荷字段 | 来源契约 |
|---|---|
| 会话 id | `SessionEvent` 的 `this: Scoped<Session>` / `session.id` |
| 会话标题 | `session-title` 投影（`@deepseek-ai/dsh-session-title` 在 profile 中已启用） |
| 工作目录 | `WorkspaceChangesSummary.cwd` |
| 事件序号 `seq`、时间 `time` | `SessionEvent.seq` / `.time` |
| 任务状态（目标） | `goal/changed` → `GoalView`：`objective`、`phase: 'active'\|'paused'\|'blocked'\|'complete'`、`blockedReason{code,message}`、`roundsStarted`、`maxGoalRounds`、`activation` |
| 任务状态（待办） | `todo_write` 的 `tool/call.arguments`（该工具每次传**完整**列表，天然是快照） |
| 交付物清单 | `present` 的 `tool/call.arguments.files[]`（`{path, description}`） |
| 变更概览 | `workspace/changes` 会话事件 → `workspaceChanges.summary(sessionId, seq)` → `WorkspaceChangesSummary{turn, files[], total, added, deleted}`，`WorkspaceChangedFile{path, display, added, deleted, binary?, oversized?}` |
| 报告正文 | 见 §5.3 的三级来源 |
| token 用量 | `assistant/message` 事件的 `usage: TokenUsage`（可选字段） |
| 送审/阻塞原因 | `agent/error`、`TurnEndReasonMap`（`error`/`aborted`/`blocked`/`interrupted`） |

> 注：`SessionEventMap` 的权威定义已确认包含 `turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/message`（含 `usage`、`stream`）、`tool/call`、`tool/result`（含 `error{name,code,reason}`、`meta`）、`request/header`、`request/context` 等。

---

## 4. 对外接口契约（提案，待与外部服务对齐）

### 4.1 端点

```
POST {baseUrl}/dsh/progress/v1/milestones
POST {baseUrl}/dsh/progress/v1/milestones:batch      # 可选：补发时批量
GET  {baseUrl}/dsh/progress/v1/health                # 可选：配置页"测试连接"
```

### 4.2 请求头

| 头 | 值 | 用途 |
|---|---|---|
| `Content-Type` | `application/json; charset=utf-8` | |
| `X-DSH-Schema` | `1` | 载荷版本，便于服务端演进 |
| `X-DSH-Delivery` | UUID v4 | **幂等键**，重试复用同一个值 |
| `X-DSH-Timestamp` | epoch ms | 防重放 |
| `X-DSH-Signature` | `sha256=<hex>` | `HMAC-SHA256(secret, timestamp + "." + rawBody)` |
| `X-DSH-Session` | sessionId | 便于服务端分流与日志 |
| `User-Agent` | `dsh-progress/<version>` | |

### 4.3 响应语义（决定重试与否）

| 响应 | 含义 | 插件行为 |
|---|---|---|
| `200` / `201` / `202` | 已接收 | 出队，记为 acked |
| `409` | 幂等键重复 | **视同成功**，出队 |
| `400` / `401` / `403` / `413` / `422` | 永久失败（含签名错） | 不重试，落盘归档 + 告警计数 |
| `408` / `425` / `429` / `5xx` / 网络错误 / 超时 | 暂时失败 | 指数退避重试 |
| `429` / `503` 带 `Retry-After` | 主动限流 | 尊重该值 |

### 4.4 顺序与幂等

- 载荷自带 `session.seq` 与 `emittedAt`（epoch ms, UTC）。
- 建议服务端按 `(sessionId, kind, goalId)` 做 **last-write-wins** 得到当前状态，同时把每条按 `seq` 追加成时间线。
- 去重唯一依据是 `X-DSH-Delivery`；重试**绝不**生成新的 deliveryId。
- **建议双写模型**：每条里程碑同时携带「事件」与「任务快照」，服务端既可以只存快照做看板，也可以存事件流做时间线 —— 看板通常需要快照，时间线需要事件，二者用同一份载荷即可满足。

---

## 5. 载荷 Schema

### 5.1 信封

```jsonc
{
  "schemaVersion": 1,
  "deliveryId": "6f1c2b3a-...",          // 与 X-DSH-Delivery 一致
  "emittedAt": 1767225600000,             // epoch ms UTC
  "source": { "host": "dsh", "version": "0.2.0-rc.2", "profile": "web", "plugin": "dsh-progress/0.1.0" },

  "session": {
    "id": "session-71ca2fff7f73",
    "title": "插件开发：进度同步",
    "cwd": "D:\\dshplugin\\databoard",
    "seq": 1234,                          // 触发本里程碑的事件序号
    "url": "http://127.0.0.1:19387/#/session/session-71ca2fff7f73"   // 可选，便于回跳
  },

  "milestone": {
    "kind": "goal",                       // goal | deliverable | report | plan | blocked | phase | turn | session
    "status": "completed",                // started | in_progress | updated | completed | blocked | paused | failed | cleared | idle | ended
    "title": "完成进度同步插件设计",
    "at": 1767225600000,
    "priority": "high",                   // normal | high（high 不受合并窗口影响）
    "sequenceKey": "goal:goal-abc:completed"   // 供服务端做 last-write-wins 的键
  },

  "task": {                               // 任务状态快照（看板直接可用）
    "goal": {
      "id": "goal-abc",
      "objective": "完成进度同步插件的详细设计",
      "phase": "complete",
      "activation": "armed",
      "roundsStarted": 3,
      "maxGoalRounds": 10,
      "blockedReason": null,
      "createdAt": 1767222000000,
      "updatedAt": 1767225600000
    },
    "todos": [
      { "content": "勘察事件面与服务", "status": "completed" },
      { "content": "输出详细设计", "status": "completed" }
    ],
    "counts": { "pending": 0, "in_progress": 0, "completed": 2, "total": 2 },
    "completionRatio": 1.0
  },

  "report": {                             // ★ 供开发者阅读的 md 报告
    "format": "markdown",
    "title": "进度同步插件 · 设计说明",
    "body": "# 详细设计\n\n...",           // 受限大小，见 §5.3
    "bytes": 48213,
    "truncated": false,
    "source": "present",                  // present | report-file | assistant-message | synthesized
    "sha256": "9f2c..."                   // 便于服务端做内容去重/变更检测
  },

  "artifacts": [                          // 交付物清单（即使 body 被截断也保留）
    { "path": "progress-sync-design.md", "kind": "markdown", "bytes": 48213, "description": "详细设计文档" }
  ],

  "changes": {                            // 变更概览，不含正文
    "turn": 7,
    "files": 3,
    "added": 412,
    "deleted": 18,
    "sample": ["progress-sync-design.md", "package.json"]
  },

  "usage": { "inputTokens": 12000, "outputTokens": 3400 },   // 可选
  "error": null                           // kind=blocked/failed 时：{ code, message, stage }
}
```

### 5.2 字段约定

- 所有时间戳为 **epoch 毫秒 UTC**（不传本地时区字符串）。
- 路径统一**裁剪为工作区相对路径**（避免泄漏用户名与目录结构）；`session.cwd` 是唯一例外，可在配置里关掉。
- `null` 与字段缺失语义不同：缺失=该里程碑不适用；`null`=适用但无值。
- `sequenceKey` 是给服务端做状态归并的推荐键，插件保证同一逻辑对象的键稳定。

### 5.3 报告正文的三级来源（按优先级）

1. **`present` 交付物正文** —— 命中 `present` 工具调用后，用交付物路径读取 `.md` 文件内容（经 `ctx.fs.resolve` + 读，受工作区策略约束）。
2. **助手收尾消息** —— 该 turn 最后一条 `assistant/message` 的文本块（`stream` 里 `text-chunks` 聚合成全文）。
3. **插件自组装摘要** —— 模板拼装：目标 objective + todos 快照 + 变更概览。保证任何情况下都有可读正文。

**不读磁盘的备选**：由于 `write` 工具调用时全文就在 `tool/call.arguments` 里，可以直接从会话日志取正文，绕开文件系统策略。代价是长文件会让内存与网络开销变大 —— 默认用「磁盘读取」，策略受限时回退到日志来源。

**大小控制**：`report.maxBytes` 默认 **256 KB**。超限则按 UTF-8 边界安全截断，置 `truncated: true`，并在 `artifacts` 里保留完整文件路径与字节数，供人工获取。

---

## 6. 插件内部架构

```
dsh-plugin-progress-sync/
├─ package.json            # dsh.client 可留空；纯 Host 插件
├─ src/
│  ├─ index.ts             # 插件入口：读 config、注册监听与 disposer
│  ├─ projector.ts         # 纯函数：SessionEvent/goal change → Milestone 候选
│  ├─ coalescer.ts         # 合并窗口 + 优先通道 + 去重
│  ├─ reporter.ts          # 报告装配（三级来源、截断、路径裁剪、脱敏）
│  ├─ outbox.ts            # 有界队列 + storageDomain 持久化 + 重放
│  ├─ transport.ts         # fetch + HMAC 签名 + 超时 + 重试退避
│  ├─ config.ts            # settings schema + credentials 引用
│  └─ preview.ts           # 可选：本地预览/状态路由（联调用）
└─ test/                   # projector/coalescer 的纯函数单测（无需真实事件）
```

### 6.1 关键实现约束

- **监听器内绝不做网络 I/O**：`session/event` 是 fire-and-forget 的 emit，回调里只做「投影 + 入队」，耗时目标 < 1 ms。
- 合并与重试全部由 `ctx.timer`（`throttle`/`interval`）驱动，不阻塞事件循环。
- 所有监听/定时器经 `ctx.effect` 注册，卸载与 HMR 时自动清理；`dispose` 时冲刷 outbox。
- 使用 `session/flush`（会被 await 的并行检查点）作为「必须送达」的冲刷点。

### 6.2 队列状态机

```
queued ──send──▶ sending ──2xx/409──▶ acked(移除)
                    │
                    ├─ 可重试错误 ──▶ retry_wait(退避) ──▶ queued
                    │
                    └─ 重试耗尽 ──▶ parked(落盘归档, 计数)
queued ──队列满──▶ dropped(丢最旧, 计数)      # 有界，绝不无界增长
```

### 6.3 可靠性参数（默认值，可配）

| 参数 | 默认 | 说明 |
|---|---|---|
| 合并窗口 | 3000 ms | 普通节点；high 优先通道为 0 |
| 请求超时 | 8000 ms | |
| 重试次数 | 5 | 退避 1s/2s/4s/8s/16s，±20% 抖动 |
| 单请求上限 | 1 MB | 参考同生态 `maxRequestBytes` 量级 |
| outbox 容量 | 500 条 / 4 MB | 超限丢最旧并计数 |
| 优雅关闭 | 5000 ms | 参考 `shutdownTimeoutMillis` 语义 |

---

## 7. 配置模型

```yaml
# cordis.patch.yml 中的入口配置（节选）
enabled: true
endpoint: https://progress.example.com
secretRef: progress-webhook          # → credentials 服务，不落明文
milestones:
  goal: true
  deliverable: true
  plan: true
  blocked: true
  phase: true
  report: true
  turn: false                        # 默认关，噪音大
  session: false
report:
  inline: true                       # false 时只发 artifacts 引用
  maxBytes: 262144
  sources: [present, assistant-message, synthesized]
  includeCwd: false
coalesceWindowMs: 3000
timeoutMs: 8000
retry: { attempts: 5, baseMs: 1000, maxMs: 60000 }
outbox: { maxEntries: 500, maxBytes: 4194304 }
```

- 端点与开关走 `settings` / `settingsController`，提供设置页可改（无需改 YAML）。
- 密钥走 `credentials`（`credentialsController` 支持界面录入）。
- 安装：profile `C:\Users\YH\.dsh\profiles\web\` 的 `package.json` deps + `cordis.patch.yml` insert 入口；或 `plugin_manager install_bundle`。

---

## 8. 失败与可观测性

| 能力 | 实现 |
|---|---|
| 最近一次成功/失败时间 | 内存计数 + 日志 |
| 队列深度、丢弃数、park 数 | 状态快照 |
| 载荷本地预览（外部服务未就绪时联调） | 可选 `GET /dsh-progress/last`（经 `webServer.register`，需鉴权） |
| 连接自检 | 可选调用对端 `/health` |
| 永久失败归档 | 落盘（`storageDomain`），带 deliveryId 便于人工补投 |

> 注意：`webServer` 路由需要接入 `connection` 的鉴权机制（`authenticatedUrl` 等），不能裸暴露 —— 预览路由默认只绑本机并需令牌。

---

## 9. 安全与隐私（按已确认边界）

**会发出**：任务状态（目标/待办/计数）、里程碑元数据、交付物路径与描述、变更计数与路径样例、**md 报告正文**、可选 cwd。

**绝不发出**：工具参数原文、文件 diff 正文、系统提示词、reasoning 文本、用户消息原文、凭据。

**额外的收敛措施**：
- 报告正文是唯一内容类字段，`report.inline` 可整体关闭（改为引用拉取）。
- 路径默认相对化；`includeCwd: false` 默认不暴露绝对路径。
- 请求 HMAC 签名；密钥只存 `credentials`。
- 出站请求固定超时 + 上限大小，避免对端拖垮宿主。

**必须点明的信任边界**：插件运行在 DSH 宿主 Node 进程内，**其网络访问不受审批门控**（文件沙箱管的是工具子进程与 fs 访问，不覆盖插件网络）。装了这个插件等于授予它把上述数据发往 `endpoint` 的能力。因此代码应保持精简、无 `eval`、依赖锁定，且端点变更应在设置页可见。

---

## 10. 分期实施与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 契约冻结** | 本文档 §4/§5 与外部服务对齐 | 双方确认字段与响应语义 |
| **P1 骨架** | `goal` + `deliverable` 两类里程碑、inline 报告、内存队列、重试；YAML 配置 | 触发一次 goal complete → 对端 3s 内收到含 md 正文的记录 |
| **P2 可靠性** | outbox 持久化、合并窗口、优先通道、签名、凭据 | 对端停机 5 分钟后恢复 → 期间里程碑按序补发且无重复 |
| **P3 观测与配置** | status/preview 路由、设置页 | 设置页改端点即时生效；预览路由可看到最近载荷 |
| **P4 扩展** | `plan`/`turn`/`phase`、artifact 外链模式、批量补发 | 可选 |

**贯穿性验收标准**：
1. `session/event` 监听器内无任何网络 await（回调耗时 < 1 ms，代码审查通过）。
2. 报告超 256 KB → 截断且 `truncated: true`，发送不中断。
3. 卸载/HMR 后无监听器泄漏；未发送内容已冲刷或落盘。
4. 队列满 → 丢最旧且计数可见，宿主内存不无界增长。

---

## 11. 需要与外部服务对齐的开放问题

1. **鉴权方式**：HMAC（本文提案）还是 Bearer/API Key？
2. **状态模型**：只收事件流，还是需要「会话/任务当前状态」的快照资源（如 `PUT /sessions/{id}/state`）？建议至少支持快照，看板才好渲染。
3. **报告正文**：inline 传输（简单，受大小限制）还是引用拉取 `GET /artifacts/{id}`（需插件开受鉴权路由）？
4. **幂等语义**：确认 `X-DSH-Delivery` 可作为唯一去重键，重复请求返回 409。
5. **多项目路由**：projectKey 放 URL 路径、查询参数还是 body？
6. **时间格式**：确认使用 epoch ms UTC。
7. **保留策略**：报告正文与事件流各保留多久（影响是否需要引用模式）。

---

## 12. 环境前置条件（实测阻塞项）

- `pwsh` 工具当前无法启动：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\dshplugin\databoard)`。文件工具正常，但**构建与测试流程受限**，P1 开工前需解决（或确认以「文件工具 + `plugin_manager install_bundle`」替代命令执行）。
- 工作区 `D:\dshplugin\databoard` 原为空目录，插件包建议就落在这里。
- asar 内的 DSH 源码用文件工具不可读（`Cannot mix BigInt and other types`）；开发依据为 `cordis_inspect_*` 的运行时契约 —— 已确认足够完整（本设计的所有字段均有契约支撑）。
