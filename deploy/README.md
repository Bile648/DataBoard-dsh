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
│  SQLite → /data/progress.db（命名卷，随容器重建保留）               │
└───────────────────────────────────────────────────────────────────┘
```

> 本页命令已在本机 Docker 上逐步实测通过。唯一未实测的是 §7 的 HTTPS 路径 ——
> 它需要真实域名与公网 80/443。

## 0. 前置条件

- Linux 服务器，装好 Docker 与 Docker Compose v2（`docker compose version` 能跑）
- 服务器能访问 Docker Hub 与 PyPI、npm（构建阶段要拉依赖）
- （启用 HTTPS 时）一个解析到本机 IP 的域名，且 80/443 可从公网访问

## 1. 把代码放到服务器

```bash
git clone <你的仓库地址> databoard
cd databoard
```

没有 git 也可以打包上传（`.dockerignore` 已排除 node_modules 等无关目录）：

```bash
# 开发机上
tar --exclude=.git --exclude=node_modules -czf databoard.tar.gz databoard/
scp databoard.tar.gz user@server:/opt/
# 服务器上
cd /opt && tar -xzf databoard.tar.gz && cd databoard
```

## 2. 配置环境变量

```bash
cp .env.example .env
vi .env
```

大多数情况**不用改**：

- `DSH_PROGRESS_INGEST_TOKEN` 留空 → 首次启动自动生成，之后在界面查看/轮换（推荐）
- `DSH_PROGRESS_SECRET` 留空 → 不启用 HMAC 兼容层。**仅当你有尚未更新、
  只发 HMAC 签名的旧插件**时才需要填，等插件全部切换后再清空
- `DSH_PROGRESS_SECURE_COOKIE` → 走 HTTPS 时改成 `1`（§7 的叠加层会自动设置）

## 3. 构建并启动

```bash
docker compose up -d --build

docker compose ps            # 应看到 Up (healthy)
docker compose logs -f       # 看日志，Ctrl+C 退出（不会停容器）
```

首次构建约 1–3 分钟（拉基础镜像 + 装 npm/pip 依赖），之后有缓存会快很多。

**默认只监听 `127.0.0.1:8787`**。这是刻意的安全默认：登录 Cookie 不该在明文 HTTP 上裸奔。
没有反向代理又要直接访问的话，把 `docker-compose.yml` 里的端口改成 `"8787:8787"` —— 仅限内网。

## 4. 创建管理员

**Web 端注册是关闭的**，账号只能在服务器上建：

```bash
docker compose exec dsh-progress dsh-progress create-user admin --admin --generate-password
```

会打印一次随机强密码，**只显示这一次**，请立即保存：

```
✓ 已创建 管理员 admin（id=1）

  初始密码：RdomVwXy5dEmaz$K1yPl

  请立即保存并尽快登录修改。
```

其他方式：

```bash
# 自己指定密码（注意会留在 shell 历史里）
docker compose exec dsh-progress dsh-progress create-user alice --password 'xxx'

# 有真实终端时也可以交互式输入
docker compose exec dsh-progress dsh-progress create-user alice
```

> ⚠️ 在**非交互环境**（`docker compose exec -T`、CI 脚本）里不指定密码会直接报错退出，
> 而不是静默失败 —— 这是刻意的，避免「命令跑完了但账号没建成」。
> 第一个账号会自动成为管理员，否则没人能再建号。

## 5. 验证部署

```bash
# 健康检查（不含业务数据）
curl -s http://127.0.0.1:8787/healthz

# 登录拿会话
curl -s -c /tmp/c.txt -X POST http://127.0.0.1:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<刚才的密码>"}'

# 带会话读统计
curl -s -b /tmp/c.txt http://127.0.0.1:8787/api/health
```

浏览器打开 `http://<服务器>:8787`（或你的域名）应看到登录页。

## 6. 接入 DSH 插件

1. 登录看板 →「**设置与管理**」→ 复制**摄入令牌**与**插件配置片段**
   （命令行等价：`docker compose exec dsh-progress dsh-progress show-token --snippet`）
2. 在**跑 DSH 的那台机器**上，把片段追加到 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，
   并把 `name` 改成插件入口文件的绝对路径：

