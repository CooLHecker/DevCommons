import { useEffect, useState } from 'react'
import { AuthGate, SignOutButton, authFetch, useAuth } from './auth'
import HeadlessDemo from './examples/HeadlessDemo'
import InlineDemo from './examples/InlineDemo'

/** Demo page: proves the token round-trip works against the FastAPI backend. */
function Dashboard() {
  const { user } = useAuth()
  const [profile, setProfile] = useState(null)
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    authFetch('/auth/me').then(setProfile).catch((e) => setError(e.message))
    authFetch('/secret').then((d) => setSecret(d.message)).catch(() => {})
  }, [])

  return (
    <main style={{ maxWidth: 560, margin: '64px auto', padding: '0 16px', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Signed in 🎉</h1>
      <p>{user.displayName || user.email}</p>
      {!user.emailVerified && <p><em>Check your inbox to verify your email.</em></p>}

      <h2>Backend says</h2>
      {error && <p style={{ color: 'crimson' }}>Backend error: {error}</p>}
      {secret && <p>{secret}</p>}
      {profile && <pre style={{ background: '#0001', padding: 12, borderRadius: 8 }}>{JSON.stringify(profile, null, 2)}</pre>}

      <SignOutButton />
    </main>
  )
}

// This is all the integration there is: wrap your app in <AuthGate>.
// (?demo=headless and ?demo=inline show the same auth core with your own components / inside an existing layout.)
export default function App() {
  const demo = new URLSearchParams(window.location.search).get('demo')
  if (demo === 'headless') return <HeadlessDemo />
  if (demo === 'inline') return <InlineDemo />
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  )
}
