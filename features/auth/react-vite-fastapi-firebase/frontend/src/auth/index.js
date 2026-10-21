// The one-liner:  <AuthGate><App /></AuthGate>
export { default as AuthGate } from './ui/AuthGate'

// Use inside your app:
export { useAuth } from './core/AuthContext'
export { default as SignOutButton } from './ui/SignOutButton'
export { authFetch } from './core/api'

// Lower-level pieces, if you want to build your own layout or routing:
export { AuthProvider } from './core/AuthContext'
export { default as LoginPage } from './ui/LoginPage'
export { default as RegisterPage } from './ui/RegisterPage'
export { default as ForgotPasswordPage } from './ui/ForgotPasswordPage'
export { default as ResetPasswordPage } from './ui/ResetPasswordPage'
export { auth } from './core/firebase'

// Headless pieces (use them to render the forms with your own components):
export { useLoginForm, useRegisterForm, useForgotPasswordForm, useResetPasswordForm, MIN_PASSWORD } from './core/forms'
export { defaultLabels, mergeLabels } from './core/labels'
export { friendlyError, defaultErrorMessages } from './core/errors'
