import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fakeExpress } from './fake-express.mjs'

const require = createRequire(import.meta.url)
// async: the server under test lives in this process, so the checker must not block the event loop
const run = (args) => new Promise((resolve) => execFile('node', args, { encoding: 'utf8', timeout: 20000 }, (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })))
const MODULE = fileURLToPath(new URL('../features/auth/express-firebase/backend/auth_module', import.meta.url))
const CONFORMANCE = fileURLToPath(new URL('../contracts/auth/conformance.mjs', import.meta.url))
const auth = require(MODULE)
const core = require(path.join(MODULE, 'core.js'))

const CLAIMS = { uid: 'u1', email: 'a@b.co', email_verified: true, name: 'Ann', picture: null, firebase: { sign_in_provider: 'password' } }
const fakeVerify = async (token) => {
  if (token === 'good') return CLAIMS
  if (token === 'unverified') return { uid: 'u2', email: 'x@y.z', email_verified: false }
  if (token === 'expired') throw Object.assign(new Error('expired at noon'), { code: 'auth/id-token-expired' })
  if (token === 'revoked') throw Object.assign(new Error('revoked'), { code: 'auth/id-token-revoked' })
  throw Object.assign(new Error('wrong audience'), { code: 'auth/argument-error' })
}

async function serve(options = {}, extra = () => {}) {
  const app = fakeExpress()
  auth.setupAuth(app, { verifyToken: fakeVerify, ...options })
  extra(app)
  const server = await app.listen()
  return { ...server, get: (route, headers) => fetch(`${server.url}${route}`, { headers }), post: (route, headers) => fetch(`${server.url}${route}`, { method: 'POST', headers }) }
}

test('setupAuth mounts the two contract routes under the prefix', () => {
  const app = fakeExpress()
  auth.setupAuth(app, { verifyToken: fakeVerify, prefix: '/v2' })
  assert.deepEqual(app.routes.map((r) => `${r.method} ${r.path}`), ['GET /v2/auth/me', 'POST /v2/auth/register'])
})

