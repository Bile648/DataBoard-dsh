# Python 后端（DSH 进度同步服务）

接收 DSH 插件上报的进度里程碑，做鉴权、幂等去重、落盘与状态折叠，并向看板提供查询接口。
同时托管构建后的前端静态资源 —— 对外只有一个进程、一个端口。

## 为什么用 SQLite

早期版本用 JSONL + 全量入内存。真服务器部署下这不可行：并发写会互相覆盖、
启动要读全量历史、无法按时间/会话建索引。现在所有状态都在一个 SQLite 文件里（WAL 模式），
旧版 `milestones.jsonl` 会在首次启动时自动迁移。

## 运行

开发：

```bash
python -m dsh_progress          # 或 dsh-progress serve
```

生产（Linux）：

```bash
gunicorn -w 1 -k gthread --threads 8 -b 0.0.0.0:8787 dsh_progress.wsgi:app
```

Windows 上用 `waitress-serve --port=8787 dsh_progress.wsgi:app`（gunicorn 不支持 Windows）。

> 单进程多线程是刻意的：SQLite 用 WAL，单进程可彻底避免多进程写锁竞争，而本服务写入量很低。

## 安装

```bash
pip install .            # 需要 Python ≥ 3.10
```

## 账号

**Web 端注册是关闭的**，账号只能由管理员在服务器上创建：

```bash
dsh-progress create-user admin --admin      # 交互式输入密码
dsh-progress list-users
dsh-progress set-password alice             # 会吊销该用户所有登录会话
dsh-progress delete-user alice
dsh-progress info                           # 部署与数据概况
```

第一个账号会自动成为管理员（否则没人能再建号）。密码用 scrypt 哈希，
登录态是数据库里的会话记录 + HttpOnly Cookie，可服务端吊销。

## 接口

### 看板接口（登录 Cookie）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 登录，下发会话 Cookie |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/auth/me` | 当前用户（未登录 401） |
| POST | `/api/auth/password` | 修改自己的密码 |
| GET | `/api/health` | 统计（里程碑/会话/账号数） |
| GET | `/api/milestones?limit=&sessionId=&kind=` | 时间线，按**事件时间**倒序 |
| GET | `/api/sessions` | 各会话的当前状态快照 |
| GET | `/api/state?sessionId=` | 单个会话状态 |
| GET | `/api/admin/ingest-token` | 摄入令牌 + 插件配置片段（管理员） |
| POST | `/api/admin/ingest-token/rotate` | 轮换令牌（管理员） |
| GET/POST | `/api/admin/users` | 账号列表 / 创建（管理员） |
| DELETE | `/api/admin/users/<用户名>` | 删除账号（管理员） |
| POST | `/api/admin/users/<用户名>/password` | 重置密码（管理员） |
| POST | `/api/admin/milestones/clear` | 清空里程碑（管理员） |

### 摄入接口（插件用）

| 方法 | 路径 | 鉴权 |
|---|---|---|
| POST | `/dsh/progress/v1/milestones` | `Authorization: Bearer <摄入令牌>`，或旧版 HMAC 签名 |
| POST | `/dsh/progress/v1/milestones:batch` | 同上 |
| GET | `/dsh/progress/v1/health` | 无（供插件「测试连接」） |
| GET | `/healthz` | 无（容器健康检查，不含业务数据） |

响应语义：`202` 已接收 · `409` 幂等重复（视同成功） · `401` 鉴权失败（永久失败，不重试） ·
`422` 必填字段缺失 · `5xx`/超时 → 插件指数退避重试。

## 环境变量

见 [deploy/README.md](../deploy/README.md#3-环境变量)。常用的几个：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_PROGRESS_DATA` | `./data` | 数据目录 |
| `DSH_PROGRESS_INGEST_TOKEN` | 空 | 摄入令牌；留空则首启自动生成并持久化 |
| `DSH_PROGRESS_SECRET` | 空 | 可选 HMAC 密钥（兼容旧插件） |
| `DSH_PROGRESS_SECURE_COOKIE` | `0` | **HTTPS 部署必须设 1** |
| `DSH_PROGRESS_SESSION_TTL` | `604800` | 登录会话有效期（秒） |

## 安全说明

- 看板接口全部需要登录；摄入接口需要令牌。**没有**任何匿名的业务数据读取口。
- 不再发送 CORS 头：前端与接口同源，跨域没有存在理由。
- 登录失败按 `来源IP + 用户名` 节流（15 分钟内 5 次后拒绝）。
- 响应统一带 `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy`。
- 容器内以非 root（uid 10001）运行。
