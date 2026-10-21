// Every string the sign-in screens show. Pass only what you want to change:
//   <AuthGate labels={{ login: { title: 'Hi again' }, register: { submit: 'Join' } }}>
// Headless users can read the same defaults for their own forms.

export const defaultLabels = {
  common: {
    email: 'Email',
    password: 'Password',
    or: 'or',
    loading: 'Loading…',
    passwordHint: (min) => `At least ${min} characters`,
  },
  login: {
    title: 'Welcome back',
    subtitle: 'Sign in to continue',
    submit: 'Sign in',
    busy: 'Signing in…',
    forgot: 'Forgot password?',
    google: 'Continue with Google',
    footerPrompt: 'New here?',
    footerLink: 'Create an account',
  },
  register: {
    title: 'Create your account',
    subtitle: 'It only takes a minute',
    name: 'Full name',
    confirm: 'Confirm password',
    submit: 'Create account',
    busy: 'Creating account…',
    google: 'Sign up with Google',
    footerPrompt: 'Already have an account?',
    footerLink: 'Sign in',
  },
  forgot: {
    title: 'Reset your password',
    subtitle: "We'll email you a reset link",
    submit: 'Send reset link',
    busy: 'Sending…',
    sentBefore: 'If an account exists for',
    sentAfter: ', a reset link is on its way.',
    back: 'Back to sign in',
  },
  reset: {
    title: 'Choose a new password',
    checking: 'Checking your link…',
    newPassword: 'New password',
    confirm: 'Confirm new password',
    submit: 'Update password',
    busy: 'Saving…',
    requestNew: 'Request a new reset link',
    doneBefore: 'Your password was updated.',
    doneLink: 'Sign in',
    doneAfter: 'with the new password.',
    back: 'Back to sign in',
    missingCode: 'This page must be opened from the link in your reset email.',
  },
  validation: {
    passwordTooShort: (min) => `Password must be at least ${min} characters.`,
    passwordMismatch: 'Passwords do not match.',
  },
  /** Firebase error code -> text, e.g. { 'auth/user-not-found': '...' }. Falls back to the built-in messages. */
  errors: {},
}

/** Merge your overrides into the defaults, one level per page. */
export function mergeLabels(overrides = {}) {
  const out = {}
  for (const key of Object.keys(defaultLabels)) out[key] = { ...defaultLabels[key], ...(overrides?.[key] ?? {}) }
  return out
}
