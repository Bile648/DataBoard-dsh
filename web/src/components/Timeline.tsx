import type { MilestoneRecord } from '../types'
import { KIND_LABEL, STATUS_LABEL, formatTime } from '../format'

interface Props {
  records: MilestoneRecord[]
  selectedDelivery: string | null
  onSelect: (record: MilestoneRecord) => void
}

export function Timeline({ records, selectedDelivery, onSelect }: Props) {
  return (
    <section className="card card--grow">
      <h2>
        里程碑时间线 <span className="muted small">（{records.length} 条，按事件时间倒序）</span>
      </h2>
      {records.length === 0 ? (
        <p className="muted">还没有收到里程碑。</p>
      ) : (
        <ol className="timeline">
          {records.map((record) => {
            const { envelope } = record
            const { milestone, report, error } = envelope
            const selected = envelope.deliveryId === selectedDelivery
            return (
              <li
                key={envelope.deliveryId}
                className={`timeline__item${selected ? ' is-selected' : ''}${report ? ' has-report' : ''}`}
                onClick={() => onSelect(record)}
                title={report ? '点击查看报告' : '该里程碑没有附带报告'}
              >
                <div className="timeline__head">
                  <span className={`badge badge--kind-${milestone.kind}`}>{KIND_LABEL[milestone.kind]}</span>
                  <span className={`badge badge--status-${milestone.status}`}>
                    {STATUS_LABEL[milestone.status] ?? milestone.status}
                  </span>
                  {milestone.priority === 'high' && <span className="badge badge--high">高优先</span>}
                  {report && <span className="badge badge--report">含报告</span>}
                  <span className="timeline__time">{formatTime(milestone.at)}</span>
                </div>
                <div className="timeline__title">{milestone.title ?? milestone.sequenceKey}</div>
                <div className="timeline__meta muted small">
                  {envelope.changes
                    ? `变更 ${envelope.changes.files} 文件 +${envelope.changes.added}/-${envelope.changes.deleted} · `
                    : ''}
                  {envelope.session.seq != null ? `seq ${envelope.session.seq} · ` : ''}
                  {envelope.deliveryId.slice(0, 8)}
                </div>
                {error && <div className="alert alert--error">{error.message}</div>}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
