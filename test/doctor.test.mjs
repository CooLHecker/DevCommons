import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { CLI, fixture, cli, read, write, exists } from './helpers.mjs'

const hasGit = spawnSync('git', ['--version']).status === 0
const PEM = '-----BEGIN PRIVATE KEY-----\nMIIFAKEFAKEFAKEFAKE\n-----END PRIVATE KEY-----\n'
const SA = (project = 'demo-proj') => JSON.stringify({ type: 'service_account', project_id: project, private_key_id: 'k', private_key: PEM, client_email: `a@${project}.iam.gserviceaccount.com` })

/** An installed project (--yes), optionally with real-looking settings and a key. */
function installed({ configure = false, project = 'demo-proj', keyProject = 'demo-proj' } = {}) {
  const root = fixture()
  const r = cli(root, 'add', 'auth', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  if (configure) {
    write(root, 'frontend/.env', ['VITE_FIREBASE_API_KEY=web-key', 'VITE_FIREBASE_AUTH_DOMAIN=x.firebaseapp.com', `VITE_FIREBASE_PROJECT_ID=${project}`, 'VITE_FIREBASE_APP_ID=1:1:web:1', ''].join('\n'))
    write(root, 'backend/serviceAccountKey.json', SA(keyProject))
    write(root, 'frontend/package.json', '{"dependencies":{"react":"18","firebase":"10"},"devDependencies":{"vite":"5"}}')
    fs.mkdirSync(path.join(root, 'frontend/node_modules/firebase'), { recursive: true })
    write(root, 'frontend/node_modules/firebase/package.json', '{"name":"firebase"}')
  }
  return root
}

const cliAsync = (cwd, args, env = {}) =>
  new Promise((resolve) => {
    const p = spawn('node', [CLI, ...args], { cwd, env: { ...process.env, VIRTUAL_ENV: '', NO_COLOR: '1', ...env } })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('close', (status) => resolve({ status, stdout, stderr }))
    p.stdin.end()
  })

const doctor = (root, ...args) => cli(root, 'doctor', '--json', ...args)
const checks = (r) => JSON.parse(r.stdout).features[0].checks
const find = (list, re) => list.find((c) => re.test(c.title))

function server(handler) {
  const s = http.createServer(handler)
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) })))
}
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}
/** A backend that follows the auth contract. */
const contract = (cors = true) => (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors ? { 'access-control-allow-origin': req.headers.origin } : {})
    return res.end()
  }
  json(res, 401, { detail: req.headers.authorization ? 'Invalid token' : 'Missing bearer token' }, { 'www-authenticate': 'Bearer' })
}

// ------------------------------------------------------------ files, edits, environment (offline)

test('doctor: a fresh install is wired in; only the things you still have to fill in are reported', () => {
  const root = installed()
  const r = doctor(root, '--offline')
  assert.equal(r.status, 1, 'empty settings are a problem')
  const c = checks(r)
  assert.equal(find(c, /installed file\(s\) present/).status, 'ok')
  assert.equal(c.filter((x) => x.area === 'Edits to your files').every((x) => x.status === 'ok'), true)
  assert.equal(find(c, /frontend: 4 of 4 setting\(s\) not set/).status, 'fail')
  assert.match(find(c, /service-account key not found/).detail, /GOOGLE_APPLICATION_CREDENTIALS/)
  assert.equal(find(c, /covered by \.gitignore/).status, 'ok', 'add put the .env files in .gitignore')
})

test('doctor: configured project is healthy offline (exit 0)', () => {
  const root = installed({ configure: true })
  const r = doctor(root, '--offline')
  const c = checks(r)
  assert.equal(r.status, 0, JSON.stringify(c.filter((x) => x.status === 'fail')))
  assert.equal(find(c, /service-account key found and valid/).status, 'ok')
  assert.equal(find(c, /same project/).status, 'ok')
  assert.equal(find(c, /live checks not run/).status, 'skip')
})

