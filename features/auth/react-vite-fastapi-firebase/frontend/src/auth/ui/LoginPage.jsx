import { mergeLabels } from '../core/labels'
import { useLoginForm } from '../core/forms'
import AuthLayout, { GoogleIcon } from './AuthLayout'
import { classes } from './classes'

/**
 * Props (AuthGate fills most of these in; pass your own to use the page standalone):
 *   onNavigate(view)  called with 'register' or 'forgot'
 *   onSuccess()       optional, called after a successful sign-in
 *   showGoogle        show the "Continue with Google" button (default true)
 *   labels            override any text, e.g. { login: { title: 'Hi again' } }
 *   classNames, layout, logo, header, onClose   see AuthLayout
 *   renderForm(form)  replace the form with your own markup. `form` is useLoginForm()
 *                     plus { labels, navigate, showGoogle }
 */
export default function LoginPage({ onNavigate, onSuccess, showGoogle = true, labels, classNames, layout, logo, header, onClose, renderForm }) {
  const L = mergeLabels(labels)
  const c = classes(classNames)
  const form = useLoginForm({ onSuccess, labels })

  return (
    <AuthLayout
      title={L.login.title}
      subtitle={L.login.subtitle}
      {...{ classNames, layout, logo, header, onClose }}
      footer={
        <>
          {L.login.footerPrompt}{' '}
          <button type="button" className={c('link')} onClick={() => onNavigate?.('register')}>
            {L.login.footerLink}
          </button>
        </>
      }
    >
      {renderForm ? (
        renderForm({ ...form, labels: L, navigate: onNavigate, showGoogle })
      ) : (
        <>
          <form className={c('form')} onSubmit={form.submit} noValidate>
            <label className={c('field')}>
              <span>{L.common.email}</span>
              <input className={c('input')} type="email" autoComplete="email" value={form.email} onChange={(e) => form.setEmail(e.target.value)} required />
            </label>

            <label className={c('field')}>
              <span>{L.common.password}</span>
              <input className={c('input')} type="password" autoComplete="current-password" value={form.password} onChange={(e) => form.setPassword(e.target.value)} required />
            </label>

            <button type="button" className={`${c('link')} auth-link-right`} onClick={() => onNavigate?.('forgot')}>
              {L.login.forgot}
            </button>

            {form.error && <p className={c('error')} role="alert">{form.error}</p>}

            <button className={c('primary')} type="submit" disabled={!form.canSubmit}>
              {form.busy ? L.login.busy : L.login.submit}
            </button>
          </form>

          {showGoogle && (
            <>
              <div className={c('divider')}><span>{L.common.or}</span></div>
              <button className={c('secondary')} type="button" disabled={form.busy} onClick={form.signInWithGoogle}>
                <GoogleIcon /> {L.login.google}
              </button>
            </>
          )}
        </>
      )}
    </AuthLayout>
  )
}
