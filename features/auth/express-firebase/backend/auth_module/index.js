'use strict'
// Drop-in Firebase auth for Express.
//
//   const { setupAuth, requireAuth } = require('./auth_module')      // or: import { setupAuth } from './auth_module/index.js'
//
//   setupAuth(app)                                  // mounts /api/auth/me and /api/auth/register
//   app.get('/api/things', requireAuth, (req, res) => res.json({ uid: req.user.uid }))

const { setupAuth } = require('./setup')
const { configure, requireAuth, optionalAuth, requireVerifiedEmail } = require('./core')
const { initFirebase } = require('./firebase')

exports.setupAuth = setupAuth
exports.configure = configure
exports.requireAuth = requireAuth
exports.optionalAuth = optionalAuth
exports.requireVerifiedEmail = requireVerifiedEmail
exports.initFirebase = initFirebase
