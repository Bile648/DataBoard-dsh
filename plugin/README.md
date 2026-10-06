# DSH 进度同步插件（雏形）

把开发进度**大节点**通过 HTTP POST 同步到外部配套服务。纯 ESM，无构建步骤，可直接被 DSH 的 cordis loader 加载。

## 模块

| 文件 | 职责 |
|---|---|
| `src/index.js` | 插件入口（cordis 形态）：注册监听、装配报告、驱动管线 |
| `src/projector.js` | **纯函数**：DSH 事件 / 契约对象 → 里程碑条目 |
| `src/coalescer.js` | 合并窗口 + 高优先通道 + 去重（顺序安全） |
| `src/outbox.js` | 有界队列 + 重试状态机 + 可选落盘 |
| `src/transport.js` | 单次 POST + 响应语义分类 + 退避计算 + 健康检查 |
| `src/reporter.js` | md 报告三级来源装配 + UTF-8 安全截断 |
| `src/signing.js` | HMAC-SHA256（与后端 `server/app.py` 逐字节一致） |
| `src/config.js` | 默认配置 + 深度合并 + 端点拼接 |

## 连通性模拟器

不依赖 DSH，直接把合成事件喂给真实管线：

```powershell
cd <仓库根目录>
node plugin/tools/simulate.js --secret dev-secret-123
node plugin/tools/simulate.js --verbose          # 打印每一步的投递日志
node plugin/tools/simulate.js --scenario happy   # 只跑某个场景
```

退出码 0 = 全部断言通过，1 = 有失败（可用于 CI）。

## 关键实现约束

1. **监听器内绝不做 I/O**：`session/event` 是 fire-and-forget 的 emit，回调只做「投影 + 入队」，
   报告装配（可能读磁盘）与网络发送都由 `setImmediate` 脱离事件回调执行。
2. **顺序安全**：高优先节点放行前先冲刷**同键**的待发条目，否则服务端按到达顺序折叠状态会回退。
3. **重试复用 deliveryId**：`deliveryId` 在信封组装时生成一次，重试期间保持不变，服务端据此幂等去重。
4. **有界**：队列满丢最旧并计数，绝不无界增长。

## 配置

```js
{
  enabled: true,
  endpoint: 'http://127.0.0.1:8787',
  secretRef: 'progress-webhook',      // 生产走 credentials 服务
  secret: '',                          // 联调可直接给
  milestones: { goal: true, deliverable: true, plan: true, blocked: true,
                phase: true, report: true, turn: false, session: false },
  report: { inline: true, maxBytes: 262144,
            sources: ['present', 'assistant-message', 'synthesized'],
            includeCwd: false },
  coalesceWindowMs: 3000,
  dedupeWindowMs: 30000,
  timeoutMs: 8000,
  retry: { attempts: 5, baseMs: 1000, maxMs: 60000, jitter: 0.2 },
  outbox: { maxEntries: 500, maxBytes: 4194304, persistPath: '' },
  previewUrl: 'http://127.0.0.1:19387',
}
```

## 接入 DSH profile

```yaml
# C:\Users\YH\.dsh\profiles\web\cordis.patch.yml
- id: progress-sync
  module: dsh-plugin-progress-sync
  config:
    endpoint: http://127.0.0.1:8787
    secret: dev-secret-123
```

`plugin/src/index.js` 导出的 `name` / `inject` / `apply` 即 cordis 插件契约；
监听的宿主事件为 `session/event`、`goal/changed`、`agent/error`、`workflow/phase`、`session/flush`、`session/created`。

> ⚠️ 插件运行在 DSH 宿主进程内，**网络访问不受审批门控**。装上即等于授权它把进度发往 `endpoint`。
