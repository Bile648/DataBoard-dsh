# DSH 插件：把开发进度通过 POST 同步到外部配套服务

> 可行性分析（基于本机 `web` profile 的实测勘察，非推测）

## 1. 结论

**可行，而且是 DSH 插件体系里的"顺路"能力，不是硬骨头。**

- 进度事件面**已经存在且很完整**（宿主侧 70+ 事件，含 turn/step、工具调用、子代理、workflow、goal）。
- 出站 HTTP 对宿主插件**没有额外门槛**：插件跑在 Node 宿主进程里，DSH 自身就在做出站请求（LLM、`dsh-web-fetch-http`、OTLP 遥测、pnpm 安装）。
- 官方**已经有一条出站遥测管线**（`sessionTelemetry` + `dsh-otel` + `dsh-session-telemetry-otel`），其中 `exporter` 是开放字段 —— 意味着"零代码直连自建 collector"也走得通。

真正的难点不在"能不能发 POST"，而在**上报什么语义、怎么保证不丢不重不乱序、以及隐私边界**。

## 2. 实测到的能力（证据）

### 2.1 进度事件（`Event` provider，host）

| 事件 | 模式 | 对"进度同步"的价值 |
|---|---|---|
| `session/event` | emit（提交后 fire-and-forget） | **主力钩子**。载荷是 `SessionEvent`，含 `turn/start`、`turn/end`（带结束原因）、`step/start`、`tool/call`（工具名+参数）、`tool/result`（含错误与 meta）、`assistant/message`（含 usage）、`user/message` |
| `tools/result` | emit | 每次工具执行的最终结果（已冻结、无损 JSON） |
| `tools/pre-execute` / `post-execute` | waterfall | 可以**拦截/改写/放行**（若要做"上报前脱敏"或"危险操作告警"） |
| `agent/status`、`agent/error` | emit | 运行/空闲切换、步骤或轮次报错 |
| `subagent/start` / `subagent/end` | emit | 子代理树进度 |
| `workflow/start`、`/phase`、`/log`、`/agent-start`、`/agent-end`、`/end` | emit | workflow 的天然"阶段"语义 |
| `goal/changed`、`goal/activation-changed` | emit | 目标/里程碑状态，最接近"开发进度"语义 |
| `session/flush` | parallel（**会被 await**） | 可靠的检查点：适合做"必须送达"的冲刷 |
| `session/created` / `session/disposed` | emit | 会话生命周期 |

### 2.2 可用的宿主服务（`Service` provider，host）

- `tools.register` / `systemPrompt.tools` —— 注册模型可调用的工具（显式上报方案的基础）。
- `timer`（`throttle` / `debounce` / `interval`）—— 批量合并上报，避免每个事件一次 POST。
- `storageDomain` —— 持久化**发件箱（outbox）**，解决宿主重启/对端宕机丢数据。
- `credentials` —— 令牌安全存储（不要写进 YAML 明文）。
- `settings` / `settingsController` / `configEditor` —— 配置项与设置页面的正规路径。
- `workspaceChanges.summary(sessionId, seq)` / `diff(...)` —— 按序号取**文件级变更摘要**，是比原始事件安全得多的"进度"素材。
- `webServer.register(route)` —— 插件也能开入站路由（做回调/健康检查）。
- `webhookRuntime` —— 入站 webhook 规则运行时（本需求用不上，但说明生态里有先例）。
- `tokenMeter`、`goals`、`sessionTelemetry`。

### 2.3 已有的出站遥测管线（重要先例）

- 服务契约：`sessionTelemetry.emit(record)`，`record = { channel: 'ledger'|'ops', severity, attributes, body, sourceEvent? }`，并有 `sharing: 'full' | 'feedback-only' | 'disabled'`。
- 瀑布钩子：`session-telemetry/record` —— 可以在记录**到达后端之前**改写/旁路。
- 已启用组件：`@deepseek-ai/dsh-otel`、`@deepseek-ai/dsh-session-telemetry-otel`。
- `dsh-session-telemetry-otel` 的配置 schema 里 `exporter` 是**开放字段**（`{}`），另有 `mode`、`processor`、`maxRequestBytes`（≤4,000,000）、`shutdownTimeoutMillis`。

**含义**：如果外部服务能吃 OTLP/HTTP，仅仅改配置就可能打通链路。但这条管线的语义是"产品遥测"（ledger/ops 通道、默认 FEEDBACK_ONLY），不是"开发进度"，长期看语义不匹配。

### 2.4 插件怎么装进这个 profile