test('doctor: frontend and key from different Firebase projects is a failure', () => {
  const root = installed({ configure: true, project: 'one', keyProject: 'two' })
  const c = checks(doctor(root, '--offline'))
  const bad = find(c, /uses project "one" but .* is for "two"/)
  assert.equal(bad.status, 'fail')
  assert.match(bad.fix, /VITE_FIREBASE_PROJECT_ID/)
})

test('doctor: a key file that is not a service-account key says why, without quoting it', () => {
  const root = installed({ configure: true })
  write(root, 'backend/serviceAccountKey.json', '{"apiKey":"AIza-web","projectId":"x"}')
  let bad = find(checks(doctor(root, '--offline')), /is not valid/)
  assert.equal(bad.status, 'fail')
  assert.match(bad.detail, /"type" is not service_account/)
  write(root, 'backend/serviceAccountKey.json', `{"type":"service_account", "private_key": "${PEM.replace(/\n/g, '\\n')}" BROKEN`)
  const r = doctor(root, '--offline')
  bad = find(checks(r), /is not valid/)
  assert.equal(bad.status, 'fail')
  assert.ok(!r.stdout.includes('MIIFAKE'), 'key material must not reach the output')
})

test('doctor: key given inline (FIREBASE_CREDENTIALS_JSON) or by platform credentials counts, and is validated', () => {
  const root = installed({ configure: true })
  fs.rmSync(path.join(root, 'backend/serviceAccountKey.json'))
  write(root, 'backend/.env', `GOOGLE_APPLICATION_CREDENTIALS=\nFIREBASE_CREDENTIALS_JSON=${SA('demo-proj')}\n`)
  assert.equal(find(checks(doctor(root, '--offline')), /set through FIREBASE_CREDENTIALS_JSON/).status, 'ok')
  write(root, 'backend/.env', 'GOOGLE_APPLICATION_CREDENTIALS=\nFIREBASE_PROJECT_ID=demo-proj\n')
  assert.equal(find(checks(doctor(root, '--offline')), /default credentials for project demo-proj/).status, 'ok')
  write(root, 'backend/.env', 'GOOGLE_APPLICATION_CREDENTIALS=\n')
  assert.equal(find(checks(doctor(root, '--offline')), /is not configured/).status, 'fail')
})

test('doctor: an edit you undid is reported, with the command that puts it back; hand-wiring elsewhere is accepted', () => {
  const root = installed({ configure: true })
  write(root, 'backend/main.py', 'from fastapi import FastAPI\n\napp = FastAPI()\n')
  let c = checks(doctor(root, '--offline'))
  const bad = find(c, /setup-auth is not applied/)
  assert.equal(bad.status, 'fail')
  assert.match(bad.fix, /devcommons add auth react-vite-fastapi-firebase --frontend \.\/frontend --backend \.\/backend --patch/)

  write(root, 'backend/routes.py', 'from auth_module import setup_auth\n\ndef boot(app):\n    setup_auth(app)\n')
  c = checks(doctor(root, '--offline'))
  assert.equal(find(c, /setup-auth is in place/).status, 'ok')
  assert.match(find(c, /setup-auth is in place/).detail, /routes\.py/)

  // and the suggested command really repairs the first case
  write(root, 'backend/routes.py', '')
  fs.rmSync(path.join(root, 'backend/routes.py'))
  const fix = cli(root, 'add', 'auth', 'react-vite-fastapi-firebase', '--frontend', './frontend', '--backend', './backend', '--patch')
  assert.equal(fix.status, 0, fix.stderr)
  assert.equal(find(checks(doctor(root, '--offline')), /setup-auth is in place/).status, 'ok')
})

test('doctor: missing installed files fail; edited ones are fine', () => {
  const root = installed({ configure: true })
  fs.rmSync(path.join(root, 'backend/auth_module/firebase_client.py'))
  const c = checks(doctor(root, '--offline'))
  const miss = find(c, /installed file\(s\) are missing/)
  assert.equal(miss.status, 'fail')
  assert.match(miss.detail, /firebase_client\.py/)

  const root2 = installed({ configure: true })
  write(root2, 'backend/auth_module/firebase_client.py', `${read(root2, 'backend/auth_module/firebase_client.py')}\n# mine\n`)
  assert.match(find(checks(doctor(root2, '--offline')), /installed file\(s\) present/).title, /1 edited by you/)
})

