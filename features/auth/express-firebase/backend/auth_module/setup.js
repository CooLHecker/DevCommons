'use strict'
const { configure, requireAuth, me, register } = require('./core')

/** Minimal CORS for the origins you list (skip corsOrigins if your app already uses the "cors" package). */
function corsFor(origins) {
  const allowed = new Set(origins)
  return (req, res, next) => {
    const origin = req.headers.origin
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    }
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Authorization,Content-Type')
      res.statusCode = 204
      return res.end()
    }
    return next()
  }
}

/**
 * One call to add auth to an Express app:
 *
 *   setupAuth(app)                                           // minimal
 *   setupAuth(app, { corsOrigins: ['http://localhost:5173'] })  // also enable CORS for your frontend
 *
 * - loads the Firebase credentials (throws with a clear message at startup if they are missing)
 * - mounts GET {prefix}/auth/me and POST {prefix}/auth/register (the contract in contracts/auth)
 * - optionally adds CORS; optionally registers onRegister(user) (sync or async) to save new users
 * - verifyToken(token) -> claims replaces Firebase verification (tests, other identity providers)
 */
function setupAuth(app, { prefix = '/api', corsOrigins, onRegister, verifyToken } = {}) {
  if (!verifyToken) require('./firebase').initFirebase()
  configure({ verifyToken: verifyToken ?? null, onRegister: onRegister ?? null })
  if (corsOrigins && corsOrigins.length) app.use(corsFor(corsOrigins))
  app.get(`${prefix}/auth/me`, requireAuth, me)
  app.post(`${prefix}/auth/register`, requireAuth, register)
}

module.exports = { setupAuth }
