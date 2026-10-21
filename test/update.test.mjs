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
const GATE = 'frontend/src/auth/ui/AuthGate.jsx'
const LOGIN = 'frontend/src/auth/ui/LoginPage.jsx'
const record = (root) => JSON.parse(read(root, '.devcommons.json')).features[0]

/** A project with auth installed, and a "newer release" of the catalogue (a copy we can change). */
function setup() {
  const root = fixture()
  assert.equal(cli(root, 'add', '--yes').status, 0)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-release-'))
  for (const name of ['scripts', 'features', 'package.json']) fs.cpSync(path.join(REPO, name), path.join(dir, name), { recursive: true })
  const cat = (rel) => path.join(dir, AUTH, rel)
  const run = (...args) => spawnSync('node', [path.join(dir, 'scripts', 'cli.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 30000, input: '' })
  const release = (version) => {
    const m = path.join(dir, AUTH, 'feature.json')
    const json = JSON.parse(fs.readFileSync(m, 'utf8'))
    json.version = version
    fs.writeFileSync(m, JSON.stringify(json, null, 2))
  }
  return { root, dir, cat, run, release }
}

test('nothing changed in the catalogue: already up to date, nothing touched', () => {
  const { root, run } = setup()
  const before = read(root, '.devcommons.json')
  const r = run('update', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /already up to date/)
  assert.equal(read(root, '.devcommons.json').replace(/"updatedAt".*/, ''), before.replace(/"updatedAt".*/, ''))
})

test('a file you never touched is replaced, the record follows, and a second update is a no-op', () => {
  const { root, cat, run, release } = setup()
  fs.appendFileSync(cat('frontend/src/auth/ui/AuthGate.jsx'), '\n// new in 9.9.9\n')
  release('9.9.9')
  const r = run('update', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(read(root, GATE), /new in 9\.9\.9/)
  assert.match(r.stdout, /1 file\(s\) replaced/)
  assert.equal(record(root).version, '9.9.9')
  assert.match(run('update', '--yes').stdout, /already up to date/)
})

test('your edit survives when the catalogue did not change that file', () => {
  const { root, cat, run } = setup()
  write(root, LOGIN, '// mine\n')
  fs.appendFileSync(cat('frontend/src/auth/ui/AuthGate.jsx'), '\n// new\n')
  assert.equal(run('update', '--yes').status, 0)
  assert.equal(read(root, LOGIN), '// mine\n')
  assert.match(read(root, GATE), /new/)
})

test('edited here and changed upstream: kept as a conflict; --force overwrites after a backup', () => {
  const { root, cat, run } = setup()
  write(root, LOGIN, '// mine\n')
  fs.appendFileSync(cat('frontend/src/auth/ui/LoginPage.jsx'), '\n// upstream\n')
  const r = run('update', '--yes')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /conflict/)
  assert.equal(read(root, LOGIN), '// mine\n')
  assert.match(run('update', '--yes').stdout, /conflict/, 'still reported next time')

  const f = run('update', '--yes', '--force')
  assert.equal(f.status, 0, f.stderr)
  assert.match(read(root, LOGIN), /upstream/)
  assert.equal(read(root, '.devcommons/backup/update/' + LOGIN), '// mine\n')
  assert.match(run('update', '--yes').stdout, /already up to date/)
})

test('new files in the catalogue are added; files it dropped are deleted unless you edited them', () => {
  const { root, dir, cat, run } = setup()
  fs.writeFileSync(cat('frontend/src/auth/ui/Banner.jsx'), 'export const Banner = () => null\n')
  fs.rmSync(cat('frontend/src/auth/ui/SignOutButton.jsx'))
  fs.rmSync(cat('frontend/src/auth/ui/classes.js'))
  write(root, 'frontend/src/auth/ui/classes.js', '// mine\n')
  const r = run('update', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(exists(root, 'frontend/src/auth/ui/Banner.jsx'))
  assert.ok(!exists(root, 'frontend/src/auth/ui/SignOutButton.jsx'))
  assert.equal(read(root, 'frontend/src/auth/ui/classes.js'), '// mine\n')
  assert.match(r.stdout, /no longer shipped, but you changed it/)
  const hashes = record(root).hashes
  assert.ok(hashes['frontend/src/auth/ui/Banner.jsx'])
  assert.equal(hashes['frontend/src/auth/ui/SignOutButton.jsx'], undefined)
})

test('a file you deleted is not brought back', () => {
  const { root, cat, run } = setup()
  fs.rmSync(path.join(root, LOGIN))
  fs.appendFileSync(cat('frontend/src/auth/ui/LoginPage.jsx'), '\n// upstream\n')
  const r = run('update', '--yes')
  assert.equal(r.status, 0)
  assert.ok(!exists(root, LOGIN))
  assert.match(r.stdout, /you deleted it/)
})

test('you already made the same change as upstream: adopted, not a conflict', () => {
  const { root, cat, run } = setup()
  fs.appendFileSync(cat('frontend/src/auth/ui/LoginPage.jsx'), '\n// same\n')
  fs.appendFileSync(path.join(root, LOGIN), '\n// same\n')
  const r = run('update', '--yes')
  assert.equal(r.status, 0)
  assert.doesNotMatch(r.stdout, /conflict/)
  assert.match(run('update', '--yes').stdout, /already up to date/)
})

test('--dry-run shows the plan and changes nothing', () => {
  const { root, cat, run } = setup()
  fs.appendFileSync(cat('frontend/src/auth/ui/AuthGate.jsx'), '\n// new\n')
  const before = read(root, GATE)
  const record0 = read(root, '.devcommons.json')
  const r = run('update', '--dry-run')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /update\s+\.\/frontend\/src\/auth\/ui\/AuthGate\.jsx/)
  assert.match(r.stdout, /\+ \/\/ new/)
  assert.match(r.stdout, /nothing was changed/)
  assert.equal(read(root, GATE), before)
  assert.equal(read(root, '.devcommons.json'), record0)
})

test('without --yes it asks, and "n" changes nothing', () => {
  const { root, dir, cat } = setup()
  fs.appendFileSync(cat('frontend/src/auth/ui/AuthGate.jsx'), '\n// new\n')
  const before = read(root, GATE)
  const r = spawnSync('node', [path.join(dir, 'scripts', 'cli.mjs'), 'update'], { cwd: root, encoding: 'utf8', timeout: 30000, input: 'n\n' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Cancelled/)
  assert.equal(read(root, GATE), before)
})

test('a record without hashes is refused with the way forward', () => {
  const { root, run } = setup()
  const rec = JSON.parse(read(root, '.devcommons.json'))
  delete rec.features[0].hashes
  write(root, '.devcommons.json', JSON.stringify(rec))
  const r = run('update', '--yes')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /remove.*add/s)
})

test('not installed / no record', () => {
  const root = fixture()
  const r = cli(root, 'update')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /nothing recorded/)
  assert.equal(cli(root, 'add', '--yes').status, 0)
  assert.match(cli(root, 'update', 'payments').stderr, /not installed here/)
})

test('headless installs update too', () => {
  const root = fixture()
  assert.equal(cli(root, 'add', 'auth', '--yes', '--option', 'ui=headless').status, 0)
  const r = cli(root, 'update', '--yes')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /already up to date/)
  assert.ok(!exists(root, 'frontend/src/auth/ui'))
})

test('remove after an update still deletes what update wrote', () => {
  const { root, cat, run } = setup()
  fs.appendFileSync(cat('frontend/src/auth/ui/AuthGate.jsx'), '\n// new\n')
  assert.equal(run('update', '--yes').status, 0)
  const r = run('remove', '--yes')
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!exists(root, 'frontend/src/auth'))
})

test('update leaves the edits in your own files alone', () => {
  const { root, run } = setup()
  const edited = ['frontend/src/main.jsx', 'frontend/vite.config.js', 'backend/main.py'].map((f) => read(root, f))
  assert.equal(run('update', '--yes').status, 0)
  assert.deepEqual(['frontend/src/main.jsx', 'frontend/vite.config.js', 'backend/main.py'].map((f) => read(root, f)), edited)
})