test('doctor: packages — missing from package.json, listed but not installed, Python requirements', () => {
  const root = installed({ configure: true })
  write(root, 'frontend/package.json', '{"dependencies":{"react":"18"},"devDependencies":{"vite":"5"}}')
  let c = checks(doctor(root, '--offline'))
  const nope = find(c, /firebase is not in/)
  assert.equal(nope.status, 'fail')
  assert.equal(nope.fix, 'npm install firebase')
  write(root, 'frontend/package.json', '{"dependencies":{"react":"18","firebase":"10"}}')
  fs.rmSync(path.join(root, 'frontend/node_modules'), { recursive: true })
  c = checks(doctor(root, '--offline'))
  assert.match(find(c, /firebase is listed but not installed/).fix, /npm install/)
  const req = find(c, /not listed in your requirements/)
  assert.equal(req.status, 'warn')
  assert.match(req.fix, /pip install/)
})

test('doctor: no .devcommons.json, or a name that is not installed, is a clear error', () => {
  const r = cli(fixture(), 'doctor')
  assert.equal(r.status, 1)
  assert.match(r.stderr + r.stdout, /No \.devcommons\.json/)
  const root = installed()
  const r2 = cli(root, 'doctor', 'payments')
  assert.equal(r2.status, 1)
  assert.match(r2.stderr + r2.stdout, /"payments" is not installed here/)
})

test('doctor: text output groups by area, is readable, and never contains key material', () => {
  const root = installed({ configure: true })
  write(root, 'frontend/.env', `${read(root, 'frontend/.env')}VITE_OOPS=${PEM.replace(/\n/g, ' ')}\n`)
  const r = cli(root, 'doctor', '--offline')
  for (const area of ['Files', 'Edits to your files', 'Environment', 'Packages', 'Connection', 'Safety']) assert.match(r.stdout, new RegExp(`^${area}$`, 'm'))
  assert.match(r.stdout, /VITE_OOPS/, 'the variable NAME is shown')
  assert.match(r.stdout, /holds key material/)
  assert.ok(!r.stdout.includes('MIIFAKE') && !r.stdout.includes('BEGIN PRIVATE'), 'the value is not')
  assert.match(r.stdout, /\d+ ok {2}·/)
})

// ------------------------------------------------------------ connection (live)

test('doctor: a backend that follows the contract passes, including CORS', async () => {
  const be = await server(contract())
  try {
    const r = await cliAsync(installed({ configure: true }), ['doctor', '--json', '--url', be.url])
    const c = JSON.parse(r.stdout).features[0].checks
    assert.equal(find(c, /answers 401 "Missing bearer token"/).status, 'ok')
    assert.match(find(c, /answers 401/).detail, /conformance\.mjs/)
    assert.equal(find(c, /bad token is rejected/).status, 'ok')
    assert.equal(find(c, /CORS allows http:\/\/localhost:5173/).status, 'ok')
  } finally {
    await be.close()
  }
})

test('doctor: wrong routes (404), no enforcement (200), a crash while verifying (500)', async () => {
  const cases = [
    [(req, res) => json(res, 404, { detail: 'Not Found' }), /-> 404: the auth routes are not mounted/, 'fail'],
    [(req, res) => json(res, 200, { uid: 'anyone' }), /-> 200 without a token/, 'fail'],
    [(req, res) => (req.headers.authorization ? json(res, 500, { detail: 'boom' }) : json(res, 401, { detail: 'Missing bearer token' }, { 'www-authenticate': 'Bearer' })), /crashed while verifying a token/, 'fail'],
    [(req, res) => json(res, 401, { detail: 'nope' }), /not the way the contract says/, 'warn'],
  ]
  for (const [handler, re, status] of cases) {
    const be = await server(handler)
    try {
      const r = await cliAsync(installed({ configure: true }), ['doctor', '--json', '--url', be.url])
      const hit = find(JSON.parse(r.stdout).features[0].checks, re)
      assert.ok(hit, `${re}: ${r.stdout}`)
      assert.equal(hit.status, status)
    } finally {
      await be.close()
    }
  }
})

