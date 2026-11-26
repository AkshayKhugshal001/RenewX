// /reset-password – opened from the "Forgot password" email. Supabase signs the user in from the link
// (recovery session), then they choose a new password here.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sun } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function ResetPassword() {
  const { session, loading, setNewPassword } = useAuth()
  const navigate = useNavigate()
  const [pw, setPw] = useState({ password: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    if (pw.password.length < 8) return setError('Use at least 8 characters.')
    if (pw.password !== pw.confirm) return setError('The passwords do not match.')
    setBusy(true)
    const r = await setNewPassword(pw.password)
    setBusy(false)
    if (r.error) return setError(r.error)
    navigate('/dashboard', { replace: true })
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <Sun size={30} />
          <div><strong>RenewX</strong><span>Choose a new password</span></div>
        </div>
        <h1>New password</h1>
        {loading ? (
          <p className="muted-text">Checking your reset link…</p>
        ) : !session ? (
          <>
            <p className="msg error">This reset link is invalid or has expired. Request a new one from the login page.</p>
            <button type="button" className="btn primary" onClick={() => navigate('/login')}>Back to login</button>
          </>
        ) : (
          <>
            <label>New password
              <input type="password" autoComplete="new-password" autoFocus value={pw.password} disabled={busy}
                onChange={(e) => setPw((p) => ({ ...p, password: e.target.value }))} />
            </label>
            <label>Repeat new password
              <input type="password" autoComplete="new-password" value={pw.confirm} disabled={busy}
                onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))} />
            </label>
            {error && <p className="msg error">{error}</p>}
            <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</button>
          </>
        )}
      </form>
    </div>
  )
}
