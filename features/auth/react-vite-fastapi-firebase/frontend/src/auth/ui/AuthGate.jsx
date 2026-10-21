import { useContext, useState } from 'react'
import { AuthContext, AuthProvider, useAuth } from '../core/AuthContext'
import { mergeLabels } from '../core/labels'
import LoginPage from './LoginPage'
import RegisterPage from './RegisterPage'
import ForgotPasswordPage from './ForgotPasswordPage'
import ResetPasswordPage from './ResetPasswordPage'
import './auth.css'

/** Firebase's password-reset email links to  <site>?mode=resetPassword&oobCode=...  */
function initialView() {
  if (typeof window === 'undefined') return 'login' // server render
  const q = new URLSearchParams(window.location.search)
  return q.get('mode') === 'resetPassword' && q.get('oobCode') ? 'reset' : 'login'
}

function Gate({ children, showGoogle = true, askName = true, initial, loadingFallback, renderForm, ...pageProps }) {
  const { user, loading } = useAuth()
  const [view, setView] = useState(() => initial || initialView())

  function go(next) {
    if (view === 'reset' && next !== 'reset' && typeof window !== 'undefined') {
      // Drop ?oobCode=... from the address bar once the reset flow is over.
      window.history.replaceState({}, '', window.location.pathname + window.location.hash)
    }
    setView(next)
  }

  if (loading) {
    if (loadingFallback !== undefined) return loadingFallback
    const inline = pageProps.layout === 'inline'
    return <div className={`auth-loading${inline ? ' auth-loading--inline' : ''}`} role="status">{mergeLabels(pageProps.labels).common.loading}</div>
  }
  if (view === 'reset') return <ResetPasswordPage onNavigate={go} {...pageProps} renderForm={renderForm?.reset} />
  if (user) return children

  if (view === 'register') return <RegisterPage onNavigate={go} showGoogle={showGoogle} askName={askName} {...pageProps} renderForm={renderForm?.register} />
  if (view === 'forgot') return <ForgotPasswordPage onNavigate={go} {...pageProps} renderForm={renderForm?.forgot} />
  return <LoginPage onNavigate={go} showGoogle={showGoogle} {...pageProps} renderForm={renderForm?.login} />
}

/**
 * The whole feature in one component. Signed out: shows login / register / forgot / reset.
 * Signed in: renders `children`.
 *
 *   <AuthGate>
 *     <App />
 *   </AuthGate>
 *
 * No router needed. Inside `children`, use useAuth(), <SignOutButton/> and authFetch().
 * Can be used around a whole app or around just the private part of it.
 *
 * Props:
 *   showGoogle           "Continue with Google" button (default true)
 *   askName              "Full name" field on the register form (default true)
 *   syncBackend          POST /auth/register after sign-up (default true)
 *   verifyEmailOnSignUp  send Firebase's verification email after sign-up (default true)
 *
 * Look and wording (all optional, passed to every screen):
 *   labels           override any text: { login: { title: 'Hi again' } }  (see core/labels.js)
 *   classNames       extra classes per element: { card: 'shadow-xl', primary: 'btn btn-dark' }
 *   layout           'fullscreen' (default) | 'inline' (renders inside your own container) | 'modal'
 *   logo, header     slots above / instead of the title block
 *   onClose          modal layout: called on Escape / backdrop click
 *   loadingFallback  what to show while Firebase restores the session
 *   renderForm       draw a form yourself, per screen: { login: (form) => ..., register: ..., forgot: ..., reset: ... }
 */
export default function AuthGate({ children, syncBackend, verifyEmailOnSignUp, ...gateProps }) {
  const existingProvider = useContext(AuthContext)
  const gate = <Gate {...gateProps}>{children}</Gate>

  if (existingProvider) return gate
  return (
    <AuthProvider syncBackend={syncBackend} verifyEmailOnSignUp={verifyEmailOnSignUp}>
      {gate}
    </AuthProvider>
  )
}
