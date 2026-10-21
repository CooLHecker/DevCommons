import { mergeLabels } from '../core/labels'
import { useRegisterForm } from '../core/forms'
import AuthLayout, { GoogleIcon } from './AuthLayout'
import { classes } from './classes'

/**
 * Props (AuthGate fills most of these in):
 *   onNavigate(view)  called with 'login'
 *   onSuccess()       optional, called after the account is created
 *   showGoogle        show the "Sign up with Google" button (default true)
 *   askName           show a "Full name" field (default true)
 *   minPassword       minimum password length (default 8)
 *   labels, classNames, layout, logo, header, onClose, renderForm   see LoginPage
 */
export default function RegisterPage({ onNavigate, onSuccess, showGoogle = true, askName = true, minPassword, labels, classNames, layout, logo, header, onClose, renderForm }) {
  const L = mergeLabels(labels)
  const c = classes(classNames)
  const form = useRegisterForm({ onSuccess, labels, minPassword })

  return (
    <AuthLayout
      title={L.register.title}
      subtitle={L.register.subtitle}
      {...{ classNames, layout, logo, header, onClose }}
      footer={
        <>
          {L.register.footerPrompt}{' '}
          <button type="button" className={c('link')} onClick={() => onNavigate?.('login')}>
            {L.register.footerLink}
          </button>
        </>
      }
    >
      {renderForm ? (
        renderForm({ ...form, labels: L, navigate: onNavigate, showGoogle, askName })
      ) : (
        <>
          <form className={c('form')} onSubmit={form.submit} noValidate>
            {askName && (
              <label className={c('field')}>
                <span>{L.register.name}</span>
                <input className={c('input')} type="text" autoComplete="name" value={form.name} onChange={(e) => form.setName(e.target.value)} />
              </label>
            )}

            <label className={c('field')}>
              <span>{L.common.email}</span>
              <input className={c('input')} type="email" autoComplete="email" value={form.email} onChange={(e) => form.setEmail(e.target.value)} required />
            </label>

            <label className={c('field')}>
              <span>{L.common.password}</span>
              <input className={c('input')} type="password" autoComplete="new-password" value={form.password} onChange={(e) => form.setPassword(e.target.value)} required />
              <small>{L.common.passwordHint(form.minPassword)}</small>
            </label>

            <label className={c('field')}>
              <span>{L.register.confirm}</span>
              <input className={c('input')} type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => form.setConfirm(e.target.value)} required />
            </label>

            {form.error && <p className={c('error')} role="alert">{form.error}</p>}

            <button className={c('primary')} type="submit" disabled={!form.canSubmit}>
              {form.busy ? L.register.busy : L.register.submit}
            </button>
          </form>

          {showGoogle && (
            <>
              <div className={c('divider')}><span>{L.common.or}</span></div>
              <button className={c('secondary')} type="button" disabled={form.busy} onClick={form.signInWithGoogle}>
                <GoogleIcon /> {L.register.google}
              </button>
            </>
          )}
        </>
      )}
    </AuthLayout>
  )
}
