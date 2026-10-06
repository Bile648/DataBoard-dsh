import { useCallback, useEffect, useMemo, useState } from 'react'

import { fetchHealth, fetchMilestones, fetchSessions } from './api'
import { ReportView } from './components/ReportView'
import { StatusBar } from './components/StatusBar'
import { TaskCard } from './components/TaskCard'
import { Timeline } from './components/Timeline'
import type { HealthResponse, MilestoneRecord, SessionState } from './types'

const POLL_MS = 3000

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
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
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [autoRefresh, load])

  // 默认选中最新上报的会话
  useEffect(() => {
    if (selectedSession || sessions.length === 0) return
    const newest = [...sessions].sort(
      (a, b) => (b.lastMilestoneAt ?? 0) - (a.lastMilestoneAt ?? 0),
    )[0]
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
      />

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
        <Timeline
          records={visibleRecords}
          selectedDelivery={selectedDelivery}
          onSelect={handleSelect}
        />
      </main>

      <ReportView record={reportRecord} />

      <footer className="footer muted small">
        数据源：Python 后端 <code>/dsh/progress/v1</code> · 上送方：DSH 插件 dsh-progress-sync ·{' '}
        每 {POLL_MS / 1000}s 轮询
      </footer>
    </div>
  )
}
