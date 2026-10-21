'use strict'
// Firebase Admin initialisation. Credentials are resolved in this order:
//   1. FIREBASE_CREDENTIALS_JSON       the service-account JSON as a string (good for hosting platforms)
//   2. GOOGLE_APPLICATION_CREDENTIALS  path to the service-account JSON file
//   3. Application Default Credentials only when FIREBASE_PROJECT_ID is also set (Cloud Run etc.)
// A .env in the folder you start node from is loaded (dotenv if installed, else Node's own loader).

const fs = require('node:fs')
const path = require('node:path')

function loadEnv() {
  try {
    require('dotenv').config()
  } catch {
    try {
      if (typeof process.loadEnvFile === 'function') process.loadEnvFile()
    } catch {
      /* no .env file: plain environment variables still work */
    }
  }
}

function adminApp() {
  try {
    return require('firebase-admin/app')
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') throw new Error('[auth_module] firebase-admin is not installed. Run: npm install firebase-admin')
    throw err
  }
}

/** Initialise Firebase Admin once. Throws an Error with a clear message when misconfigured. */
function initFirebase() {
  loadEnv()
  const { getApps, initializeApp, cert, applicationDefault } = adminApp()
  if (getApps().length) return getApps()[0]

  const rawJson = process.env.FIREBASE_CREDENTIALS_JSON
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT
  let credential
  let options = {}
  let known

  if (rawJson) {
    const key = JSON.parse(rawJson)
    credential = cert(key)
    known = key.project_id
  } else if (keyPath) {
    const file = path.resolve(keyPath)
    if (!fs.existsSync(file)) {
      throw new Error(
        `[auth_module] GOOGLE_APPLICATION_CREDENTIALS points to '${keyPath}', but no such file exists (current folder: ${process.cwd()}). ` +
          'Use an absolute path, or start the server from the folder that contains the key.',
      )
    }
    credential = cert(file)
    known = JSON.parse(fs.readFileSync(file, 'utf8')).project_id
  } else if (projectId) {
    credential = applicationDefault()
    options = { projectId }
    known = projectId
  } else {
    throw new Error(
      '[auth_module] No Firebase credentials found. Put GOOGLE_APPLICATION_CREDENTIALS=<path to service account JSON> ' +
        '(or FIREBASE_CREDENTIALS_JSON) in .env. Download the key from Firebase console -> Project settings -> Service accounts -> Generate new private key.',
    )
  }
  if (!known) throw new Error('[auth_module] Firebase initialised without a project ID. Use a service-account key, or set FIREBASE_PROJECT_ID.')

  const app = initializeApp({ credential, ...options })
  // Must equal the project id in the frontend's Firebase config, or every token is rejected.
  console.log(`[auth_module] Firebase Admin initialised for project: ${known}`)
  return app
}

/** Verify a Firebase ID token and return its decoded claims. Rejects with a firebase-admin error (core.js maps it to 401). */
async function verifyIdToken(token) {
  initFirebase()
  const { getAuth } = require('firebase-admin/auth')
  const checkRevoked = String(process.env.AUTH_CHECK_REVOKED || 'false').toLowerCase() === 'true'
  return getAuth().verifyIdToken(token, checkRevoked)
}

module.exports = { initFirebase, verifyIdToken }
