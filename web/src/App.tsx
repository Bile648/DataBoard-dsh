import { useCallback, useEffect, useMemo, useState } from 'react'

import { ApiError, fetchHealth, fetchMe, fetchMilestones, fetchSessions, logout } from './api'
import { LoginPage } from './components/LoginPage'
import { ReportView } from './components/ReportView'
import { SettingsPanel } from './components/SettingsPanel'
import { StatusBar } from './components/StatusBar'
import { TaskCard } from './components/TaskCard'
import { Timeline } from './components/Timeline'
import type { HealthStats, MilestoneRecord, SessionState, User } from './types'

const POLL_MS = 3000

export default function App() {
  // undefined = 还在确认登录态；null = 未登录
  const [user, setUser] = useState<User | null | undefined>(undefined)

  const refreshUser = useCallback(async () => {
    try {
      setUser(await fetchMe())
    } catch {
      setUser(null)
    }
  }, [])

  useEffect(() => {
    void refreshUser()
  }, [refreshUser])

  if (user === undefined) {
    return <div className="splash">加载中…</div>
  }
  if (user === null) {
    return <LoginPage onSuccess={() => void refreshUser()} />
  }
  return <Dashboard user={user} onSignedOut={() => setUser(null)} />
}

interface DashboardProps {
  user: User
  onSignedOut: () => void
}

function Dashboard({ user, onSignedOut }: DashboardProps) {
  const [view, setView] = useState<'board' | 'settings'>('board')
  const [health, setHealth] = useState<HealthStats | null>(null)
  const [records, setRecords] = useState<MilestoneRecord[]>([])
  const [sessions, setSessions] = useState<SessionState[]>([])
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [selectedDelivery, setSelectedDelivery] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [healthResult, milestoneResult, sessionResult] = await Promise.all([
        fetchHealth(),
        fetchMilestones(100),
        fetchSessions(),
      ])
      setHealth(healthResult)
      setRecords(milestoneResult.items ?? [])
      setSessions(sessionResult.items ?? [])
      setError(null)
      setLastUpdated(Date.now())
    } catch (cause) {
      // 会话过期：回到登录页，而不是显示一个永远不会成功的错误
      if (cause instanceof ApiError && cause.status === 401) {
        onSignedOut()
        return
      }
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [onSignedOut])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!autoRefresh || view !== 'board') return
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [autoRefresh, load, view])

  // 默认选中最近有活动的会话
  useEffect(() => {
    if (selectedSession || sessions.length === 0) return
    const newest = [...sessions].sort((a, b) => (b.lastMilestoneAt ?? 0) - (a.lastMilestoneAt ?? 0))[0]
    setSelectedSession(newest.sessionId)
  }, [sessions, selectedSession])

  const activeState = useMemo(
    () => sessions.find((item) => item.sessionId === selectedSession) ?? sessions[0] ?? null,
    [sessions, selectedSession],
  )

  const visibleRecords = useMemo(() => {
    if (!activeState) return records
    return records.filter((record) => record.envelope.session.id === activeState.sessionId)
  }, [records, activeState])

  const reportRecord = useMemo(() => {
    if (selectedDelivery) {
      const chosen = records.find((record) => record.envelope.deliveryId === selectedDelivery)
      if (chosen?.envelope.report) return chosen
    }
    return visibleRecords.find((record) => record.envelope.report) ?? null
  }, [records, visibleRecords, selectedDelivery])

  const handleSelect = useCallback((record: MilestoneRecord) => {
    if (record.envelope.report) setSelectedDelivery(record.envelope.deliveryId)
  }, [])

  const handleLogout = async () => {
    try {
      await logout()
    } finally {
      onSignedOut()
    }
  }

  return (
    <div className="app">
      <StatusBar
        health={health}
        error={error}
        lastUpdated={lastUpdated}
        autoRefresh={autoRefresh}
        loading={loading}
        onToggleAutoRefresh={() => setAutoRefresh((value) => !value)}
        onRefresh={() => void load()}
        user={user}
        view={view}
        onViewChange={setView}
        onLogout={() => void handleLogout()}
      />

      {view === 'settings' ? (
        <SettingsPanel user={user} />
      ) : (
        <>
          {sessions.length > 1 && (
            <div className="session-picker">
              {sessions.map((item) => (
                <button
                  key={item.sessionId}
                  type="button"
                  className={item.sessionId === activeState?.sessionId ? 'is-active' : ''}
                  onClick={() => {
                    setSelectedSession(item.sessionId)
                    setSelectedDelivery(null)
                  }}
                >
                  {item.session.title ?? item.sessionId}
                </button>
              ))}
            </div>
          )}

          <main className="grid">
            <TaskCard state={activeState} />
            <Timeline records={visibleRecords} selectedDelivery={selectedDelivery} onSelect={handleSelect} />
          </main>

          <ReportView record={reportRecord} />
        </>
      )}

      <footer className="footer muted small">
        数据源 <code>/api</code> · 上送方 DSH 插件 dsh-progress-sync · 看板每 {POLL_MS / 1000}s 轮询
      </footer>
    </div>
  )
}
