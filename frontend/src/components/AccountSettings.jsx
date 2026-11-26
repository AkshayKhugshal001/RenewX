// Settings → Account. The page only SHOWS the account; each change opens its own step-by-step dialog:
//   password: current password → new password (twice) → done (other devices signed out)
//   email:    current password → new address → confirmation link(s) sent by Supabase
import { useEffect, useState } from 'react'
import { X, Mail, KeyRound, UserRound, LogOut, Pencil, Check, ShieldCheck } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

function useEscape(busy, onClose) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
}

function Steps({ steps, at }) {
  return (
    <ol className="steps" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s} className={i < at ? 'done' : i === at ? 'on' : ''} aria-current={i === at ? 'step' : undefined}>
          <span>{i < at ? <Check size={12} /> : i + 1}</span>{s}
        </li>
      ))}
    </ol>
  )
}

function Dialog({ title, busy, onClose, onSubmit, children }) {
  useEscape(busy, onClose)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="modal account-modal" role="dialog" aria-modal="true" aria-label={title} onSubmit={onSubmit}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close"><X size={20} /></button>
        </div>
        {children}
      </form>
    </div>
  )
}

/** Step 1 of both flows: prove it is really you. */
function CurrentPassword({ value, onChange, busy, onForgot }) {
  return (
    <>
      <p className="muted-text"><ShieldCheck size={15} /> For your security, first confirm your current password.</p>
      <label className="field">Current password
        <input type="password" autoComplete="current-password" autoFocus value={value} disabled={busy}
          onChange={(e) => onChange(e.target.value)} />
      </label>
      <button type="button" className="link-btn" onClick={onForgot} disabled={busy}>Forgot your current password?</button>
    </>
  )
}

function strength(pw) {
  let s = 0
  if (pw.length >= 8) s++
  if (pw.length >= 12) s++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++
  if (/\d/.test(pw)) s++
  if (/[^A-Za-z0-9]/.test(pw)) s++
  return pw ? ['Very weak', 'Weak', 'Fair', 'Good', 'Strong', 'Strong'][s] : ''
}

function ForgotNote({ sent, error }) {
  if (error) return <p className="msg error">{error}</p>
  if (sent) return <p className="msg ok">A reset link was sent to your email. Open it on this device to choose a new password.</p>
  return null
}

function useForgot(email) {
  const { sendPasswordReset } = useAuth()
  const [state, setState] = useState({ sent: false, error: '' })
  const forgot = async () => {
    const r = await sendPasswordReset(email)
    setState(r.error ? { sent: false, error: r.error } : { sent: true, error: '' })
  }
  return [state, forgot]
}

function ChangePasswordDialog({ onClose, onDone }) {
  const { user, verifyPassword, changePassword } = useAuth()
  const [step, setStep] = useState(0)
  const [current, setCurrent] = useState('')
  const [pw, setPw] = useState({ password: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [forgot, sendForgot] = useForgot(user?.email ?? '')

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (step === 0) {
      if (!current) return setError('Enter your current password.')
      setBusy(true)
      const r = await verifyPassword(current)
      setBusy(false)
      return r.error ? setError(r.error) : setStep(1)
    }
    if (pw.password.length < 8) return setError('Use at least 8 characters.')
    if (pw.password !== pw.confirm) return setError('The two new passwords do not match.')
    if (pw.password === current) return setError('The new password must be different from the current one.')
    setBusy(true)
    const r = await changePassword(pw.password)
    setBusy(false)
    if (r.error) return setError(r.error)
    onDone('Password changed. Other devices were signed out.')
  }

  const s = strength(pw.password)
  return (
    <Dialog title="Change password" busy={busy} onClose={onClose} onSubmit={submit}>
      <Steps steps={['Verify', 'New password']} at={step} />
      {step === 0 ? (
        <>
          <CurrentPassword value={current} onChange={setCurrent} busy={busy} onForgot={sendForgot} />
          <ForgotNote {...forgot} />
        </>
      ) : (
        <>
          <label className="field">New password
            <input type="password" autoComplete="new-password" autoFocus value={pw.password} disabled={busy}
              onChange={(e) => setPw((p) => ({ ...p, password: e.target.value }))} />
          </label>
          {s && <p className={`pw-strength s-${s.toLowerCase().replace(' ', '-')}`}>Strength: {s}</p>}
          <label className="field">Repeat new password
            <input type="password" autoComplete="new-password" value={pw.confirm} disabled={busy}
              onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))} />
          </label>
        </>
      )}
      {error && <p className="msg error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={step ? () => { setStep(0); setError('') } : onClose} disabled={busy}>
          {step ? 'Back' : 'Cancel'}
        </button>
        <button className="btn primary" disabled={busy}>
          {busy ? 'Checking…' : step ? 'Change password' : 'Continue'}
        </button>
      </div>
    </Dialog>
  )
}

