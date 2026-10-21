'use strict'
// Framework-light core: turns a Bearer token into a user and answers the auth contract
// (contracts/auth). Only uses req.headers, res.status().json() and res.setHeader(), so it works with
// any Express-compatible app and can be tested without Express.

const debug = () => String(process.env.AUTH_DEBUG || 'false').toLowerCase() === 'true'

const state = { verifyToken: null, onRegister: null }

/** Set the callbacks. Called by setupAuth; call it yourself only if you mount the routes by hand. */
function configure({ verifyToken, onRegister } = {}) {
  if (verifyToken !== undefined) state.verifyToken = verifyToken
  if (onRegister !== undefined) state.onRegister = onRegister
}

function unauthorized(res, detail) {
  res.setHeader('WWW-Authenticate', 'Bearer')
  return res.status(401).json({ detail })
}

/** The token from "Authorization: Bearer <token>", or null. */
function bearerToken(req) {
  const header = req.headers && req.headers.authorization
  if (typeof header !== 'string') return null
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return m ? m[1] : null
}

/** Firebase claims -> the user shape in the contract (same fields as the FastAPI variant). */
function userFromClaims(claims) {
  return {
    uid: claims.uid,
    email: claims.email ?? null,
    email_verified: Boolean(claims.email_verified),
    name: claims.name ?? null,
    picture: claims.picture ?? null,
    provider: (claims.firebase && claims.firebase.sign_in_provider) ?? null,
  }
}

/** Verify a token; returns { user } or { error: '<detail for the 401>' }. */
async function decode(token) {
  const verify = state.verifyToken || require('./firebase').verifyIdToken
  try {
    return { user: userFromClaims(await verify(token)) }
  } catch (err) {
    const code = err && err.code
    if (code === 'auth/id-token-expired') {
      console.warn(`[auth_module] Token rejected (expired): ${err.message}`)
      return { error: 'Token expired' }
    }
    if (code === 'auth/id-token-revoked') {
      console.warn(`[auth_module] Token rejected (revoked): ${err.message}`)
      return { error: 'Token revoked' }
    }
    // Anything else (wrong project, clock skew, no network to Google, ...): the real reason goes to the log.
    // AUTH_DEBUG=true also returns it in the response while developing.
    console.warn(`[auth_module] Token rejected (${code || (err && err.name)}): ${err && err.message}`)
    return { error: debug() ? `Invalid token: ${err && err.message}` : 'Invalid token' }
  }
}

/** Require a valid Firebase ID token: sets req.user, 401 otherwise. */
async function requireAuth(req, res, next) {
  try {
    const token = bearerToken(req)
    if (!token) return unauthorized(res, 'Missing bearer token')
    const { user, error } = await decode(token)
    if (error) return unauthorized(res, error)
    req.user = user
    return next()
  } catch (err) {
    return next(err)
  }
}

/** Sets req.user when a valid token is present; carries on as anonymous when there is none. */
async function optionalAuth(req, res, next) {
  try {
    const token = bearerToken(req)
    if (!token) return next()
    const { user, error } = await decode(token)
    if (error) return unauthorized(res, error)
    req.user = user
    return next()
  } catch (err) {
    return next(err)
  }
}

/** Use after requireAuth: 403 unless the user's email is verified. */
function requireVerifiedEmail(req, res, next) {
  if (!req.user || !req.user.email_verified) return res.status(403).json({ detail: 'Email not verified' })
  return next()
}

/** GET /auth/me */
function me(req, res) {
  return res.json(req.user)
}

/** POST /auth/register: called by the frontend right after sign-up. Your onRegister hook should be idempotent. */
async function register(req, res, next) {
  try {
    if (state.onRegister) await state.onRegister(req.user)
    return res.json(req.user)
  } catch (err) {
    return next(err)
  }
}

module.exports = { configure, bearerToken, userFromClaims, requireAuth, optionalAuth, requireVerifiedEmail, me, register }
