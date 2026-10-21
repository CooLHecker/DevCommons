import { mergeLabels } from '../core/labels'
import { useResetPasswordForm } from '../core/forms'
import AuthLayout from './AuthLayout'
import { classes } from './classes'

/**
 * Landing page for the link in Firebase's "reset password" email. AuthGate shows it
 * automatically when the URL contains ?mode=resetPassword&oobCode=...
 *
 * Props: onNavigate(view) is called with 'login' or 'forgot'; code overrides the oobCode read from the URL;
 *   minPassword, labels, classNames, layout, logo, header, onClose, renderForm   see LoginPage
 */
export default function ResetPasswordPage({ onNavigate, code, minPassword, labels, classNames, layout, logo, header, onClose, renderForm }) {
  const L = mergeLabels(labels)
  const c = classes(classNames)
  const form = useResetPasswordForm({ code, labels, minPassword })
  const toLogin = (text) => (
    <button type="button" className={c('link')} onClick={() => onNavigate?.('login')}>
      {text}
    </button>
  )

  return (
    <AuthLayout
      title={L.reset.title}
      subtitle={form.status === 'ready' ? form.email : undefined}
      footer={toLogin(L.reset.back)}
      {...{ classNames, layout, logo, header, onClose }}
    >
      {renderForm ? (
        renderForm({ ...form, labels: L, navigate: onNavigate })
      ) : (
        <>
          {form.status === 'checking' && <p className={c('success')} role="status">{L.reset.checking}</p>}

          {form.status === 'invalid' && (
            <>
              <p className={c('error')} role="alert" style={{ marginTop: 24 }}>{form.error}</p>
              <p style={{ marginTop: 16 }}>
                <button type="button" className={c('link')} onClick={() => onNavigate?.('forgot')}>
                  {L.reset.requestNew}
                </button>
              </p>
            </>
          )}

          {form.status === 'done' && (
            <p className={c('success')} role="status">
              {L.reset.doneBefore} {toLogin(L.reset.doneLink)} {L.reset.doneAfter}
            </p>
          )}

          {form.status === 'ready' && (
            <form className={c('form')} onSubmit={form.submit} noValidate>
              <label className={c('field')}>
                <span>{L.reset.newPassword}</span>
                <input className={c('input')} type="password" autoComplete="new-password" value={form.password} onChange={(e) => form.setPassword(e.target.value)} required />
                <small>{L.common.passwordHint(form.minPassword)}</small>
              </label>

              <label className={c('field')}>
                <span>{L.reset.confirm}</span>
                <input className={c('input')} type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => form.setConfirm(e.target.value)} required />
              </label>

              {form.error && <p className={c('error')} role="alert">{form.error}</p>}

              <button className={c('primary')} type="submit" disabled={!form.canSubmit}>
                {form.busy ? L.reset.busy : L.reset.submit}
              </button>
            </form>
          )}
        </>
      )}
    </AuthLayout>
  )
}
