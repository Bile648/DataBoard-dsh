# 插件挂载与端到端验证报告

> 本文档由 DSH 会话在挂载进度同步插件后生成，用于验证「md 报告正文」这条同步路径。

## 挂载方式

插件通过 profile 补丁层的 `insert` 条目挂载，使用**绝对文件路径**，无需 npm 安装：

```yaml
# C:\Users\YH\.dsh\profiles\desktop\cordis.patch.yml
- insert:
    - id: progress-sync
      name: "D:/dshplugin/databoard/plugin/src/index.js"
      config:
        endpoint: http://127.0.0.1:8787
        secret: dev-secret-123
```

挂载结果：`include:progress-sync` → `fiberPhase: active`，插件已随 HMR 实时重载生效。

## 关键环境事实（实测）

| 事实 | 说明 |
|---|---|
| 实际运行的 profile | `desktop`，不是 `web`（`web` 是空模板） |
| loader 补丁语法 | `{ insert: [...] }` 不带 id = 追加到根入口列表 |
| 插入名支持 | 绝对路径 / file URL / 包标识符，加载时自动转 file URL |
| 空补丁文件的后果 | 会导致启动失败，必须用 `[]` |
| 致命风险 | 脱离 `apply()` 的 Promise 若产生未处理 rejection，宿主要「释放应用并以非零码退出」 |

最后一条是本插件在挂载前专门加固的原因：所有事件监听、定时器回调、出队逻辑都经 `safe()` 包裹，
异常一律降级为一条告警，绝不外泄到宿主。

## 同步内容

按设计只上报**大节点**：任务状态（目标阶段、待办计数）+ 给开发者阅读的 markdown 报告 + 变更概览。
不上报工具参数、文件 diff 正文、提示词与 reasoning。

## 验证清单

- [x] 插件在真实 profile 中激活
- [x] 真实会话的 `todo_write` 事件同步到后端（`plan/in_progress`）
- [x] 交付物正文同步到后端（`deliverable/completed`，`source=present`，1776 字节）
- [x] 目标状态生命周期同步（`goal/in_progress` → `goal/completed`，高优先通道）
- [x] 大节点正确继承交付物报告（目标节点带的是 `present` 正文，而非助手短消息）
- [x] 高优先节点未打乱顺序（最终状态为 `complete`，未回退为 `active`）
- [x] 前端看板渲染真实会话数据（渲染冒烟测试 20/20）

## 未覆盖项

- `blocked` 通道（需要真实报错才会触发）与 `phase`（需要 workflow run）
- `session`、`turn` 两类节点默认关闭，未触发
- 真实 `ctx.fs` 与 `node:fs` 回退路径未能区分验证（两种路径都能读到文件，结果一致）
