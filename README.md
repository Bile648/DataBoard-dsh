# DSH 开发进度同步

把 DSH 的开发进度**大节点**（任务状态 + 给开发者读的 markdown 报告）通过 HTTP POST 同步到自建服务，
用一个带账号体系的共享看板展示。三部分都在本仓库里，已打通端到端链路并验证容器化部署。

```
┌────────────────────┐  POST /dsh/progress/v1/milestones   ┌──────────────────────────────┐
│  DSH 宿主插件       │  Authorization: Bearer <摄入令牌>     │  dsh-progress 服务（单容器）   │
│  plugin/           │ ──────────────────────────────────▶ │  server/                     │
│  事件→投影→合并→    │                                     │   gunicorn + Flask           │
│  发件箱→传输        │ ◀──── 409=重复 / 5xx=退避重试 ────── │   ├─ /api/*   登录 Cookie     │
└────────────────────┘                                     │   ├─ /        构建后的前端    │
                                                           │   └─ SQLite（WAL）           │
┌────────────────────┐  GET /api/*（登录 Cookie）            │                              │
│  React 看板         │ ◀───────────────────────────────── │  账号 / 会话 / 摄入令牌        │
│  web/              │                                     └──────────────────────────────┘
└────────────────────┘
```

设计文档：[docs/progress-sync-design.md](docs/progress-sync-design.md) ·
可行性分析：[docs/progress-sync-feasibility.md](docs/progress-sync-feasibility.md) ·
实机挂载验证：[docs/mount-test-report.md](docs/mount-test-report.md) ·
**部署指南**：[deploy/README.md](deploy/README.md)

## 目录结构

```
databoard/
├─ plugin/                 DSH 宿主插件（纯 ESM，无需构建）
│  ├─ src/
│  │  ├─ index.js          插件入口：注册监听（cordis 形态）
│  │  ├─ projector.js      事件 → 里程碑（纯函数）
│  │  ├─ coalescer.js      合并窗口 + 高优先通道 + 去重
│  │  ├─ outbox.js         有界队列 + 重试状态机 + 落盘
│  │  ├─ transport.js      单次 POST + 鉴权头 + 响应语义分类
│  │  ├─ reporter.js       md 报告装配（三级来源 + 截断）
│  │  └─ config.js / signing.js
│  └─ tools/simulate.js    连通性模拟器（不依赖 DSH 即可跑通全链路）
├─ server/                 Python 后端（Flask + SQLite，可 pip 安装）
│  ├─ pyproject.toml       打包定义，console script: dsh-progress
│  └─ dsh_progress/
│     ├─ __init__.py       应用工厂 + SPA 托管
│     ├─ api.py            三组接口：认证 / 看板 / 摄入
│     ├─ auth.py           密码哈希、登录会话、摄入令牌
│     ├─ store.py          里程碑存储 + 状态折叠
│     ├─ db.py             SQLite 建表、迁移
│     ├─ cli.py            建号 / 改密 / 轮换令牌 / 诊断
│     └─ wsgi.py           生产 WSGI 入口
├─ web/                    React + TypeScript 看板（Vite）
│  ├─ src/
│  │  ├─ App.tsx           登录门禁 + 轮询 + 布局
│  │  ├─ components/       LoginPage / StatusBar / TaskCard / Timeline / ReportView / SettingsPanel
│  │  ├─ markdown.ts       无依赖的极简 markdown 渲染器
│  │  └─ api.ts            接口封装（同源相对路径）
│  └─ tools/render-check.tsx  渲染冒烟测试
├─ deploy/                 部署文档与 Caddy 配置
├─ tools/asar.mjs          按需读取 app.asar 内的 DSH 源码
├─ Dockerfile              多阶段：Node 构建前端 → Python 运行时
└─ docker-compose.yml      （+ docker-compose.tls.yml 可选 HTTPS 叠加）
```

## 本地开发

```bash
# 1) 后端（首次启动会自动建库；旧版 milestones.jsonl 会自动迁移）
cd server
pip install -e .
dsh-progress create-user admin --admin     # 注册已关闭，账号只能这样创建
python -m dsh_progress                     # → http://127.0.0.1:8787

# 2) 前端热更新（接口经 Vite 代理到后端，无跨域）
cd web
npm install
npm run dev                                # → http://127.0.0.1:5273
```

前端也可以构建后由后端直接托管（就是生产形态）：

```bash
cd web && npm run build      # 产物落到 ../server/static
# 之后只访问后端 8787 即可，不需要 Vite
```

## 部署到服务器

一条命令构建出镜像（前端已打进镜像，无第二个进程要管）：

```bash
docker compose up -d --build
docker compose exec dsh-progress dsh-progress create-user admin --admin
```

