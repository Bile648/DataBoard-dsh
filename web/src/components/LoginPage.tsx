import { useState } from 'react'

import { ApiError, login } from '../api'

interface Props {
  onSuccess: () => void
}

export function LoginPage({ onSuccess }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username.trim(), password)
      onSuccess()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <h1>DSH 开发进度看板</h1>
        <p className="muted small">请使用管理员分配的账号登录</p>

        <label className="field">
          <span>用户名</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>

        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && <div className="alert alert--error">{error}</div>}

        <button type="submit" className="button--primary" disabled={busy || !username || !password}>
          {busy ? '登录中…' : '登录'}
        </button>

        <p className="muted small auth-card__hint">
          注册已关闭。需要账号请联系管理员，或在服务器上执行
          <code>dsh-progress create-user</code>。
        </p>
      </form>
    </div>
  )
}
