/**
 * 前端渲染冒烟测试。
 *
 * 目的：在没有浏览器的环境里验证「后端真实数据 → 真实 React 组件 → HTML」这条链路，
 * 而不只是「构建通过」。构建通过不代表运行时不会炸（比如访问了 undefined 的字段）。
 *
 * 用法：npm run render-check   （需要后端已在 8787 运行）
 */

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

import { ReportView } from '../src/components/ReportView'
import { StatusBar } from '../src/components/StatusBar'
import { TaskCard } from '../src/components/TaskCard'
import { Timeline } from '../src/components/Timeline'
import { renderMarkdown } from '../src/markdown'
import type { HealthResponse, MilestoneRecord, SessionState } from '../src/types'

const BASE = 'http://127.0.0.1:8787'
const noop = () => {}

// 本文件在 Node 下运行，但项目未引入 @types/node，这里只声明真正用到的部分
declare const process: { exitCode?: number }

const results: { name: string; ok: boolean; detail?: string }[] = []

function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`)
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`)
  return (await response.json()) as T
}

async function main() {
  console.log('=== 前端渲染冒烟测试 ===')

  const health = await getJson<HealthResponse>('/dsh/progress/v1/health')
  const milestones = (await getJson<{ items: MilestoneRecord[] }>('/dsh/progress/v1/milestones?limit=100')).items
  const sessions = (await getJson<{ items: SessionState[] }>('/dsh/progress/v1/sessions')).items

  check('拉到后端数据', milestones.length > 0 && sessions.length > 0, `${milestones.length} 条里程碑 / ${sessions.length} 个会话`)

  // 与 App.tsx 一致：默认选中最近有活动的会话
  const state = [...sessions].sort((a, b) => (b.lastMilestoneAt ?? 0) - (a.lastMilestoneAt ?? 0))[0]
  const reportRecord = milestones.find((item) => item.envelope.report) ?? null

  const html = renderToString(
    createElement(
      'div',
      null,
      createElement(StatusBar, {
        health,
        error: null,
        lastUpdated: Date.now(),
        autoRefresh: true,
        loading: false,
        onToggleAutoRefresh: noop,
        onRefresh: noop,
      }),
      createElement(TaskCard, { state }),
      createElement(Timeline, { records: milestones, selectedDelivery: null, onSelect: noop }),
      createElement(ReportView, { record: reportRecord }),
    ),
  )

  check('组件树渲染出非空 HTML', html.length > 2000, `${html.length} 字符`)
  check('渲染过程未出现 undefined 文本', !html.includes('>undefined<') && !html.includes('undefined ·'))

  const objective = state.goal?.objective ?? ''
  check('任务目标已渲染', Boolean(objective) && html.includes(objective), objective.slice(0, 30))

  const firstTodo = state.todos?.[0]?.content ?? ''
  check('待办条目已渲染', Boolean(firstTodo) && html.includes(firstTodo), firstTodo)

  check('待办进度条已渲染', html.includes('progress__bar'))
  const firstArtifact = state.artifacts?.[0]?.path ?? ''
  check('交付物清单已渲染', Boolean(firstArtifact) && html.includes(firstArtifact), firstArtifact)

  check('时间线已渲染里程碑', html.includes('timeline__item'), `${milestones.length} 条`)
  check(
    '高优先节点带高优先标记',
    html.includes('高优先'),
    `含 ${milestones.filter((m) => m.envelope.milestone.priority === 'high').length} 条高优先`,
  )

  check('报告正文已渲染', Boolean(reportRecord) && html.includes('markdown'))
  check('markdown 表格已正确转换', html.includes('<table class="md-table">'))
  check('报告来源标注已渲染', html.includes('交付物正文'))

  // 渲染器能力用合成样例单独验证：真实报告里未必出现所有语法
  const sample = [
    '# 一级标题',
    '',
    '- [x] 已完成项',
    '- [ ] 待办项',
    '',
    '| 列A | 列B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '- 普通项',
    '',
    '1. 有序一',
    '',
    '> 引用行',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '**粗体** 与 `行内代码`',
  ].join('\n')
  const rendered = renderMarkdown(sample)

  check('渲染器：标题', rendered.includes('<h1>一级标题</h1>'))
  check(
    '渲染器：任务列表（含勾选态）',
    rendered.includes('md-tasks') && rendered.includes('is-done') && rendered.includes('待办项'),
  )
  check('渲染器：表格', rendered.includes('<table class="md-table">') && rendered.includes('<th>列A</th>'))
  check('渲染器：代码块', rendered.includes('<pre class="md-code">') && rendered.includes('const a = 1'))
  check('渲染器：引用', rendered.includes('<blockquote>引用行</blockquote>'))
  check('渲染器：有序/无序列表', rendered.includes('<ol>') && rendered.includes('<ul>'))
  check(
    '渲染器：行内样式',
    rendered.includes('<strong>粗体</strong>') && rendered.includes('<code>行内代码</code>'),
  )
  check(
    '渲染器：HTML 注入被转义',
    renderMarkdown('<img src=x onerror=alert(1)>').includes('&lt;img') &&
      !renderMarkdown('<img src=x onerror=alert(1)>').includes('<img'),
  )

  const failed = results.filter((item) => !item.ok)
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length) {
    for (const item of failed) console.log(`  ✗ ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('渲染冒烟测试异常：', error)
  process.exitCode = 1
})