完整步骤（HTTPS、备份、升级、排障）见 **[deploy/README.md](deploy/README.md)**。

**安全默认**：容器端口只绑 `127.0.0.1`，对外一律走反向代理；启用 HTTPS 时叠加层会把
`DSH_PROGRESS_SECURE_COOKIE` 打开。

## 账号与鉴权

| 面向 | 凭据 | 说明 |
|---|---|---|
| 看板用户 | 登录会话 Cookie | 注册关闭，只能由管理员建号；scrypt 哈希；可服务端吊销 |
| DSH 插件 | 摄入令牌 `dshi_…` | `Authorization: Bearer`；界面可查看/轮换 |
| 旧版插件 | HMAC 签名 | 可选并存（`DSH_PROGRESS_SECRET`），便于平滑迁移 |

**共享看板**：登录只做门禁，不做数据隔离 —— 所有登录用户看到同一份进度（按部署需求确认）。
管理员另有账号管理、令牌轮换、清空数据的能力。

## 装进 DSH profile

在 profile 的 `cordis.patch.yml` 追加不带 `id` 的 `insert` 条目，**无需 npm 安装**：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- insert:
    - id: progress-sync
      name: "/absolute/path/to/plugin/src/index.js"   # 绝对路径 / file URL / 包标识符
      config:
        endpoint: https://progress.example.com
        token: dshi_xxxxxxxx
```

令牌与可直接粘贴的片段在「设置与管理」页复制。

### 热重载语义（实测）

| 改动 | 是否实时生效 |
|---|---|
| `cordis.patch.yml` 的 **config**（含令牌、开关、窗口） | ✅ 立即生效，无需重启 |
| 插件的**代码**（`plugin/src/*.js`） | ❌ 需重启 DSH —— Node 会缓存 ESM 模块 |

判定方法：在配置里把 `milestones.plan` 设为 `false`，再触发一次 `todo_write`，
若不再产生 `plan` 里程碑即说明配置已热更新。

### ⚠️ 改插件代码前必读

`dsh-app-boot` 的失败模式表明确规定：脱离 `apply()` 返回的 Promise 一旦产生**未处理 rejection**，
宿主要「释放应用并以非零码退出」。定时器、流监听里抛出的未捕获异常同样是致命错误。

因此插件的**所有**事件监听、定时器回调与出队逻辑都经 `safe()` 包裹（见 `plugin/src/index.js`），
异常一律降级为告警。修改时必须保持这个约束。

## 里程碑模型

只报大节点（开关见 `plugin/src/config.js` 的 `milestones`）：

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
且放行前会先冲刷**同键**的待发条目 —— 否则服务端按到达顺序折叠状态会回退。

## 报告的三级来源

1. **交付物正文** —— `present` 声明的 `.md` 文件，从磁盘读取（DSH 内优先走 `ctx.fs`）
2. **助手收尾消息** —— 该回合最后一条 `assistant/message` 的文本
3. **自动摘要** —— 由目标 + 待办 + 变更概览拼装，保证任何情况下都有可读正文

超过 256 KB 按 UTF-8 边界安全截断并置 `truncated: true`。
大节点会**继承会话最近一次的交付物**，避免「目标完成」这类节点因为自身没有产物而退化成助手短消息。

## 验证

| 验证 | 命令 | 覆盖 |
|---|---|---|
| 插件 → 后端全链路 | `node plugin/tools/simulate.js --token <令牌> --password <密码>` | 20 项断言：链路、幂等、鉴权、离线重试 |
| 前端渲染 | `cd web && npm run render-check -- --password <密码>` | 22 项断言：真实数据经真实组件渲染为 HTML + markdown 渲染器 |
| 容器镜像 | `docker compose up -d --build` | 健康检查、建号、登录、SPA、插件摄入 |

模拟器与渲染检查都需要真实凭据 —— 它们打的是实际接口，不是 mock。

## 环境变量（摘要）

| 变量 | 作用域 | 默认 |
|---|---|---|
| `DSH_PROGRESS_DATA` | 后端 | `./data`（容器内 `/data`） |
| `DSH_PROGRESS_INGEST_TOKEN` | 后端 | 空 → 首启自动生成 |
| `DSH_PROGRESS_SECRET` | 后端 + 插件 | 空（关闭 HMAC 兼容） |
| `DSH_PROGRESS_SECURE_COOKIE` | 后端 | `0`（HTTPS 部署设 `1`） |
| `DSH_PROGRESS_ENDPOINT` | 插件 | `http://127.0.0.1:8787` |
| `DSH_PROGRESS_TOKEN` | 插件 | 空 |

完整列表见 [deploy/README.md](deploy/README.md#3-环境变量)。
