import type { SessionState } from '../types'
import { PHASE_LABEL, STATUS_LABEL, formatRelative } from '../format'

interface Props {
  state: SessionState | null
}

export function TaskCard({ state }: Props) {
  if (!state) {
    return (
      <section className="card">
        <h2>任务状态</h2>
        <p className="muted">还没有任何会话上报进度。先运行插件的连通性模拟器。</p>
      </section>
    )
  }

  const goal = state.goal
  const counts = state.counts as { completed?: number; total?: number; in_progress?: number; pending?: number }
  const total = counts.total ?? 0
  const completed = counts.completed ?? 0
  const ratio = total > 0 ? completed / total : 0

  return (
    <section className="card">
      <h2>任务状态</h2>

      <div className="session-line">
        <span className="session-line__title">{state.session.title ?? state.sessionId}</span>
        <span className={`badge badge--status-${state.lastStatus ?? 'idle'}`}>
          {state.lastStatus ? STATUS_LABEL[state.lastStatus] : '未知'}
        </span>
      </div>
      <div className="muted small">
        {state.sessionId} · 共 {state.milestoneCount} 条里程碑 · 最后更新 {formatRelative(state.lastMilestoneAt)}
      </div>

      <h3>目标</h3>
      {goal ? (
        <div className="goal">
          <div className="goal__objective">{goal.objective}</div>
          <div className="goal__meta">
            <span className={`badge badge--phase-${goal.phase ?? 'active'}`}>
              {PHASE_LABEL[goal.phase ?? 'active'] ?? goal.phase}
            </span>
            <span className="muted small">
              回合 {goal.roundsStarted}
              {goal.maxGoalRounds ? ` / ${goal.maxGoalRounds}` : ''}
            </span>
          </div>
          {goal.blockedReason && (
            <div className="alert alert--warn">
              阻塞：{goal.blockedReason.message}（{goal.blockedReason.code}）
            </div>
          )}
        </div>
      ) : (
        <p className="muted">本次会话未上报目标。</p>
      )}

      <h3>待办</h3>
      {total > 0 ? (
        <>
          <div className="progress">
            <div className="progress__bar" style={{ width: `${Math.round(ratio * 100)}%` }} />
          </div>
          <div className="muted small">
            {completed}/{total} 完成
            {counts.in_progress ? ` · ${counts.in_progress} 进行中` : ''}
            {counts.pending ? ` · ${counts.pending} 待处理` : ''}
          </div>
          <ul className="todos">
            {state.todos.map((todo, index) => (
              <li key={`${todo.content}-${index}`} className={`todo todo--${todo.status}`}>
                <span className="todo__mark">
                  {todo.status === 'completed' ? '✔' : todo.status === 'in_progress' ? '◐' : '○'}
                </span>
                {todo.content}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">暂无待办快照。</p>
      )}

      <h3>交付物</h3>
      {state.artifacts?.length ? (
        <ul className="artifacts">
          {state.artifacts.map((artifact) => (
            <li key={artifact.path}>
              <code>{artifact.path}</code>
              {artifact.description ? <span className="muted"> · {artifact.description}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">暂无交付物。</p>
      )}
    </section>
  )
}
