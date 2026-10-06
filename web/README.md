# 开发进度看板（React + TypeScript）

展示后端收到的进度里程碑：任务状态、待办进度、交付物、时间线与 md 报告。

## 运行

```powershell
npm install
npm run dev        # → http://127.0.0.1:5273
```

后端地址默认 `http://127.0.0.1:8787`，可用环境变量覆盖：

```powershell
$env:VITE_API_BASE = 'http://192.168.1.10:8787'
npm run dev
```

## 其他脚本

| 命令 | 说明 |
|---|---|
| `npm run typecheck` | `tsc --noEmit` 类型检查 |
| `npm run render-check` | 渲染冒烟测试：拉真实后端数据 → 真实组件 → HTML，20 项断言 |
| `npm run build` | 生产构建到 `dist/` |
| `npm run preview` | 预览生产构建 |

## 结构

```
src/
├─ App.tsx               轮询（3s）、会话选择、布局
├─ api.ts                后端接口封装
├─ types.ts              与后端载荷一一对应的类型
├─ format.ts             时间/字节/标签格式化
├─ markdown.ts           无第三方依赖的 markdown 渲染器（含表格与任务列表）
├─ styles.css            深色主题
└─ components/
   ├─ StatusBar.tsx      连接状态、计数、自动刷新开关
   ├─ TaskCard.tsx       目标阶段、待办进度、交付物
   ├─ Timeline.tsx       里程碑时间线（点击带报告的条目可查看）
   └─ ReportView.tsx     渲染 markdown 报告正文
```

## 说明

- markdown 渲染器**先整体转义 HTML 再转换**，因此报告内容不存在注入风险。
- 看板只读，不提供任何写操作。
- 轮询间隔 3 秒；也可关闭自动刷新后手动刷新。