test('the user shape matches the contract (snake_case, null when unknown)', async () => {
  const s = await serve()
  const res = await s.get('/api/auth/me', { Authorization: 'Bearer good' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { uid: 'u1', email: 'a@b.co', email_verified: true, name: 'Ann', picture: null, provider: 'password' })
  const bare = await s.get('/api/auth/me', { Authorization: 'bearer unverified' }) // scheme is case-insensitive
  assert.deepEqual(await bare.json(), { uid: 'u2', email: 'x@y.z', email_verified: false, name: null, picture: null, provider: null })
  await s.close()
})

test('401 answers: missing, wrong scheme, expired, revoked, invalid', async () => {
  const s = await serve()
  const cases = [
    [undefined, 'Missing bearer token'],
    ['Basic dXNlcjpwYXNz', 'Missing bearer token'],
    ['Bearer', 'Missing bearer token'],
    ['Bearer expired', 'Token expired'],
    ['Bearer revoked', 'Token revoked'],
    ['Bearer nonsense', 'Invalid token'],
  ]
  for (const [header, detail] of cases) {
    const res = await s.get('/api/auth/me', header ? { Authorization: header } : {})
    assert.equal(res.status, 401, String(header))
    assert.equal(res.headers.get('www-authenticate'), 'Bearer')
    assert.deepEqual(await res.json(), { detail }, String(header))
  }
  await s.close()
})

test('AUTH_DEBUG=true adds the real reason to "Invalid token"', async () => {
  const s = await serve()
  process.env.AUTH_DEBUG = 'true'
  try {
    const res = await s.get('/api/auth/me', { Authorization: 'Bearer nonsense' })
    assert.deepEqual(await res.json(), { detail: 'Invalid token: wrong audience' })
  } finally {
    delete process.env.AUTH_DEBUG
    await s.close()
  }
})

test('register runs onRegister (sync or async) with the user and returns it; a throwing hook is a 500, not a crash', async () => {
  const seen = []
  const s = await serve({ onRegister: async (u) => seen.push(u.uid) })
  const res = await s.post('/api/auth/register', { Authorization: 'Bearer good' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).uid, 'u1')
  assert.deepEqual(seen, ['u1'])
  assert.equal((await s.post('/api/auth/register', {})).status, 401)
  await s.close()

  const bad = await serve({ onRegister: () => { throw new Error('db down') } })
  const res2 = await bad.post('/api/auth/register', { Authorization: 'Bearer good' })
  assert.equal(res2.status, 500)
  await bad.close()
})

test('requireAuth / optionalAuth / requireVerifiedEmail on your own routes', async () => {
  const s = await serve({}, (app) => {
    app.get('/api/secret', auth.requireAuth, (req, res) => res.json({ uid: req.user.uid }))
    app.get('/api/maybe', auth.optionalAuth, (req, res) => res.json({ uid: req.user ? req.user.uid : null }))
    app.get('/api/verified', auth.requireAuth, auth.requireVerifiedEmail, (req, res) => res.json({ ok: true }))
  })
  assert.equal((await s.get('/api/secret', {})).status, 401)
  assert.deepEqual(await (await s.get('/api/secret', { Authorization: 'Bearer good' })).json(), { uid: 'u1' })
  assert.deepEqual(await (await s.get('/api/maybe', {})).json(), { uid: null })
  assert.deepEqual(await (await s.get('/api/maybe', { Authorization: 'Bearer good' })).json(), { uid: 'u1' })
  assert.equal((await s.get('/api/maybe', { Authorization: 'Bearer nonsense' })).status, 401) // a bad token is not "anonymous"
  assert.equal((await s.get('/api/verified', { Authorization: 'Bearer unverified' })).status, 403)
  assert.deepEqual(await (await s.get('/api/verified', { Authorization: 'Bearer unverified' })).json(), { detail: 'Email not verified' })
  assert.equal((await s.get('/api/verified', { Authorization: 'Bearer good' })).status, 200)
  await s.close()
})

test('corsOrigins: allowed origin gets headers, others do not, preflight is answered', async () => {
  const s = await serve({ corsOrigins: ['http://localhost:5173'] })
  const ok = await s.get('/api/auth/me', { Origin: 'http://localhost:5173' })
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173')
  const other = await s.get('/api/auth/me', { Origin: 'http://evil.test' })
  assert.equal(other.headers.get('access-control-allow-origin'), null)
  const pre = await fetch(`${s.url}/api/auth/me`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-headers'), 'authorization')
  await s.close()
})

test('without corsOrigins no CORS middleware is added (your own cors keeps working)', () => {
  const app = fakeExpress()
  let used = 0
  const origUse = app.use
  app.use = (fn) => { used++; origUse(fn) }
  auth.setupAuth(app, { verifyToken: fakeVerify })
  assert.equal(used, 0)
})

test('the contract conformance script passes against it (with and without a token)', async () => {
  const s = await serve({ verifyToken: async (t) => (t === 'good' ? CLAIMS : fakeVerify(t)) })
  const plain = await run([CONFORMANCE, s.url])
  const withToken = await run([CONFORMANCE, s.url, '--token', 'good'])
  await s.close()
  assert.equal(plain.status, 0, plain.stdout + plain.stderr)
  assert.match(plain.stdout, /all checks passed/)
  assert.match(plain.stdout, /skip  200 checks/)
  assert.equal(withToken.status, 0, withToken.stdout + withToken.stderr)
  assert.doesNotMatch(withToken.stdout, /skip/)
})

test('the conformance script fails a backend that breaks the contract', async () => {
  const app = fakeExpress()
  app.get('/api/auth/me', (req, res) => res.status(403).json({ message: 'nope' }))
  app.post('/api/auth/register', (req, res) => res.status(200).json({}))
  const s = await app.listen()
  const r = await run([CONFORMANCE, s.url])
  await s.close()
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL/)
})

test('bearerToken and userFromClaims', () => {
  assert.equal(core.bearerToken({ headers: { authorization: 'Bearer  abc ' } }), 'abc')
  assert.equal(core.bearerToken({ headers: { authorization: 'Bearer a b' } }), null)
  assert.equal(core.bearerToken({ headers: {} }), null)
  assert.equal(core.userFromClaims({ uid: 'x' }).email_verified, false)
})

test('missing credentials fail at startup with a clear message (no verifyToken given)', () => {
  const env = { ...process.env }
  for (const k of ['FIREBASE_CREDENTIALS_JSON', 'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_PROJECT_ID', 'GOOGLE_CLOUD_PROJECT']) delete env[k]
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-nocreds-'))
  const script = `try { require(${JSON.stringify(MODULE)}).setupAuth({ use() {}, get() {}, post() {} }) } catch (e) { console.log(e.message) }`
  const r = spawnSync('node', ['-e', script], { cwd, env, encoding: 'utf8' })
  assert.match(r.stdout, /firebase-admin is not installed|No Firebase credentials found/)
})

test('a key path that does not exist is named in the error', () => {
  // only meaningful when firebase-admin is installed; otherwise the install hint comes first, which is also clear
  const env = { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: './nope.json' }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-nokey-'))
  const script = `try { require(${JSON.stringify(MODULE)}).initFirebase() } catch (e) { console.log(e.message) }`
  const r = spawnSync('node', ['-e', script], { cwd, env, encoding: 'utf8' })
  assert.match(r.stdout, /nope\.json|firebase-admin is not installed/)
})

test('loads the same way from a CommonJS host and from an ES-module host', () => {
  for (const type of ['commonjs', 'module']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dc-host-${type}-`))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type }))
    fs.cpSync(MODULE, path.join(dir, 'auth_module'), { recursive: true })
    const file = type === 'module' ? 'main.js' : 'main.cjs'
    const body =
      type === 'module'
        ? "import { setupAuth, requireAuth } from './auth_module/index.js'\nconst routes = []\nsetupAuth({ use() {}, get: (p) => routes.push(p), post: (p) => routes.push(p) }, { verifyToken: async () => ({ uid: 'x' }) })\nconsole.log(typeof requireAuth, routes.join(','))\n"
        : "const { setupAuth, requireAuth } = require('./auth_module')\nconst routes = []\nsetupAuth({ use() {}, get: (p) => routes.push(p), post: (p) => routes.push(p) }, { verifyToken: async () => ({ uid: 'x' }) })\nconsole.log(typeof requireAuth, routes.join(','))\n"
    fs.writeFileSync(path.join(dir, file), body)
    const r = spawnSync('node', [file], { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 0, `${type}: ${r.stderr}`)
    assert.equal(r.stdout.trim(), 'function /api/auth/me,/api/auth/register', type)
  }
})
