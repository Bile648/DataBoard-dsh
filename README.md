# DSH 开发进度同步（雏形）

把 DSH 的开发进度**大节点**（任务状态 + 给开发者读的 markdown 报告）通过 HTTP POST 同步到外部配套服务，
并在一个独立看板上展示。三部分都在本仓库里，已打通端到端链路。

```
┌──────────────────────┐   POST /dsh/progress/v1/milestones   ┌────────────────────┐
│  DSH 宿主插件         │   HMAC-SHA256 签名 + 幂等键            │  Python 后端        │
│  plugin/             │ ───────────────────────────────────▶ │  server/ (Flask)   │
│                      │                                      │                    │
│  事件 → 投影 → 合并 → │                                      │  验签 → 去重 →      │
│  发件箱 → 传输        │ ◀───── 409=重复 / 5xx=退避重试 ────── │  落盘 + 状态折叠    │
└──────────────────────┘                                      └─────────┬──────────┘
                                                                        │ GET /milestones
                                                                        │ GET /sessions
                                                                        ▼
                                                              ┌────────────────────┐
                                                              │  React + TS 看板    │
                                                              │  web/ (Vite)       │
                                                              └────────────────────┘
```

设计文档（字段来源、接口契约、风险对策）：[docs/progress-sync-design.md](docs/progress-sync-design.md)
可行性分析：[docs/progress-sync-feasibility.md](docs/progress-sync-feasibility.md)

## 目录结构

```
databoard/
├─ plugin/                 DSH 宿主插件（纯 ESM，无需构建）
│  ├─ src/
│  │  ├─ index.js          插件入口：注册监听（cordis 形态）
│  │  ├─ projector.js      事件 → 里程碑（纯函数）
│  │  ├─ coalescer.js      合并窗口 + 高优先通道 + 去重
│  │  ├─ outbox.js         有界队列 + 重试状态机 + 落盘
│  │  ├─ transport.js      单次 POST + 响应语义分类 + 退避
│  │  ├─ reporter.js       md 报告装配（三级来源 + 截断）
│  │  ├─ signing.js        HMAC-SHA256 签名
│  │  └─ config.js         默认配置 + 深度合并
│  └─ tools/simulate.js    连通性模拟器（不依赖 DSH 即可跑通全链路）
├─ server/                 Python 后端（Flask，零额外依赖）
│  ├─ app.py               路由 / 验签 / 校验
│  └─ store.py             JSONL 落盘 + 幂等去重 + 状态折叠
└─ web/                    React + TypeScript 看板（Vite）
   └─ src/
      ├─ App.tsx           轮询与布局
      ├─ markdown.ts       无依赖的极简 markdown 渲染器
      └─ components/       StatusBar / TaskCard / Timeline / ReportView
```

## 快速开始

### 1. 启动后端

```powershell
cd server
$env:DSH_PROGRESS_SECRET = 'dev-secret-123'   # 可选；不设则关闭签名校验
python app.py                                   # → http://127.0.0.1:8787
```

### 2. 跑连通性模拟器（验证 插件 → 后端）

```powershell
cd ..                                           # 回到仓库根目录
node plugin/tools/simulate.js --secret dev-secret-123
```

模拟器把合成事件喂给**真实的**投影器 / 合并器 / 发件箱 / 传输层，覆盖 4 个场景共 20 项断言：

| 场景 | 验证内容 |
|---|---|
| happy | 6 条里程碑全部投递成功；四类节点齐备；交付物带 md 报告正文；目标完成节点为高优先 |
| duplicate | 同一 `deliveryId` 重投返回 409，且不重复入库 |
| auth | 错误密钥 / 缺失签名均返回 401，且被归类为永久失败（不重试） |
| offline | 对端不可达时不丢数据、进入退避、不崩溃 |

### 3. 启动前端看板

```powershell
cd web
npm install
npm run dev                                     # → http://127.0.0.1:5273
```

