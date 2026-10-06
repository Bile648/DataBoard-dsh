import { useCallback, useEffect, useState } from 'react'

import {
  ApiError,
  changePassword,
  clearMilestones,
  createUser,
  deleteUser,
  fetchIngestToken,
  fetchUsers,
  resetUserPassword,
  rotateIngestToken,
} from '../api'
import { formatRelative } from '../format'
import type { AdminUser, IngestTokenInfo, User } from '../types'

interface Props {
  user: User
}

/** 复制到剪贴板，失败时降级为提示（非 HTTPS 环境下 clipboard API 不可用） */
function useCopy() {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1600)
    } catch {
      window.prompt('自动复制不可用，请手动复制：', text)
    }
  }, [])
  return { copied, copy }
}

export function SettingsPanel({ user }: Props) {
  const { copied, copy } = useCopy()

  // ------------------------------------------------------------ 插件接入
  const [tokenInfo, setTokenInfo] = useState<IngestTokenInfo | null>(null)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [rotating, setRotating] = useState(false)

  // ------------------------------------------------------------ 账号管理
  const [users, setUsers] = useState<AdminUser[]>([])
  const [newUser, setNewUser] = useState({ username: '', password: '', isAdmin: false })
  const [userMessage, setUserMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  // ------------------------------------------------------------ 修改密码
  const [pwForm, setPwForm] = useState({ current: '', next: '' })
  const [pwMessage, setPwMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const loadAdmin = useCallback(async () => {
    if (!user.isAdmin) return
    try {
      const [info, list] = await Promise.all([fetchIngestToken(), fetchUsers()])
      setTokenInfo(info)
      setUsers(list.items)
      setTokenError(null)
    } catch (error) {
      setTokenError(error instanceof ApiError ? error.message : String(error))
    }
  }, [user.isAdmin])

  useEffect(() => {
    void loadAdmin()
  }, [loadAdmin])

  const handleRotate = async () => {
    if (!window.confirm('轮换后旧令牌立即失效，需要同步更新插件配置。继续？')) return
    setRotating(true)
    try {
      setTokenInfo(await rotateIngestToken())
      setRevealed(true)
    } catch (error) {
      setTokenError(error instanceof ApiError ? error.message : String(error))
    } finally {
      setRotating(false)
    }
  }

  const handleCreateUser = async (event: React.FormEvent) => {
    event.preventDefault()
    setUserMessage(null)
    try {
      const created = await createUser({
        username: newUser.username.trim(),
        password: newUser.password,
        isAdmin: newUser.isAdmin,
      })
      setUserMessage({ kind: 'ok', text: `已创建 ${created.user.username}` })
      setNewUser({ username: '', password: '', isAdmin: false })
      setUsers((await fetchUsers()).items)
    } catch (error) {
      setUserMessage({ kind: 'error', text: error instanceof ApiError ? error.message : String(error) })
    }
  }

  const handleDelete = async (username: string) => {
    if (!window.confirm(`删除账号 ${username}？`)) return
    try {
      await deleteUser(username)
      setUsers((await fetchUsers()).items)
      setUserMessage({ kind: 'ok', text: `已删除 ${username}` })
    } catch (error) {
      setUserMessage({ kind: 'error', text: error instanceof ApiError ? error.message : String(error) })
    }
  }

  const handleResetPassword = async (username: string) => {
    const password = window.prompt(`为 ${username} 设置新密码（至少 8 位）`)
    if (!password) return
    try {
      await resetUserPassword(username, password)
      setUserMessage({ kind: 'ok', text: `已重置 ${username} 的密码` })
    } catch (error) {
      setUserMessage({ kind: 'error', text: error instanceof ApiError ? error.message : String(error) })
    }
  }

  const handleClearMilestones = async () => {
    if (!window.confirm('将删除全部里程碑与状态快照（账号保留）。确认？')) return
    try {
      const result = await clearMilestones()
      setUserMessage({ kind: 'ok', text: `已删除 ${result.removed} 条里程碑` })
    } catch (error) {
      setUserMessage({ kind: 'error', text: error instanceof ApiError ? error.message : String(error) })
    }
  }

  const handleChangePassword = async (event: React.FormEvent) => {
    event.preventDefault()
    setPwMessage(null)
    try {
      await changePassword(pwForm.current, pwForm.next)
      setPwMessage({ kind: 'ok', text: '密码已更新，其他设备上的会话已吊销' })
      setPwForm({ current: '', next: '' })
    } catch (error) {
      setPwMessage({ kind: 'error', text: error instanceof ApiError ? error.message : String(error) })
    }
  }

  const masked = tokenInfo ? `${tokenInfo.token.slice(0, 10)}${'•'.repeat(24)}` : ''

  return (
    <div className="settings">
      {user.isAdmin && (
        <section className="card">
          <h2>插件接入</h2>
          {tokenError && <div className="alert alert--error">{tokenError}</div>}
          {!tokenInfo && !tokenError && <p className="muted">读取中…</p>}
          {tokenInfo && (
            <>
              <p className="muted small">
                这是本服务的<strong>摄入令牌</strong>，DSH 插件用它上报进度。
                {tokenInfo.managedByEnv && '（当前由环境变量 DSH_PROGRESS_INGEST_TOKEN 固定，无法在界面轮换）'}
              </p>

              <div className="token-row">
                <code className="token-value">{revealed ? tokenInfo.token : masked}</code>
                <button type="button" onClick={() => setRevealed((value) => !value)}>
                  {revealed ? '隐藏' : '显示'}
                </button>
                <button type="button" onClick={() => void copy('token', tokenInfo.token)}>
                  {copied === 'token' ? '已复制' : '复制'}
                </button>
                {!tokenInfo.managedByEnv && (
                  <button type="button" onClick={() => void handleRotate()} disabled={rotating}>
                    {rotating ? '轮换中…' : '轮换令牌'}
                  </button>
                )}
              </div>

              <h3>插件配置片段</h3>
              <p className="muted small">
                追加到 <code>$DSH_HOME/profiles/&lt;profile&gt;/cordis.patch.yml</code>，
                并把 <code>name</code> 改成插件入口文件的绝对路径。
              </p>
              <div className="snippet">
                <button type="button" onClick={() => void copy('snippet', tokenInfo.snippet)}>
                  {copied === 'snippet' ? '已复制' : '复制片段'}
                </button>
                <pre>{tokenInfo.snippet}</pre>
              </div>
            </>
          )}
        </section>
      )}

      {user.isAdmin && (
        <section className="card">
          <h2>账号管理</h2>
          <p className="muted small">Web 端注册已关闭，账号只能在这里创建。</p>

          <form className="inline-form" onSubmit={handleCreateUser}>
            <input
              placeholder="用户名"
              value={newUser.username}
              onChange={(event) => setNewUser({ ...newUser, username: event.target.value })}
              required
            />
            <input
              placeholder="初始密码（≥8 位）"
              type="password"
              value={newUser.password}
              onChange={(event) => setNewUser({ ...newUser, password: event.target.value })}
              required
            />
            <label className="toggle">
              <input
                type="checkbox"
                checked={newUser.isAdmin}
                onChange={(event) => setNewUser({ ...newUser, isAdmin: event.target.checked })}
              />
              管理员
            </label>
            <button type="submit">创建账号</button>
          </form>

          {userMessage && (
            <div className={`alert alert--${userMessage.kind === 'ok' ? 'ok' : 'error'}`}>{userMessage.text}</div>
          )}

          <table className="table">
            <thead>
              <tr>
                <th>用户名</th>
                <th>角色</th>
                <th>最后登录</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.username}
                    {item.username === user.username && <span className="muted small"> · 当前账号</span>}
                  </td>
                  <td>{item.isAdmin ? '管理员' : '普通'}</td>
                  <td className="muted small">{item.lastLoginAt ? formatRelative(item.lastLoginAt) : '从未'}</td>
                  <td className="table__actions">
                    <button type="button" onClick={() => void handleResetPassword(item.username)}>
                      重置密码
                    </button>
                    {item.username !== user.username && (
                      <button type="button" className="button--danger" onClick={() => void handleDelete(item.username)}>
                        删除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2>修改我的密码</h2>
        <form className="inline-form" onSubmit={handleChangePassword}>
          <input
            type="password"
            placeholder="当前密码"
            value={pwForm.current}
            onChange={(event) => setPwForm({ ...pwForm, current: event.target.value })}
            required
          />
          <input
            type="password"
            placeholder="新密码（≥8 位）"
            value={pwForm.next}
            onChange={(event) => setPwForm({ ...pwForm, next: event.target.value })}
            required
          />
          <button type="submit">更新密码</button>
        </form>
        {pwMessage && (
          <div className={`alert alert--${pwMessage.kind === 'ok' ? 'ok' : 'error'}`}>{pwMessage.text}</div>
        )}
      </section>

      {user.isAdmin && (
        <section className="card">
          <h2>危险操作</h2>
          <p className="muted small">清空全部里程碑与状态快照。账号与摄入令牌不受影响。</p>
          <button type="button" className="button--danger" onClick={() => void handleClearMilestones()}>
            清空全部里程碑
          </button>
        </section>
      )}
    </div>
  )
}