function ChangeEmailDialog({ onClose }) {
  const { user, verifyPassword, changeEmail } = useAuth()
  const [step, setStep] = useState(0)
  const [current, setCurrent] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [forgot, sendForgot] = useForgot(user?.email ?? '')

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (step === 0) {
      if (!current) return setError('Enter your current password.')
      setBusy(true)
      const r = await verifyPassword(current)
      setBusy(false)
      return r.error ? setError(r.error) : setStep(1)
    }
    if (step === 2) return onClose()
    const next = email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) return setError('Enter a valid email address.')
    if (next === user?.email?.toLowerCase()) return setError('This is already your email address.')
    setBusy(true)
    const r = await changeEmail(next)
    setBusy(false)
    if (r.error) return setError(r.error)
    setStep(2)
  }

  return (
    <Dialog title="Change email" busy={busy} onClose={onClose} onSubmit={submit}>
      <Steps steps={['Verify', 'New email', 'Confirm by email']} at={step} />
      {step === 0 && (
        <>
          <CurrentPassword value={current} onChange={setCurrent} busy={busy} onForgot={sendForgot} />
          <ForgotNote {...forgot} />
        </>
      )}
      {step === 1 && (
        <>
          <p className="muted-text">Current: <b>{user?.email}</b></p>
          <label className="field">New email address
            <input type="email" autoComplete="email" autoFocus value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <p className="muted-text">Your plants and data stay exactly as they are – they belong to your account, not to the address.</p>
        </>
      )}
      {step === 2 && (
        <div className="msg ok">
          <p><Mail size={15} /> Confirmation sent to <b>{email.trim()}</b>.</p>
          <p>Open the link in that email to finish. If your project requires it, a second link is also sent to
            {' '}<b>{user?.email}</b> – both must be clicked. Until then you keep signing in with your current address.</p>
        </div>
      )}
      {error && <p className="msg error">{error}</p>}
      <div className="modal-actions">
        {step < 2 && (
          <button type="button" className="btn" onClick={step ? () => { setStep(0); setError('') } : onClose} disabled={busy}>
            {step ? 'Back' : 'Cancel'}
          </button>
        )}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Checking…' : step === 0 ? 'Continue' : step === 1 ? 'Send confirmation' : 'Done'}
        </button>
      </div>
    </Dialog>
  )
}

function NameRow() {
  const { user, profile, updateName } = useAuth()
  const current = profile?.full_name || user?.user_metadata?.full_name || ''
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function save(e) {
    e.preventDefault()
    if (!name.trim()) return setError('Enter a name.')
    setBusy(true)
    const r = await updateName(name)
    setBusy(false)
    if (r.error) return setError(r.error)
    setError('')
    setEditing(false)
  }

  if (!editing) {
    return (
      <li className="account-row">
        <UserRound size={18} /><div><small>Display name</small><strong>{current || '—'}</strong></div>
        <button className="btn sm" onClick={() => { setName(current); setEditing(true) }}><Pencil size={14} /> Edit</button>
      </li>
    )
  }
  return (
    <li className="account-row editing">
      <form onSubmit={save}>
        <label className="field">Display name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus disabled={busy} />
        </label>
        {error && <p className="msg error">{error}</p>}
        <div className="device-actions">
          <button type="button" className="btn sm" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
          <button className="btn sm primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </li>
  )
}

export default function AccountSection() {
  const { user, profile, signOut } = useAuth()
  const [dialog, setDialog] = useState(null) // 'email' | 'password'
  const [notice, setNotice] = useState('')
  const name = profile?.full_name || user?.user_metadata?.full_name || user?.email || '?'
  const pendingEmail = user?.new_email

  return (
    <div className="card account">
      <div className="account-head">
        <span className="avatar lg">{name[0].toUpperCase()}</span>
        <div>
          <h2>{name}</h2>
          <p className="muted-text">{profile?.role || 'Plant Manager'} · {user?.email}</p>
        </div>
      </div>
      {notice && <p className="msg ok">{notice}</p>}

      <ul className="account-list">
        <NameRow />
        <li className="account-row">
          <Mail size={18} />
          <div>
            <small>Email</small><strong>{user?.email}</strong>
            {pendingEmail && <small className="pending">Waiting for confirmation: {pendingEmail}</small>}
          </div>
          <button className="btn sm" onClick={() => { setNotice(''); setDialog('email') }}>Change</button>
        </li>
        <li className="account-row">
          <KeyRound size={18} /><div><small>Password</small><strong>••••••••</strong></div>
          <button className="btn sm" onClick={() => { setNotice(''); setDialog('password') }}>Change</button>
        </li>
        <li className="account-row">
          <LogOut size={18} /><div><small>Session</small><strong>Signed in on this device</strong></div>
          <button className="btn sm danger" onClick={() => signOut()}>Sign out</button>
        </li>
      </ul>

      {dialog === 'password' && (
        <ChangePasswordDialog onClose={() => setDialog(null)} onDone={(text) => { setDialog(null); setNotice(text) }} />
      )}
      {dialog === 'email' && <ChangeEmailDialog onClose={() => setDialog(null)} />}
    </div>
  )
}
