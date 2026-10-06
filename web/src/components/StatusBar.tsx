import type { HealthResponse } from '../types'
import { API_BASE } from '../api'
import { formatRelative } from '../format'

interface Props {
  health: HealthResponse | null
  error: string | null
  lastUpdated: number | null
  autoRefresh: boolean
  loading: boolean
  onToggleAutoRefresh: () => void
  onRefresh: () => void
}

export function StatusBar({
  health,
  error,
  lastUpdated,
  autoRefresh,
  loading,
  onToggleAutoRefresh,
  onRefresh,
}: Props) {
  const online = Boolean(health?.ok) && !error
  return (
    <header className="status-bar">
      <div className="status-bar__main">
        <h1>DSH 开发进度看板</h1>
        <div className={`dot ${online ? 'dot--ok' : 'dot--bad'}`} />
        <span className="status-bar__text">
          {online ? '后端已连接' : error ? `连接失败：${error}` : '连接中…'}
        </span>
      </div>

      <div className="status-bar__meta">
        <span title="后端接口地址">{API_BASE}</span>
        <span>密钥校验：{health?.signatureRequired ? '开' : '关'}</span>
        <span>里程碑：{health?.milestones ?? '—'}</span>
        <span>会话：{health?.sessions ?? '—'}</span>
        <span>更新于 {formatRelative(lastUpdated)}</span>
      </div>

      <div className="status-bar__actions">
        <label className="toggle">
          <input type="checkbox" checked={autoRefresh} onChange={onToggleAutoRefresh} />
          自动刷新
        </label>
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? '刷新中…' : '立即刷新'}
        </button>
      </div>
    </header>
  )
}
