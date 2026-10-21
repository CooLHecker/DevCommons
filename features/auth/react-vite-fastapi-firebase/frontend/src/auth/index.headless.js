// Headless build: state, hooks and the API helper only. No markup, no CSS.
// Wrap your app once, then render your own screens with the form hooks:
//
//   <AuthProvider><App /></AuthProvider>
//   const { user, loading, logout } = useAuth()
//   const form = useLoginForm()

export { AuthProvider, useAuth } from './core/AuthContext'
export { authFetch } from './core/api'
export { auth } from './core/firebase'
export { useLoginForm, useRegisterForm, useForgotPasswordForm, useResetPasswordForm, MIN_PASSWORD } from './core/forms'
export { defaultLabels, mergeLabels } from './core/labels'
export { friendlyError, defaultErrorMessages } from './core/errors'
