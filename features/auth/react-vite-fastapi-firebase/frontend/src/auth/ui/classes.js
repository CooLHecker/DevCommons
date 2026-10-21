// Class names used by the ready-made screens. Add your own per element with the `classNames` prop:
//   <LoginPage classNames={{ card: 'shadow-xl', primary: 'bg-black text-white' }} />

const BASE = {
  page: 'auth-page',
  card: 'auth-card',
  header: 'auth-header',
  title: '',
  subtitle: '',
  form: 'auth-form',
  field: 'auth-field',
  input: '',
  error: 'auth-error',
  success: 'auth-success',
  footer: 'auth-footer',
  link: 'auth-linkbtn',
  primary: 'auth-btn auth-btn-primary',
  secondary: 'auth-btn auth-btn-secondary',
  divider: 'auth-divider',
}

/** classes(classNames)('card') -> 'auth-card <your extra classes>' (undefined when empty) */
export const classes = (extra = {}) => (key) => [BASE[key], extra?.[key]].filter(Boolean).join(' ') || undefined