```yaml
- insert:
    - id: progress-sync
      name: "/absolute/path/to/plugin/src/index.js"
      config:
        endpoint: https://progress.example.com
        token: dshi_xxxxxxxx
```

3. 保存即生效（启用 `dsh-hmr` 时热重载）。

> **顺序提醒（迁移场景）**：如果你是在替换一个已有服务，务必**先给插件配上令牌**，
> 再让服务端只认令牌。否则旧插件会拿到 401 —— 401 被归类为**永久失败**，插件不会重试，
> 那些里程碑会进 `parked` 队列需要手工处理。全新部署不存在这个问题。

## 7. 启用 HTTPS（推荐）

```bash
# .env 里加两行
echo 'DSH_DOMAIN=progress.example.com' >> .env
echo 'DSH_PROGRESS_SECURE_COOKIE=1' >> .env

docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

Caddy 会自动申请并续期 Let's Encrypt 证书，并且只经 443 对外。

## 8. 数据与备份

所有状态都在一个 SQLite 文件里：`/data/progress.db`（命名卷）。

```bash
# 在线一致备份（不需要停服）
docker compose exec dsh-progress dsh-progress backup /data/backup-$(date +%F).db

# 取到宿主机
docker compose cp dsh-progress:/data/backup-$(date +%F).db ./progress-backup.db
```

`backup` 用的是 SQLite 的 `VACUUM INTO`。**不要直接 `cp progress.db`** ——
写入过程中复制可能拿到不一致的快照。目标文件已存在时命令会拒绝，避免静默覆盖。

恢复：

```bash
docker compose down
docker run --rm -v databoard_dsh-progress-data:/data -v "$PWD":/backup alpine \
  cp /backup/progress-backup.db /data/progress.db
docker compose up -d
```

（卷名以 `docker volume ls` 为准，通常是 `<目录名>_dsh-progress-data`。）

## 9. 升级

```bash
git pull
docker compose up -d --build
```

数据在命名卷里，重建容器不丢。建议给镜像打版本标签以便回滚：

```bash
docker build -t dsh-progress:1.0.1 .
docker compose down
docker tag dsh-progress:1.0.1 dsh-progress:latest
docker compose up -d
```

## 10. 运维手册

```bash
docker compose exec dsh-progress dsh-progress list-users          # 账号列表
docker compose exec dsh-progress dsh-progress create-user alice --generate-password
docker compose exec dsh-progress dsh-progress set-password alice --generate-password
docker compose exec dsh-progress dsh-progress delete-user alice
docker compose exec dsh-progress dsh-progress show-token --snippet
docker compose exec dsh-progress dsh-progress rotate-token        # 旧令牌立即失效
docker compose exec dsh-progress dsh-progress info                # 部署概况
docker compose exec dsh-progress dsh-progress backup /data/b.db
docker compose exec dsh-progress dsh-progress clear-milestones    # 需输入 yes 确认
docker compose logs -f --tail=100
```

界面上也能做同样的事：**设置与管理** 页支持建号、重置密码、轮换令牌、清空里程碑。

> 摄入令牌若由 `DSH_PROGRESS_INGEST_TOKEN` 固定，界面上的轮换按钮会被禁用 ——
> 这是刻意的，避免界面操作与环境变量各说各话。

## 11. 排障

| 现象 | 原因与处理 |
|---|---|
| `docker compose up` 报端口占用 | 8787 被占；改端口映射或先停掉占用进程 |
| 页面显示「前端资源缺失」 | 构建阶段前端失败；`docker compose build --no-cache` 看前端阶段输出 |
| 登录成功又立刻跳回登录页 | `DSH_PROGRESS_SECURE_COOKIE=1` 但你在用 HTTP 访问；改 `0` 或启用 HTTPS |
| 插件上报 401 | 令牌不匹配。复制最新令牌；若轮换过，插件配置要同步更新 |
| 插件上报超时 | 防火墙未放行，或 `endpoint` 写成了容器内网地址 |
| 忘记管理员密码 | `dsh-progress set-password <用户名> --generate-password` |
| 删不掉最后一个管理员 | 系统刻意拒绝；先另建一个管理员 |
| 容器一直 `starting` | `docker compose logs` 看启动异常；健康检查有 5 秒宽限期 |
