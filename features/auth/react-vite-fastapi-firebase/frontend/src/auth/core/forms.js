// Headless form logic: everything the screens do, with no markup.
// The ready-made pages are built on these hooks; use them directly to render the forms with
// your own components (MUI, shadcn, plain inputs...).
//
//   const f = useLoginForm()
//   <form onSubmit={f.submit}>
//     <input value={f.email} onChange={(e) => f.setEmail(e.target.value)} />
//     ...
//     {f.error && <p>{f.error}</p>}
//     <button disabled={!f.canSubmit}>Sign in</button>
//   </form>

import { useEffect, useMemo, useState } from 'react'
import { useAuth } from './AuthContext'
import { friendlyError } from './errors'
import { mergeLabels } from './labels'

export const MIN_PASSWORD = 8

function useRunner(labels, onSuccess) {
  const L = useMemo(() => mergeLabels(labels), [labels])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(action) {
    setError('')
    setBusy(true)
    try {
      await action()
      onSuccess?.()
    } catch (err) {
      setError(friendlyError(err, L.errors))
      setBusy(false)
    }
  }
  return { L, error, setError, busy, setBusy, run }
}

/** Sign in with email + password or Google. Options: { onSuccess, labels } */
export function useLoginForm({ onSuccess, labels } = {}) {
  const { signIn, signInWithGoogle } = useAuth()
  const { error, busy, run } = useRunner(labels, onSuccess)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  return {
    email,
    setEmail,
    password,
    setPassword,
    error,
    busy,
    canSubmit: !busy && Boolean(email) && Boolean(password),
    submit: (e) => {
      e?.preventDefault?.()
      return run(() => signIn(email.trim(), password))
    },
    signInWithGoogle: () => run(signInWithGoogle),
  }
}

/** Create an account. Options: { onSuccess, labels, minPassword } */
export function useRegisterForm({ onSuccess, labels, minPassword = MIN_PASSWORD } = {}) {
  const { signUp, signInWithGoogle } = useAuth()
  const { L, error, setError, busy, run } = useRunner(labels, onSuccess)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  return {
    name,
    setName,
    email,
    setEmail,
    password,
    setPassword,
    confirm,
    setConfirm,
    minPassword,
    error,
    busy,
    canSubmit: !busy && Boolean(email) && Boolean(password) && Boolean(confirm),
    submit: (e) => {
      e?.preventDefault?.()
      if (password.length < minPassword) return setError(L.validation.passwordTooShort(minPassword))
      if (password !== confirm) return setError(L.validation.passwordMismatch)
      return run(() => signUp(email.trim(), password, name.trim()))
    },
    signInWithGoogle: () => run(signInWithGoogle),
  }
}

/** Ask for a password-reset email. Options: { labels }. `sent` turns true once the request is made. */
export function useForgotPasswordForm({ labels } = {}) {
  const { resetPassword } = useAuth()
  const L = useMemo(() => mergeLabels(labels), [labels])
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  return {
    email,
    setEmail,
    error,
    sent,
    busy,
    canSubmit: !busy && Boolean(email),
    submit: async (e) => {
      e?.preventDefault?.()
      setError('')
      setBusy(true)
      try {
        await resetPassword(email.trim())
        setSent(true)
      } catch (err) {
        // Don't reveal whether an account exists for this email.
        if (err?.code === 'auth/user-not-found') setSent(true)
        else setError(friendlyError(err, L.errors))
      } finally {
        setBusy(false)
      }
    },
  }
}

/**
 * Finish a password reset from the link in Firebase's email. Options: { code, labels, minPassword }.
 * `status` is 'checking' | 'ready' | 'invalid' | 'done'.
 */
export function useResetPasswordForm({ code: codeProp, labels, minPassword = MIN_PASSWORD } = {}) {
  const { verifyResetCode, confirmReset } = useAuth()
  const L = useMemo(() => mergeLabels(labels), [labels])
  const code = codeProp ?? (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('oobCode'))

  const [status, setStatus] = useState('checking')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!code) {
      setError(L.reset.missingCode)
      setStatus('invalid')
      return undefined
    }
    let cancelled = false
    verifyResetCode(code)
      .then((addr) => {
        if (cancelled) return
        setEmail(addr)
        setStatus('ready')
      })
      .catch((err) => {
        if (cancelled) return
        setError(friendlyError(err, L.errors))
        setStatus('invalid')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, verifyResetCode])

  return {
    status,
    email,
    password,
    setPassword,
    confirm,
    setConfirm,
    minPassword,
    error,
    busy,
    canSubmit: !busy && Boolean(password) && Boolean(confirm),
    submit: async (e) => {
      e?.preventDefault?.()
      if (password.length < minPassword) return setError(L.validation.passwordTooShort(minPassword))
      if (password !== confirm) return setError(L.validation.passwordMismatch)
      setError('')
      setBusy(true)
      try {
        await confirmReset(code, password)
        setStatus('done')
      } catch (err) {
        setError(friendlyError(err, L.errors))
        if (err?.code === 'auth/expired-action-code' || err?.code === 'auth/invalid-action-code') setStatus('invalid')
      } finally {
        setBusy(false)
      }
    },
  }
}
