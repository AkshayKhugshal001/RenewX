import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Sun } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function Auth() {
  const { session, signIn, signUp } = useAuth()
  const [mode, setMode] = useState('login') // 'login' | 'signup'
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  if (session) return <Navigate to="/dashboard" replace />

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setInfo('')
    setBusy(true)
    if (mode === 'login') {
      const { error } = await signIn(email, password)
      if (error) setError(error.message)
    } else {
      const { data, error } = await signUp(email, password, fullName.trim())
      if (error) setError(error.message)
      else if (!data.session) {
        // Email confirmation is enabled in Supabase: no session until the link is clicked
        setInfo('Account created. Check your email and click the confirmation link, then log in.')
        setMode('login')
      }
    }
    setBusy(false)
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={handleSubmit}>
        <div className="auth-brand">
          <Sun size={30} />
          <div>
            <strong>RenewX</strong>
            <span>Intelligent platform for next-generation energy</span>
          </div>
        </div>

        <h1>{mode === 'login' ? 'Log in' : 'Create your account'}</h1>

        {mode === 'signup' && (
          <label>
            Full name
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={6}
            required
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>

        {error && <p className="msg error">{error}</p>}
        {info && <p className="msg ok">{info}</p>}

        <button className="btn primary" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Sign up'}
        </button>

        <p className="auth-switch">
          {mode === 'login' ? 'New to RenewX?' : 'Already have an account?'}{' '}
          <button
            type="button"
            className="link"
            onClick={() => {
              setMode(mode === 'login' ? 'signup' : 'login')
              setError('')
              setInfo('')
            }}
          >
            {mode === 'login' ? 'Create an account' : 'Log in'}
          </button>
        </p>
      </form>
    </div>
  )
}
