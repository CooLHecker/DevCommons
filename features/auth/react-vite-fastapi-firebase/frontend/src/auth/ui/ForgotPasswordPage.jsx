import { mergeLabels } from '../core/labels'
import { useForgotPasswordForm } from '../core/forms'
import AuthLayout from './AuthLayout'
import { classes } from './classes'

/**
 * Props (AuthGate fills most of these in): onNavigate(view) is called with 'login'.
 *   labels, classNames, layout, logo, header, onClose, renderForm   see LoginPage
 */
export default function ForgotPasswordPage({ onNavigate, labels, classNames, layout, logo, header, onClose, renderForm }) {
  const L = mergeLabels(labels)
  const c = classes(classNames)
  const form = useForgotPasswordForm({ labels })

  return (
    <AuthLayout
      title={L.forgot.title}
      subtitle={L.forgot.subtitle}
      {...{ classNames, layout, logo, header, onClose }}
      footer={
        <button type="button" className={c('link')} onClick={() => onNavigate?.('login')}>
          {L.forgot.back}
        </button>
      }
    >
      {renderForm ? (
        renderForm({ ...form, labels: L, navigate: onNavigate })
      ) : form.sent ? (
        <p className={c('success')} role="status">
          {L.forgot.sentBefore} <strong>{form.email}</strong>{L.forgot.sentAfter}
        </p>
      ) : (
        <form className={c('form')} onSubmit={form.submit} noValidate>
          <label className={c('field')}>
            <span>{L.common.email}</span>
            <input className={c('input')} type="email" autoComplete="email" value={form.email} onChange={(e) => form.setEmail(e.target.value)} required />
          </label>

          {form.error && <p className={c('error')} role="alert">{form.error}</p>}

          <button className={c('primary')} type="submit" disabled={!form.canSubmit}>
            {form.busy ? L.forgot.busy : L.forgot.submit}
          </button>
        </form>
      )}
    </AuthLayout>
  )
}
