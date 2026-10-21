// Headless: your own components, devcommons' logic. Open the demo with  ?demo=headless
// Only core pieces are imported: AuthProvider, useAuth and the form hooks. No auth.css, no ui/.
import { AuthProvider, useAuth, useLoginForm, useRegisterForm } from '../auth'
import { useState } from 'react'

// Stand-ins for your design system's <Input> and <Button> (MUI, shadcn, Tailwind components...).
const Input = ({ label, ...props }) => (
  <label style={{ display: 'grid', gap: 4, fontSize: 14 }}>
    {label}
    <input {...props} style={{ padding: 8, border: '2px solid #222', borderRadius: 0 }} />
  </label>
)
const Button = (props) => <button {...props} style={{ padding: '8px 12px', background: '#222', color: '#fff', border: 0, cursor: 'pointer' }} />

function LoginForm({ onRegister }) {
  const f = useLoginForm()
  return (
    <form onSubmit={f.submit} style={{ display: 'grid', gap: 12, maxWidth: 320 }}>
      <h2>Log in</h2>
      <Input label="Email" type="email" value={f.email} onChange={(e) => f.setEmail(e.target.value)} />
      <Input label="Password" type="password" value={f.password} onChange={(e) => f.setPassword(e.target.value)} />
      {f.error && <p style={{ color: 'crimson' }}>{f.error}</p>}
      <Button disabled={!f.canSubmit}>{f.busy ? '…' : 'Log in'}</Button>
      <Button type="button" onClick={f.signInWithGoogle}>Google</Button>
      <a href="#register" onClick={(e) => (e.preventDefault(), onRegister())}>Need an account?</a>
    </form>
  )
}

function RegisterForm({ onLogin }) {
  const f = useRegisterForm()
  return (
    <form onSubmit={f.submit} style={{ display: 'grid', gap: 12, maxWidth: 320 }}>
      <h2>Sign up</h2>
      <Input label="Name" value={f.name} onChange={(e) => f.setName(e.target.value)} />
      <Input label="Email" type="email" value={f.email} onChange={(e) => f.setEmail(e.target.value)} />
      <Input label={`Password (min ${f.minPassword})`} type="password" value={f.password} onChange={(e) => f.setPassword(e.target.value)} />
      <Input label="Repeat password" type="password" value={f.confirm} onChange={(e) => f.setConfirm(e.target.value)} />
      {f.error && <p style={{ color: 'crimson' }}>{f.error}</p>}
      <Button disabled={!f.canSubmit}>Create account</Button>
      <a href="#login" onClick={(e) => (e.preventDefault(), onLogin())}>I already have one</a>
    </form>
  )
}

function Screen() {
  const { user, loading, logout } = useAuth()
  const [view, setView] = useState('login')
  if (loading) return <p>Loading…</p>
  if (user) return (
    <>
      <p>Hello {user.displayName || user.email}</p>
      <Button onClick={logout}>Log out</Button>
    </>
  )
  return view === 'login' ? <LoginForm onRegister={() => setView('register')} /> : <RegisterForm onLogin={() => setView('login')} />
}

export default function HeadlessDemo() {
  return (
    <AuthProvider>
      <main style={{ padding: 32, fontFamily: 'system-ui, sans-serif' }}>
        <Screen />
      </main>
    </AuthProvider>
  )
}