### 4. 前端渲染验证（不需要浏览器）

```powershell
cd web
npm run render-check                            # 拉真实后端数据 → 真实组件 → HTML，20 项断言
```

这一层比「构建通过」更重要：它证明后端数据能被真实组件渲染出来（构建通过不代表运行时不炸），
并对 markdown 渲染器单独做了能力验证（表格、任务列表、代码块、引用、HTML 注入转义）。

## 里程碑模型

只报大节点（默认开关注释见 `plugin/src/config.js` 的 `milestones`）：

| kind | 触发源 | 默认 |
|---|---|---|
| `goal` | `goal/changed`（任务状态权威来源） | ✅ |
| `deliverable` | `present` 工具调用 | ✅ |
| `report` | `write`/`edit` 目标是 `.md` | ✅ |
| `plan` | `todo_write` 的完整待办快照 | ✅ |
| `blocked` | `agent/error`、回合异常结束 | ✅ 高优先 |
| `phase` | `workflow/phase` | ✅ |
| `turn` | `turn/end` + `workspace/changes` | ❌ 默认关 |
| `session` | 会话生命周期 | ❌ 默认关 |

**去噪**：普通节点 3 秒合并窗口；`blocked` 与 `goal completed` 走高优先通道立即发送，
且在放行前会先冲刷**同键**的待发条目 —— 否则服务端按到达顺序折叠状态会回退（这是实测踩到并修掉的缺陷）。

## 报告的三级来源

1. **交付物正文** —— `present` 声明的 `.md` 文件，从磁盘读取（DSH 内优先走 `ctx.fs`，遵守沙箱策略）
2. **助手收尾消息** —— 该回合最后一条 `assistant/message` 的文本
3. **自动摘要** —— 由目标 + 待办 + 变更概览拼装，保证任何情况下都有可读正文

超过 256 KB 按 UTF-8 边界安全截断，置 `truncated: true`，并保留 `artifacts` 供人工获取完整文件。

## 环境变量

| 变量 | 作用域 | 默认 |
|---|---|---|
| `DSH_PROGRESS_HOST` / `DSH_PROGRESS_PORT` | 后端 | `127.0.0.1` / `8787` |
| `DSH_PROGRESS_SECRET` | 后端 + 插件 | 空（关闭签名校验） |
| `DSH_PROGRESS_MAX_SKEW` | 后端 | `300` 秒 |
| `DSH_PROGRESS_DATA` | 后端 | `server/data` |
| `DSH_PROGRESS_ENDPOINT` | 插件 | `http://127.0.0.1:8787` |
| `VITE_API_BASE` | 前端 | `http://127.0.0.1:8787` |

## 装进 DSH profile（可选，会让插件真正在 DSH 内运行）

插件是纯 ESM，无需构建。把它作为依赖链到当前 profile 并加一条 loader 入口：

```yaml
# C:\Users\YH\.dsh\profiles\web\cordis.patch.yml
- id: progress-sync
  module: dsh-plugin-progress-sync     # 或在 profile/package.json 里用 file: 链接本仓库的 plugin/
  config:
    endpoint: http://127.0.0.1:8787
    secret: dev-secret-123
```

> ⚠️ 这一步会改动正在运行的 profile（影响所有会话），建议确认后再做。
> 插件代码运行在宿主 Node 进程内，其网络访问**不受**审批门控 —— 装上即等于授权它把进度发往 `endpoint`。

## 当前状态

- ✅ 后端、插件、前端三者独立可跑，端到端链路已用模拟器验证（20/20）
- ✅ 幂等、签名、退避重试、有界队列、状态折叠均有断言覆盖
- ⏳ 尚未接入真实 DSH 运行时（`plugin/src/index.js` 的监听注册是唯一需要真机校验的部分）
- ⏳ 报告的 `present` 一级来源依赖真实文件路径；模拟器中已用本仓库的设计文档验证通过
