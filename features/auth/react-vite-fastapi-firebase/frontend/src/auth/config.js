// Where the auth code reads its settings from. This is the Vite version (import.meta.env).
// devcommons installs the matching file for your bundler (Create React App: REACT_APP_*).
// Bundlers replace these reads at build time, so each one has to be written out in full.

export const API_URL = import.meta.env.VITE_API_URL || '/api'

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}
