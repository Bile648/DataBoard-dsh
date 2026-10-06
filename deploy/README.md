# 部署指南（Linux + Docker）

交付形态：**一个容器镜像**。前端已被构建并打进镜像，后端用 gunicorn 同时提供
接口与静态页面 —— 对外只有一个端口，没有第二个进程要管。

```
┌──────────────────────── 容器 dsh-progress ────────────────────────┐
│  gunicorn (1 worker × 8 threads)                                  │
│    ├─ /                    构建后的 React 单页应用（静态资源）      │
│    ├─ /api/*               看板接口（登录 Cookie 鉴权）            │
│    ├─ /dsh/progress/v1/*   插件摄入（Bearer 摄入令牌）             │
│    └─ /healthz             容器健康检查                            │
│  SQLite → /data/progress.db（挂在命名卷上，随容器重建保留）         │
└───────────────────────────────────────────────────────────────────┘
```

## 1. 前置条件

- Linux 服务器，已装 Docker 与 Docker Compose v2
- （启用 HTTPS 时）一个解析到本机的域名，且 80/443 可公网访问

## 2. 部署

```bash
# 把仓库放到服务器上（git clone、scp 或镜像离线传输均可）
cd databoard

# 构建并启动
docker compose up -d --build

# 看日志
docker compose logs -f
```

默认只监听 `127.0.0.1:8787`（安全默认）。若暂时没有反向代理、需要直接访问，
把 `docker-compose.yml` 里的端口改成 `"8787:8787"` —— 但那是明文 HTTP，仅限内网。

### 创建第一个账号

**注册在 Web 端是关闭的**，账号只能在服务器上用命令行创建：

```bash
docker compose exec dsh-progress dsh-progress create-user admin --admin
# 会交互式提示输入密码（至少 8 位）
```

> 第一个账号会自动成为管理员，之后的管理员只能在「设置与管理」页或命令行里添加。

然后浏览器打开 `http://<服务器>:8787`（或你的域名）登录。

### 接入 DSH 插件

1. 登录后进入「**设置与管理**」页，复制**摄入令牌**和**插件配置片段**。
2. 把片段追加到本机 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，
   并把 `name` 改成插件入口文件的绝对路径：

```yaml
- insert:
    - id: progress-sync
      name: "/absolute/path/to/plugin/src/index.js"
      config:
        endpoint: https://progress.example.com
        token: dshi_xxxxxxxx
```

3. 保存即生效（启用 `dsh-hmr` 时热重载，否则重启 DSH）。

## 3. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_PROGRESS_HOST` | `0.0.0.0` | 监听地址 |
| `DSH_PROGRESS_PORT` | `8787` | 监听端口 |
| `DSH_PROGRESS_DATA` | `/data` | 数据目录（挂卷） |
| `DSH_PROGRESS_DB` | `$DATA/progress.db` | SQLite 路径 |
| `DSH_PROGRESS_INGEST_TOKEN` | 空 | 摄入令牌；留空则首启自动生成并持久化到库（推荐，便于界面轮换） |
| `DSH_PROGRESS_SECRET` | 空 | 可选 HMAC 密钥，与令牌并存，兼容不发送令牌的旧插件 |
| `DSH_PROGRESS_SESSION_TTL` | `604800` | 登录会话有效期（秒） |
| `DSH_PROGRESS_SECURE_COOKIE` | `0` | **走 HTTPS 时必须设为 `1`** |
| `DSH_PROGRESS_TRUST_PROXY` | `0` | 反向代理后面设为 `1` |
| `DSH_PROGRESS_LOG_LEVEL` | `INFO` | 日志级别 |

## 4. 启用 HTTPS（推荐）

```bash
DSH_DOMAIN=progress.example.com \
  docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

叠加层会：
- 起一个 Caddy，自动申请并续期 Let's Encrypt 证书
- 把 `DSH_PROGRESS_SECURE_COOKIE` 设为 `1`
- 只经 443 对外，应用端口仍留在回环

## 5. 数据与备份

所有状态都在一个 SQLite 文件里：`/data/progress.db`（命名卷 `dsh-progress-data`）。

```bash
# 在线备份（SQLite 官方推荐方式，不停服）
docker compose exec dsh-progress \
  python -c "import sqlite3;sqlite3.connect('/data/progress.db').execute(\"VACUUM INTO '/data/backup.db'\")"
docker compose cp dsh-progress:/data/backup.db ./progress-backup.db
```

直接 `cp progress.db` 在写入过程中可能拿到不一致的快照，**请用上面的方式**。

## 6. 升级与回滚

```bash
git pull
docker compose up -d --build      # 重建镜像并滚动重启
```

数据在命名卷里，重建容器不会丢。回滚建议用镜像标签：

```bash
docker build -t dsh-progress:1.0.1 .
docker tag dsh-progress:1.0.0 dsh-progress:rollback
```

## 7. 运维手册

```bash
# 列出账号
docker compose exec dsh-progress dsh-progress list-users

# 新建账号（普通用户）
docker compose exec dsh-progress dsh-progress create-user alice

# 改密码（会吊销该用户所有登录会话）
docker compose exec dsh-progress dsh-progress set-password alice

# 查看摄入令牌
docker compose exec dsh-progress dsh-progress show-token

# 轮换摄入令牌（旧令牌立即失效，记得同步更新插件配置）
docker compose exec dsh-progress dsh-progress rotate-token

# 部署概况
docker compose exec dsh-progress dsh-progress info
```

界面上也能做同样的事：**设置与管理** 页支持建号、重置密码、轮换令牌、清空里程碑。

> 摄入令牌若由 `DSH_PROGRESS_INGEST_TOKEN` 固定，则无法在界面轮换 —— 这是刻意的，
> 避免界面操作与环境变量产生分歧。

## 8. 排障

| 现象 | 排查方向 |
|---|---|
| 容器起不来，日志报端口占用 | 改 `docker-compose.yml` 的端口映射 |
| 打开页面显示「前端资源缺失」 | 镜像构建时前端阶段失败；看 `docker build` 输出 |
| 登录成功但立刻变回登录页 | `DSH_PROGRESS_SECURE_COOKIE=1` 但你在用 HTTP 访问 |
| 插件上报 401 | 令牌不匹配；在设置页复制最新令牌，或确认 `DSH_PROGRESS_SECRET` / 令牌配置 |
| 插件上报超时 | 服务器防火墙未放行；或 `endpoint` 写成了内网地址 |
| 忘记管理员密码 | `dsh-progress set-password <用户名>` |
| 最后一个管理员 | 系统会拒绝删除，需先另建一个管理员 |