```
C:\Users\YH\.dsh\profiles\web\
├─ package.json        # dsh.profile.bundles = [dsh-base, dsh-web-app]
├─ cordis.yml          # 空入口列表（不要改）
└─ cordis.patch.yml    # 用户补丁层：id 定向覆盖 / 禁用 / insert 列表，允许 !!js 表达式
```

第三方插件 = npm 包（或 `file:` 链接到本地开发目录）+ 在 `cordis.patch.yml` 里加一条 insert 入口；也可走 `plugin_manager install_bundle`（pnpm 安装，构建脚本需显式批准）。`hmr` 服务在位，本地开发可热重载。

## 3. 三种方案

### 方案 A：事件驱动宿主插件（推荐做主干）

订阅 `session/event` + `tools/result` + `agent/status` + `subagent/*` + `goal/changed`，投影成紧凑的进度增量，进队列 → 按 1–5 秒合并 → 带签名 POST 到外部服务。

- ✅ 及时（亚秒~秒级）、**不依赖模型记得上报**、零 token 成本。
- ⚠️ 天然只能反映"机械进度"（跑了什么工具、改了哪些文件），"语义进度"（这步意味着什么）需要投影规则补。

### 方案 B：模型显式上报工具（`progress_report`）

新增一个工具，由我在里程碑处主动调用，可携带意图、阻塞点、下一步、完成度。

- ✅ 语义最准，适合做看板上的人类可读条目。
- ⚠️ 依赖模型纪律（会漏报）、消耗步骤与 token、及时性取决于我何时想起来调。

### 方案 C：OTel 配置直连（零代码，先做连通性验证）

把 `session-telemetry-otel` 的 `exporter` 指向外部服务的 OTLP 端点。

- ✅ 今天就能验证"外部服务能不能收到 DSH 的 POST"。
- ⚠️ 载荷是产品遥测记录，不是进度模型；默认共享模式偏保守。

**建议组合**：C 做连通性冒烟 → A 做主干 → B 做语义叠加。三者共用同一个传输内核（队列 + 重试 + 签名 + 配置）。

## 4. 主要风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| 隐私 / 数据量 | 原始 `session/event` 含完整提示词、工具参数、文件内容 | 默认只上报保守投影（turn/step、工具名、文件路径、状态、goal），深度内容 opt-in；`post-execute` 做脱敏 |
| 顺序与幂等 | 并发 POST 会乱序、重试会重复 | 载荷带 `{sessionId, seq, ts, counter}`，按会话串行 + 幂等键去重 |
| 阻塞主循环 | 在 `session/event` 里 `await` 网络会拖慢代理 | 监听器只入队，绝不 await 网络；`timer.throttle` 合并；有界队列 + 丢弃计数 |
| 对端宕机 / 重启 | 内存队列会丢 | `storageDomain` 持久化发件箱，启动重放；`session/flush` 作为检查点；dispose 时冲刷 |
| 密钥暴露 | 令牌写明文配置 | 用 `credentials` 服务；端点用 `settings` 以便界面可改 |
| 生命周期 | 卸载/HMR 后监听器泄漏 | 全部经 `ctx.effect`/disposer 注册 |
| 信任边界 | 插件跑在宿主进程，**网络访问不受审批门控**（文件沙箱管的是工具子进程/fs，不是插件网络） | 代码保持小、无 `eval`、依赖锁定、请求签名；若需门控只能插件自建 |

## 5. 工期粗估

- **MVP**（`session/event` → 投影 → POST，YAML 配置，无 UI、无 outbox）：一个包、几百行，**当天可跑通**。
- **可用版**（+ outbox 重放、限流合并、签名、凭据、错误可见性）：主要工作量。
- **完善版**（+ 设置页 UI、投影规则可配、按项目/会话路由、看板侧约定）：视外部服务接口而定。

## 6. 动手前需要你定的四件事

1. 外部服务的接口形态：自建 REST / OTLP / IM 机器人（钉钉、飞书、Slack）/ 自建看板？
2. 上报粒度：只要里程碑，还是每次工具调用与每轮 turn 都报？
3. 隐私边界：允许上报文件路径吗？允许上报代码内容或工具参数吗？
4. 交互形态：全自动（方案 A），还是加一个我主动调用的上报工具（方案 B）？

## 7. 本机环境注意事项（实测）

- `pwsh` 工具目前**无法启动**：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\dshplugin\databoard)` —— 沙箱给工作区授写权限被拒。命令执行需要先解决，否则插件的构建/测试只能靠文件工具 + profile 安装流程。
- 工作区 `D:\dshplugin\databoard` 此前为空目录。
- asar 内的 DSH 源码用文件工具读不了（`Cannot mix BigInt and other types`），只能靠 `cordis_inspect_*` 提供的运行时契约做开发依据 —— 好在契约足够完整。