test('doctor: --prefix finds routes mounted somewhere else', async () => {
  const be = await server((req, res) => (req.url.startsWith('/v2/auth/me') ? contract()(req, res) : json(res, 404, {})))
  try {
    const root = installed({ configure: true })
    const c = JSON.parse((await cliAsync(root, ['doctor', '--json', '--url', be.url, '--prefix', '/v2'])).stdout).features[0].checks
    assert.equal(find(c, /GET \/v2\/auth\/me answers 401/).status, 'ok')
  } finally {
    await be.close()
  }
})

test('doctor: a backend that is not running is a warning, not a failure', async () => {
  const be = await server(contract())
  const url = be.url
  await be.close()
  const r = await cliAsync(installed({ configure: true }), ['doctor', '--json', '--url', url])
  const c = JSON.parse(r.stdout).features[0].checks
  assert.equal(find(c, /backend not reachable/).status, 'warn')
  assert.equal(r.status, 0)
})

test('doctor: the dev server proxy is tested through the frontend origin', async () => {
  const be = await server(contract())
  const good = await server(contract(false)) // stands in for a Vite dev server whose proxy works
  const spa = await server((req, res) => (res.writeHead(200, { 'content-type': 'text/html' }), res.end('<html>index</html>'))) // Vite without the proxy: SPA fallback
  try {
    const root = installed({ configure: true })
    let c = JSON.parse((await cliAsync(root, ['doctor', '--json', '--url', be.url, '--origin', good.url])).stdout).features[0].checks
    assert.match(find(c, /forwards \/api to the backend/).title, new RegExp(good.url.replace(/[.]/g, '\\.')))
    c = JSON.parse((await cliAsync(root, ['doctor', '--json', '--url', be.url, '--origin', spa.url])).stdout).features[0].checks
    const bad = find(c, /answers \/api\/auth\/me itself \(200\)/)
    assert.equal(bad.status, 'fail')
    assert.match(bad.fix, /restart the dev server/)
  } finally {
    await Promise.all([be.close(), good.close(), spa.close()])
  }
})

test('doctor: CORS missing is fine behind the proxy, a failure when the browser calls the backend directly', async () => {
  const be = await server(contract(false))
  try {
    const root = installed({ configure: true })
    let c = JSON.parse((await cliAsync(root, ['doctor', '--json', '--url', be.url])).stdout).features[0].checks
    assert.equal(find(c, /CORS does not list/).status, 'skip')
    write(root, 'frontend/.env', `${read(root, 'frontend/.env')}VITE_API_URL=${be.url}/api\n`)
    c = JSON.parse((await cliAsync(root, ['doctor', '--json'])).stdout).features[0].checks
    assert.match(find(c, /calls .* directly/).title, /VITE_API_URL/)
    assert.equal(find(c, /CORS does not allow/).status, 'fail')
  } finally {
    await be.close()
  }
})

test('doctor: no proxy and no API URL is reported with the fix', () => {
  const root = installed({ configure: true })
  write(root, 'frontend/vite.config.js', "import { defineConfig } from 'vite'\nexport default defineConfig({ plugins: [] })\n")
  const bad = find(checks(doctor(root, '--offline')), /no \/api proxy and no VITE_API_URL set/)
  assert.equal(bad.status, 'fail')
  assert.ok(JSON.stringify(bad.fix).includes('proxy'))
  write(root, 'frontend/vite.config.js', "export default { server: { proxy: { '/api': 'http://localhost:9999' } } }\n")
  assert.equal(find(checks(doctor(root, '--offline')), /dev proxy \/api -> http:\/\/localhost:9999/).status, 'ok')
})

// ------------------------------------------------------------ safety

