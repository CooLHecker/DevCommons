const MESSAGES = {
  'auth/invalid-email': 'That email address does not look right.',
  'auth/missing-email': 'Please enter your email address.',
  'auth/operation-not-allowed':
    'This sign-in method is not enabled. In the Firebase console go to Authentication → Sign-in method and enable it.',
  'auth/unauthorized-domain':
    'This domain is not authorized. Add it in Firebase console → Authentication → Settings → Authorized domains.',
  'auth/expired-action-code':
    'This link has expired (reset links last 1 hour). Request a new one and open it straight away.',
  'auth/invalid-action-code':
    'This link is invalid or has already been used. Request a new one and open only the newest email.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/user-not-found': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/email-already-in-use': 'An account with this email already exists.',
  'auth/weak-password': 'Choose a stronger password (at least 8 characters).',
  'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
  'auth/network-request-failed': 'Network error. Check your connection and try again.',
  'auth/popup-closed-by-user': 'The sign-in window was closed before finishing.',
  'auth/cancelled-popup-request': 'The sign-in window was closed before finishing.',
  'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups and try again.',
  'auth/account-exists-with-different-credential':
    'An account already exists with this email using a different sign-in method.',
}

export const defaultErrorMessages = MESSAGES

/** `overrides` maps Firebase error codes to your own text: { 'auth/user-not-found': '...' }. */
export function friendlyError(err, overrides = {}) {
  return overrides[err?.code] || MESSAGES[err?.code] || err?.message || 'Something went wrong. Please try again.'
}
