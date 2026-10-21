import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  GoogleAuthProvider,
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  getAdditionalUserInfo,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  verifyPasswordResetCode,
} from 'firebase/auth'
import { auth } from './firebase'
import { authFetch } from './api'

export const AuthContext = createContext(null)

/**
 * Normally you don't need this: <AuthGate> adds it for you. Use it directly only if you
 * build your own login screens.
 *
 * Props:
 *   syncBackend         POST /auth/register to your backend after sign-up (default true)
 *   verifyEmailOnSignUp send Firebase's verification email after sign-up (default true)
 */
export function AuthProvider({ children, syncBackend = true, verifyEmailOnSignUp = true }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0) // bumps when the profile changes in place

  useEffect(
    () =>
      onAuthStateChanged(auth, (firebaseUser) => {
        setUser(firebaseUser)
        setLoading(false)
      }),
    [],
  )

  const registerWithBackend = useCallback(async () => {
    if (!syncBackend) return
    try {
      await authFetch('/auth/register', { method: 'POST' })
    } catch (err) {
      // The Firebase account exists either way; don't block the user on a backend hiccup.
      console.warn('[auth] backend registration failed:', err.message)
    }
  }, [syncBackend])

  const signIn = useCallback(
    (email, password) => signInWithEmailAndPassword(auth, email, password),
    [],
  )

  const signUp = useCallback(
    async (email, password, displayName) => {
      const cred = await createUserWithEmailAndPassword(auth, email, password)
      if (displayName) {
        await updateProfile(cred.user, { displayName })
        await cred.user.getIdToken(true) // refresh so the new name is in the token
      }
      if (verifyEmailOnSignUp) {
        sendEmailVerification(cred.user).catch(() => {})
      }
      await registerWithBackend()
      setRevision((n) => n + 1)
      return cred
    },
    [registerWithBackend, verifyEmailOnSignUp],
  )

  const signInWithGoogle = useCallback(async () => {
    const result = await signInWithPopup(auth, new GoogleAuthProvider())
    if (getAdditionalUserInfo(result)?.isNewUser) await registerWithBackend()
    return result
  }, [registerWithBackend])

  const resetPassword = useCallback((email) => sendPasswordResetEmail(auth, email), [])
  // Used by <ResetPasswordPage/>: check the emailed code (returns the email), then set the new password.
  const verifyResetCode = useCallback((code) => verifyPasswordResetCode(auth, code), [])
  const confirmReset = useCallback((code, newPassword) => confirmPasswordReset(auth, code, newPassword), [])
  const logout = useCallback(() => signOut(auth), [])

  const value = useMemo(
    () => ({
      user,
      loading,
      signIn,
      signUp,
      signInWithGoogle,
      resetPassword,
      verifyResetCode,
      confirmReset,
      logout,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, loading, revision, signIn, signUp, signInWithGoogle, resetPassword, verifyResetCode, confirmReset, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