test('doctor --fix adds the missing .gitignore lines and nothing else; running it again changes nothing', () => {
  const root = installed({ configure: true })
  write(root, '.gitignore', 'node_modules\n')
  const before = checks(doctor(root, '--offline'))
  const bad = find(before, /serviceAccountKey\.json is not ignored by git/)
  assert.equal(bad.status, 'fail', 'the key file would be committed by "git add ."')
  assert.match(bad.fix, /doctor --fix/)
  const files = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => !f.startsWith(path.join('.devcommons', 'backup'))).sort().join() // the backup of the old .gitignore is expected
  const tree = files(root)
  const r = cli(root, 'doctor', '--offline', '--fix', '--json')
  assert.deepEqual(JSON.parse(r.stdout).fixed, ['.env', '/backend/serviceAccountKey.json'])
  assert.equal(read(root, '.gitignore'), 'node_modules\n\n# devcommons: keep secrets out of git\n.env\n/backend/serviceAccountKey.json\n')
  assert.equal(files(root), tree, 'no new files in the project')
  assert.ok(!find(checks(r), /not ignored by git/))
  const again = cli(root, 'doctor', '--offline', '--fix', '--json')
  assert.deepEqual(JSON.parse(again.stdout).fixed, [])
})

test('doctor: a key or .env already committed to git is a failure with the way out', { skip: !hasGit }, () => {
  const root = installed({ configure: true })
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' })
  git('init', '-q')
  git('add', '-f', 'backend/serviceAccountKey.json', 'frontend/.env')
  git('commit', '-qm', 'oops')
  const c = checks(doctor(root, '--offline'))
  const key = find(c, /serviceAccountKey\.json is committed to git/)
  assert.equal(key.status, 'fail')
  assert.match(key.fix.join('\n'), /git rm --cached .*serviceAccountKey\.json[\s\S]*revoke this key/)
  assert.equal(find(c, /frontend\/\.env is committed/).status, 'fail')
})

test('doctor: outside git, ignore rules are still checked from .gitignore files', () => {
  const root = installed({ configure: true })
  fs.rmSync(path.join(root, '.gitignore'))
  const c = checks(cli(root, 'doctor', '--offline', '--json'))
  assert.equal(find(c, /serviceAccountKey\.json is not ignored/).status, 'fail')
  assert.equal(find(c, /not a git repository/).status, 'skip')
})

// ------------------------------------------------------------ the Express stack (same checks, Node packages)

function expressProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-doc-exp-'))
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  w('api/package.json', '{"dependencies":{"express":"4"}}')
  w('api/server.js', "const express = require('express')\nconst app = express()\napp.use(express.json())\napp.listen(4000)\n")
  const r = cli(root, 'add', 'auth', 'express-firebase', '--backend', './api', '--patch')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  return { root, w }
}

test('doctor (Express): Node packages, key file and the live contract, no frontend checks', async () => {
  const { root, w } = expressProject()
  let c = checks(doctor(root, '--offline'))
  assert.equal(find(c, /firebase-admin is not in/).status, 'fail')
  assert.ok(!c.some((x) => /frontend|proxy/.test(x.title)), 'a backend-only install has no frontend to check')

  w('api/package.json', '{"dependencies":{"express":"4","firebase-admin":"12","dotenv":"16"}}')
  for (const n of ['firebase-admin', 'dotenv']) w(`api/node_modules/${n}/package.json`, `{"name":"${n}"}`)
  w('api/serviceAccountKey.json', SA())
  c = checks(doctor(root, '--offline'))
  assert.equal(find(c, /firebase-admin, dotenv installed/).status, 'ok')
  assert.equal(find(c, /service-account key found and valid/).status, 'ok')
  assert.equal(c.filter((x) => x.status === 'fail').length, 0, JSON.stringify(c.filter((x) => x.status === 'fail')))

  const be = await server(contract())
  try {
    const live = JSON.parse((await cliAsync(root, ['doctor', '--json', '--url', be.url])).stdout).features[0].checks
    assert.equal(find(live, /answers 401 "Missing bearer token"/).status, 'ok')
    assert.ok(!live.some((x) => /CORS|dev server/.test(x.title)), 'CORS is only judged for a frontend that exists')
  } finally {
    await be.close()
  }
})

test('doctor (Express): the backend port found in server.js is the default URL to probe', async () => {
  const { root } = expressProject()
  const r = await cliAsync(root, ['doctor', '--json'])
  assert.match(find(JSON.parse(r.stdout).features[0].checks, /backend not reachable at http:\/\/localhost:4000/).title, /4000/)
})
