import { formatRelative } from '../format'
import type { HealthStats, User } from '../types'

interface Props {
  health: HealthStats | null
  error: string | null
  lastUpdated: number | null
  autoRefresh: boolean
  loading: boolean
  user: User
  view: 'board' | 'settings'
  onToggleAutoRefresh: () => void
  onRefresh: () => void
  onViewChange: (view: 'board' | 'settings') => void
  onLogout: () => void
}

export function StatusBar({
  health,
  error,
  lastUpdated,
  autoRefresh,
  loading,
  user,
  view,
  onToggleAutoRefresh,
  onRefresh,
  onViewChange,
  onLogout,
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

      <nav className="nav">
        <button type="button" className={view === 'board' ? 'is-active' : ''} onClick={() => onViewChange('board')}>
          看板
        </button>
        <button
          type="button"
          className={view === 'settings' ? 'is-active' : ''}
          onClick={() => onViewChange('settings')}
        >
          设置{user.isAdmin ? '与管理' : ''}
        </button>
      </nav>

      <div className="status-bar__meta">
        <span>里程碑：{health?.milestones ?? '—'}</span>
        <span>会话：{health?.sessions ?? '—'}</span>
        {user.isAdmin && <span>账号：{health?.users ?? '—'}</span>}
        <span>更新于 {formatRelative(lastUpdated)}</span>
      </div>

      <div className="status-bar__actions">
        {view === 'board' && (
          <>
            <label className="toggle">
              <input type="checkbox" checked={autoRefresh} onChange={onToggleAutoRefresh} />
              自动刷新
            </label>
            <button type="button" onClick={onRefresh} disabled={loading}>
              {loading ? '刷新中…' : '刷新'}
            </button>
          </>
        )}
        <span className="status-bar__user" title={user.isAdmin ? '管理员' : '普通用户'}>
          {user.displayName ?? user.username}
          {user.isAdmin ? ' · 管理员' : ''}
        </span>
        <button type="button" onClick={onLogout}>
          退出
        </button>
      </div>
    </header>
  )
}
