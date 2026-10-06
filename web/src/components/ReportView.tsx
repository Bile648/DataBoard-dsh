import { useMemo } from 'react'

import type { MilestoneRecord } from '../types'
import { formatBytes, formatTime } from '../format'
import { renderMarkdown } from '../markdown'

interface Props {
  record: MilestoneRecord | null
}

const SOURCE_LABEL: Record<string, string> = {
  present: '交付物正文',
  'assistant-message': '助手收尾消息',
  synthesized: '插件自动摘要',
}

export function ReportView({ record }: Props) {
  const report = record?.envelope.report ?? null
  const html = useMemo(() => (report ? renderMarkdown(report.body) : ''), [report])

  return (
    <section className="card card--report">
      <h2>报告</h2>
      {!report ? (
        <p className="muted">尚未收到附带报告的里程碑（交付物或目标完成节点会带报告）。</p>
      ) : (
        <>
          <div className="report__meta">
            <strong>{report.title ?? '未命名报告'}</strong>
            <span className="muted small">
              来源：{SOURCE_LABEL[report.source] ?? report.source} · {formatBytes(report.bytes)} ·{' '}
              {formatTime(record?.envelope.milestone.at)} · sha256 {report.sha256.slice(0, 12)}…
            </span>
            {report.truncated && <span className="badge badge--warn">已截断</span>}
          </div>
          <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
        </>
      )}
    </section>
  )
}
