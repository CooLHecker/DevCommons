// Inline: the ready-made screens inside an app that already has a header and layout. Open with  ?demo=inline
// Shows labels, classNames, a logo slot, and a custom login form via renderForm.
import { AuthGate, SignOutButton } from '../auth'

export default function InlineDemo() {
  return (
    <div style={{ fontFamily: 'Georgia, serif' }}>
      <header style={{ padding: '12px 24px', background: '#0b3d2e', color: '#fff', display: 'flex', justifyContent: 'space-between' }}>
        <strong>Acme Garden Shop</strong>
        <nav>Plants · Tools · Help</nav>
      </header>

      <div style={{ maxWidth: 960, margin: '32px auto', padding: '0 16px' }}>
        <h2>Your orders</h2>
        <p>Sign in to see them.</p>

        <AuthGate
          layout="inline"
          logo={<span style={{ fontSize: 32 }} aria-hidden>🌱</span>}
          labels={{
            login: { title: 'Welcome back, gardener', subtitle: 'Sign in to see your orders', submit: 'Let me in' },
            register: { title: 'Join Acme Garden', submit: 'Plant my account' },
          }}
          classNames={{ card: 'acme-card', primary: 'acme-primary' }}
          renderForm={{
            // Replace just the sign-in form; the card, title and footer links stay as they are.
            login: (f) => (
              <form onSubmit={f.submit} style={{ display: 'grid', gap: 8, marginTop: 16 }}>
                <input placeholder={f.labels.common.email} value={f.email} onChange={(e) => f.setEmail(e.target.value)} />
                <input placeholder={f.labels.common.password} type="password" value={f.password} onChange={(e) => f.setPassword(e.target.value)} />
                {f.error && <small role="alert">{f.error}</small>}
                <button disabled={!f.canSubmit}>{f.labels.login.submit}</button>
              </form>
            ),
          }}
        >
          <p>Signed in. <SignOutButton /></p>
        </AuthGate>
      </div>
    </div>
  )
}
