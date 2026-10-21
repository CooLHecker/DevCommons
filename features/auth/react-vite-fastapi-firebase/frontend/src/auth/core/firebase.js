import { initializeApp, getApps, getApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { firebaseConfig } from '../config'

// Reuse the app if your project already initialised Firebase elsewhere.
export const app = getApps().length ? getApp() : initializeApp(firebaseConfig)
export const auth = getAuth(app)
