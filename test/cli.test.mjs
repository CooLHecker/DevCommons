import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fixture, cli, read } from './helpers.mjs'

test('--yes wires everything in and records it', () => {
  const root = fixture()
  const r = cli(root, 'add', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(read(root, 'frontend/src/main.jsx'), /<AuthGate><App \/><\/AuthGate>/)
  assert.match(read(root, 'frontend/vite.config.js'), /proxy/)
  assert.match(read(root, 'backend/main.py'), /setup_auth\(app,/)
  assert.ok(fs.existsSync(path.join(root, 'frontend/src/auth/ui/AuthGate.jsx')))
  assert.ok(fs.existsSync(path.join(root, 'backend/auth_module/setup.py')))
  const rec = JSON.parse(read(root, '.devcommons.json')).features[0]
  assert.equal(rec.copied.length, 6)
  assert.equal(rec.patched.length, 3)
})

test('running --yes twice changes nothing and keeps the record', () => {
  const root = fixture()
  cli(root, 'add', '--yes')
  const snapshot = ['frontend/src/main.jsx', 'frontend/vite.config.js', 'backend/main.py'].map((f) => read(root, f))
  const r = cli(root, 'add', '--yes')
  assert.equal(r.status, 0)
  assert.deepEqual(['frontend/src/main.jsx', 'frontend/vite.config.js', 'backend/main.py'].map((f) => read(root, f)), snapshot)
  const rec = JSON.parse(read(root, '.devcommons.json')).features[0]
  assert.equal(rec.copied.length, 6)
  assert.equal(rec.patched.length, 3)
})

test('--no-patch and explicit flags leave your files alone and print manual steps', () => {
  const root = fixture()
  const r = cli(root, 'add', '--yes', '--no-patch')
  assert.equal(r.status, 0)
  assert.doesNotMatch(read(root, 'frontend/src/main.jsx'), /AuthGate/)
  assert.match(r.stdout, /Wrap your app/)
  const root2 = fixture()
  cli(root2, 'add', 'auth', 'react-vite-fastapi-firebase', '--frontend', 'frontend', '--backend', 'backend')
  assert.doesNotMatch(read(root2, 'frontend/src/main.jsx'), /AuthGate/)
})

test('--dry-run changes nothing', () => {
  const root = fixture()
  const r = cli(root, 'add', '--yes', '--dry-run')
  assert.equal(r.status, 0)
  assert.ok(!fs.existsSync(path.join(root, 'frontend/src/auth')))
  assert.ok(!fs.existsSync(path.join(root, '.devcommons.json')))
  assert.match(r.stdout, /nothing was changed/)
})

test('an unusual entry file falls back to manual steps instead of guessing', () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'frontend/src/main.jsx'), 'import "./boot"\n')
  const r = cli(root, 'add', '--yes')
  assert.equal(r.status, 0)
  assert.equal(read(root, 'frontend/src/main.jsx'), 'import "./boot"\n')
  assert.match(r.stdout, /Wrap your app/)
})
