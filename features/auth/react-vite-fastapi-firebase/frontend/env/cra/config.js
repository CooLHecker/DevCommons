// Where the auth code reads its settings from. This is the Create React App version
// (process.env.REACT_APP_*). devcommons installs it as src/auth/config.js when it finds react-scripts.
// Create React App replaces these reads at build time, so each one has to be written out in full.

export const API_URL = process.env.REACT_APP_API_URL || '/api'

export const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID,
}
