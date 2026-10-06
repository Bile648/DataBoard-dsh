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

## 接入 DSH profile（已实测）

profile 位于 `$DSH_HOME/profiles/<name>`。在 profile 的 `cordis.patch.yml` 追加一个**不带 `id` 的 `insert` 条目**
即可挂载，**无需 npm 安装**：

```yaml
- insert:
    - id: progress-sync
      name: "D:/path/to/plugin/src/index.js"   # 绝对路径 / file URL / 包标识符均可
      config:
        endpoint: http://127.0.0.1:8787
        secret: dev-secret-123
```

要点（均来自本机 `@deepseek-ai/dsh-app-boot` 文档的实测确认）：

- `insert` **不带 `id`** = 追加到根入口列表；带 `id` 则插入到该 group 内部。
- 插入名支持绝对路径 / file URL / 包标识符；加载时会把绝对路径自动转成 file URL。
- 插件名要指向**入口文件**而不是目录 —— ESM 不做目录解析。
- 空补丁文件（或仅含注释）**会导致启动失败**；要停用该层请写 `[]`。
- 启用了 `dsh-hmr` 时，改补丁文件会实时重载，不需要重启进程。

### ⚠️ 宿主致命风险（改代码前必读）

`dsh-app-boot` 的失败模式表明确规定：脱离 `apply()` 返回的 Promise 一旦产生**未处理 rejection**，
宿主要「释放应用并以非零码退出」。同理，同步回调（定时器、流监听）抛出的未捕获异常也是致命错误。

因此本插件的**所有**事件监听、定时器回调与出队逻辑都经 `safe()` 包裹（见 `src/index.js`），
任何异常都只降级为一条告警，绝不外泄到宿主。修改本插件时必须保持这个约束。

> ⚠️ 插件运行在 DSH 宿主进程内，**网络访问不受审批门控**。装上即等于授权它把进度发往 `endpoint`。
