import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixture, cli, read, exists, write } from './helpers.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const AUTH = 'features/auth/react-vite-fastapi-firebase'
const record = (root) => JSON.parse(read(root, '.devcommons.json')).features[0]

/** A copy of devcommons whose catalogue has "moved on" (a newer release), plus a runner for its CLI. */
function upgradedCatalogue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-upgraded-'))
  for (const name of ['scripts', 'features', 'package.json']) fs.cpSync(path.join(REPO, name), path.join(dir, name), { recursive: true })
  const run = (cwd, ...args) => spawnSync('node', [path.join(dir, 'scripts', 'cli.mjs'), ...args], { cwd, encoding: 'utf8', timeout: 30000, input: '' })
  return { dir, run }
}

test('the record stores a hash for every copied file, keyed by forward-slash project paths', () => {
  const root = fixture()
  assert.equal(cli(root, 'add', '--yes').status, 0)
  const { hashes } = record(root)
  assert.ok(hashes['frontend/src/auth/ui/AuthGate.jsx'])
  assert.ok(hashes['frontend/src/auth/core/AuthContext.jsx'])
  assert.ok(hashes['backend/auth_module/setup.py'])
  for (const [key, value] of Object.entries(hashes)) {
    assert.ok(!key.includes('\\') && !path.isAbsolute(key), key)
    assert.match(value, /^[0-9a-f]{64}$/)
    assert.ok(exists(root, key), `${key} is recorded but missing`)
  }
  assert.ok(!Object.keys(hashes).some((k) => k.includes('__pycache__') || k.includes('node_modules')))
})

test('hashes ignore CRLF vs LF', () => {
  const root = fixture()
  assert.equal(cli(root, 'add', '--yes').status, 0)
  const file = 'frontend/src/auth/ui/AuthGate.jsx'
  write(root, file, read(root, file).replace(/\n/g, '\r\n'))
  assert.equal(cli(root, 'remove', '--yes').status, 0)
  assert.ok(!exists(root, 'frontend/src/auth'), 'a line-ending-only change is not an edit')
})

test('remove after a catalogue upgrade deletes untouched files and keeps edited ones', () => {
  const root = fixture()
  assert.equal(cli(root, 'add', '--yes').status, 0)
  write(root, 'frontend/src/auth/ui/LoginPage.jsx', '// my login page\n')

  const { dir, run } = upgradedCatalogue()
  // the new release changed a file you never touched, and one you did
  fs.appendFileSync(path.join(dir, AUTH, 'frontend/src/auth/ui/AuthGate.jsx'), '\n// new in the next release\n')
  fs.appendFileSync(path.join(dir, AUTH, 'frontend/src/auth/ui/LoginPage.jsx'), '\n// new in the next release\n')

  const r = run(root, 'remove', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(!exists(root, 'frontend/src/auth/ui/AuthGate.jsx'), 'untouched file deleted although the catalogue copy differs now')
  assert.equal(read(root, 'frontend/src/auth/ui/LoginPage.jsx'), '// my login page\n')
  assert.match(r.stdout, /you changed it/)
})

test('the old behaviour is what you get without hashes (records from 0.6.0 and before)', () => {
  const root = fixture()
  assert.equal(cli(root, 'add', '--yes').status, 0)
  const rec = JSON.parse(read(root, '.devcommons.json'))
  delete rec.features[0].hashes
  write(root, '.devcommons.json', JSON.stringify(rec))

  const { dir, run } = upgradedCatalogue()
  fs.appendFileSync(path.join(dir, AUTH, 'frontend/src/auth/ui/AuthGate.jsx'), '\n// new\n')
  const r = run(root, 'remove', '--yes')
  assert.equal(r.status, 0, r.stderr)
  assert.ok(exists(root, 'frontend/src/auth/ui/AuthGate.jsx'), 'compared to the new catalogue it looks edited, so it is kept')
  assert.ok(!exists(root, 'frontend/src/auth/ui/LoginPage.jsx'))
})

test('files that were not ours (not in the record) are kept even if the folder is', () => {
  const root = fixture()
  assert.equal(cli(root, 'add', '--yes').status, 0)
  write(root, 'frontend/src/auth/ui/mine.js', 'export const x = 1\n')
  const r = cli(root, 'remove', '--yes')
  assert.equal(r.status, 0)
  assert.ok(exists(root, 'frontend/src/auth/ui/mine.js'))
  assert.match(r.stdout, /not part of devcommons/)
})

test('re-running add keeps the old hashes, so an edit made in between is still seen as an edit', () => {
  const root = fixture()
  assert.equal(cli(root, 'add', '--yes').status, 0)
  write(root, 'frontend/src/auth/ui/LoginPage.jsx', '// edited\n')
  assert.equal(cli(root, 'add', '--yes').status, 0) // skips existing files
  const r = cli(root, 'remove', '--yes')
  assert.equal(r.status, 0)
  assert.equal(read(root, 'frontend/src/auth/ui/LoginPage.jsx'), '// edited\n')
})

test('--force on add refreshes the hash of the file it overwrote', () => {
  const root = fixture()
  assert.equal(cli(root, 'add', '--yes').status, 0)
  const before = record(root).hashes['frontend/src/auth/ui/LoginPage.jsx']
  write(root, 'frontend/src/auth/ui/LoginPage.jsx', '// edited\n')
  assert.equal(cli(root, 'add', '--yes', '--force').status, 0)
  assert.equal(record(root).hashes['frontend/src/auth/ui/LoginPage.jsx'], before)
  assert.equal(cli(root, 'remove', '--yes').status, 0)
  assert.ok(!exists(root, 'frontend/src/auth'))
})

test('the headless option records and removes cleanly (index.headless.js is installed as index.js)', () => {
  const root = fixture()
  assert.equal(cli(root, 'add', 'auth', '--yes', '--option', 'ui=headless').status, 0)
  assert.ok(record(root).hashes['frontend/src/auth/index.js'])
  assert.equal(cli(root, 'remove', '--yes').status, 0)
  assert.ok(!exists(root, 'frontend/src/auth'))
})

test('re-running add on a record without hashes does not create a partial set', () => {
  const root = fixture()
  assert.equal(cli(root, 'add', '--yes').status, 0)
  const rec = JSON.parse(read(root, '.devcommons.json'))
  delete rec.features[0].hashes
  write(root, '.devcommons.json', JSON.stringify(rec))
  assert.equal(cli(root, 'add', '--yes').status, 0)
  assert.equal(record(root).hashes, undefined)
  assert.equal(cli(root, 'remove', '--yes').status, 0)
  assert.ok(!exists(root, 'frontend/src/auth'), 'still removable the old way')
})
