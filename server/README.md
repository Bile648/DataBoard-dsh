# Python 后端（雏形）

接收 DSH 进度同步插件 POST 的里程碑，做验签、幂等去重、落盘与状态折叠，并向前端提供查询接口。

零额外依赖 —— 只用已安装的 Flask（`requirements.txt` 里只列了 Flask）。

## 运行

```powershell
cd server
python app.py
# → http://127.0.0.1:8787
```

带签名校验：

```powershell
$env:DSH_PROGRESS_SECRET = 'dev-secret-123'
python app.py
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 服务自述与端点清单 |
| GET | `/dsh/progress/v1/health` | 健康检查（插件「测试连接」用） |
| POST | `/dsh/progress/v1/milestones` | 接收一条里程碑 |
| POST | `/dsh/progress/v1/milestones:batch` | 批量接收（补发用） |
| GET | `/dsh/progress/v1/milestones?limit=&sessionId=&kind=` | 时间线，按**事件时间**倒序 |
| GET | `/dsh/progress/v1/sessions` | 各会话的当前状态快照 |
| GET | `/dsh/progress/v1/state?sessionId=` | 单个会话状态 |

## 响应语义

| 响应 | 含义 | 插件行为 |
|---|---|---|
| `202` | 已接收 | 出队 |
| `409` | `deliveryId` 重复 | **视同成功**，出队 |
| `401` | 签名缺失/错误/超出时间窗 | 永久失败，不重试 |
| `422` | 必填字段缺失 | 永久失败，不重试 |
| `5xx` / 超时/网络错误 | 暂时失败 | 指数退避重试 |

## 存储

- `server/data/milestones.jsonl`：每条里程碑一行 JSON（含原始信封 + 接收元数据），进程重启自动恢复。
- 状态折叠：内存里按会话维护 `goal / todos / counts / latestReport / milestoneCount` 等快照字段。
- 幂等：`deliveryId` 集合去重，重启后由 JSONL 重建。

> `server/data/` 已在 `.gitignore` 中，运行数据不会进版本库。
