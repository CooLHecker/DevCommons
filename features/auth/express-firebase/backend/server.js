'use strict'
// Demo app. In your own project you only need the lines marked  // <-- add.
const express = require('express')
const { setupAuth, requireAuth } = require('./auth_module') // <-- add

const app = express()

setupAuth(app, {
  // <-- add: loads credentials, enables CORS, mounts /api/auth/*
  corsOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(','),
  // Optional: persist users in your own DB when they sign up.
  onRegister: async (user) => console.log(`New user registered: ${user.uid} (${user.email})`),
})

app.get('/api/health', (req, res) => res.json({ status: 'ok' }))

// Example of a protected route in your own code.
app.get('/api/secret', requireAuth, (req, res) => {
  res.json({ message: `Hello ${req.user.name || req.user.email}, this is protected data.` })
})

const port = Number(process.env.PORT) || 8000
app.listen(port, () => console.log(`demo listening on http://localhost:${port}`))
