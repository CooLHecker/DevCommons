// Slow check (needs network for npm): install the express-firebase variant into a fresh Express project
// with the real CLI, run it on REAL Express with a fake token verifier, and run the auth contract
// checks (contracts/auth/conformance.mjs) against it.
//
//   node test/conformance-express.mjs     (npm run test:conformance)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { CLI } from './helpers.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-conf-express-'))
const api = path.join(root, 'api')
fs.mkdirSync(api, { recursive: true })
fs.writeFileSync(path.join(api, 'package.json'), JSON.stringify({ name: 'fixture', private: true, dependencies: { express: '^4.19.2' } }))
const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error(`$ ${cmd} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`)
    process.exit(1)
  }
  return r.stdout
}

sh('npm', ['install', '--no-audit', '--no-fund'], api)
// copy only (explicit folder, no --patch): the server below calls setupAuth itself so it can use a fake verifier
sh('node', [CLI, 'add', 'auth', 'express-firebase', '--backend', api], root)

fs.writeFileSync(
  path.join(api, 'server.js'),
  `const express = require('express')
const { setupAuth } = require('./auth_module')
const app = express()
setupAuth(app, {
  verifyToken: async (t) => {
    if (t === 'good') return { uid: 'u1', email: 'a@b.co', email_verified: true, firebase: { sign_in_provider: 'password' } }
    throw Object.assign(new Error('bad token'), { code: 'auth/argument-error' })
  },
})
app.listen(Number(process.env.PORT), () => console.log('listening'))
`,
)

const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, () => {
    const p = s.address().port
    s.close(() => resolve(p))
  })
})
const server = spawn('node', ['server.js'], { cwd: api, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve) => server.stdout.on('data', (d) => String(d).includes('listening') && resolve()))

const url = `http://127.0.0.1:${port}`
const conformance = path.join(path.dirname(CLI), '..', 'contracts', 'auth', 'conformance.mjs')
const plain = spawnSync('node', [conformance, url], { encoding: 'utf8' })
const withToken = spawnSync('node', [conformance, url, '--token', 'good'], { encoding: 'utf8' })
server.kill()
process.stdout.write(plain.stdout + withToken.stdout)
process.exit(plain.status === 0 && withToken.status === 0 ? 0 : 1)
