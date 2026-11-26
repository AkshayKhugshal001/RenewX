/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { clearPageCache } from '../lib/pageCache'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  // Keep session in sync with Supabase (login, logout, token refresh)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_OUT') clearPageCache() // never show one user's cached pages to the next
      setSession(s)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  // Load the user's profile row (name, role) whenever the user changes
  const userId = session?.user?.id
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    supabase
      .from('profiles')
      .select('full_name, role')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setProfile(data)
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  const value = {
    session,
    user: session?.user ?? null,
    profile: userId ? profile : null,
    loading,
    signIn: (email, password) => supabase.auth.signInWithPassword({ email, password }),
    signUp: (email, password, fullName) =>
      supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName },
          emailRedirectTo: window.location.origin,
        },
      }),
    signOut: () => supabase.auth.signOut(),
    /** Change the display name (profiles table + login metadata). */
    updateName: async (fullName) => {
      const name = fullName.trim()
      const { error } = await supabase.from('profiles').update({ full_name: name }).eq('id', userId)
      if (error) return { error: error.message }
      await supabase.auth.updateUser({ data: { full_name: name } })
      setProfile((p) => ({ ...(p ?? {}), full_name: name }))
      return {}
    },
    /** Re-check the CURRENT password before a sensitive change (signs in again as the same user). */
    verifyPassword: async (password) => {
      const email = session?.user?.email
      if (!email) return { error: 'You are not signed in.' }
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (!error) return {}
      return { error: /invalid/i.test(error.message) ? 'The current password is incorrect.' : error.message }
    },
    /** New password; afterwards every OTHER device is signed out. */
    changePassword: async (password) => {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) return { error: error.message }
      await supabase.auth.signOut({ scope: 'others' }).catch(() => {})
      return {}
    },
    /** Supabase e-mails a confirmation link (to both addresses if "Secure email change" is on);
     *  the address changes only after it is clicked. Plants stay linked – they belong to the user id. */
    changeEmail: async (email) => {
      const { error } = await supabase.auth.updateUser(
        { email: email.trim() },
        { emailRedirectTo: `${window.location.origin}/settings?section=account` },
      )
      return error ? { error: error.message } : {}
    },
    /** "Forgot password": e-mail with a link to /reset-password. */
    sendPasswordReset: async (email) => {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      return error ? { error: error.message } : {}
    },
    setNewPassword: async (password) => {
      const { error } = await supabase.auth.updateUser({ password })
      return error ? { error: error.message } : {}
    },
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
