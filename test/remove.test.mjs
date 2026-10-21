import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fixture, cli, read, exists, write, EDITED, CLI } from './helpers.mjs'

const installed = () => {
  const root = fixture()
  const original = Object.fromEntries(EDITED.map((f) => [f, read(root, f)]))
  assert.equal(cli(root, 'add', '--yes').status, 0)
  return { root, original }
}

test('remove puts your files back exactly and deletes what was copied', () => {
  const { root, original } = installed()
  const r = cli(root, 'remove', 'auth', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  for (const f of EDITED) assert.equal(read(root, f), original[f], f)
  assert.ok(!exists(root, 'frontend/src/auth'))
  assert.ok(!exists(root, 'backend/auth_module'))
  assert.ok(!exists(root, 'backend/dev_reset_link.py'))
  assert.ok(!exists(root, '.devcommons.json'), 'record goes away with its last feature')
  assert.ok(exists(root, 'frontend/.env'), '.env is never touched')
  assert.match(r.stdout, /Left for you/)
})

test('remove with no name picks the only installed feature', () => {
  const { root, original } = installed()
  assert.equal(cli(root, 'remove', '--yes').status, 0)
  assert.equal(read(root, 'frontend/src/main.jsx'), original['frontend/src/main.jsx'])
})

test('remove --dry-run changes nothing', () => {
  const { root } = installed()
  const before = EDITED.map((f) => read(root, f))
  const r = cli(root, 'remove', 'auth', '--dry-run')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /nothing was changed/)
  assert.deepEqual(EDITED.map((f) => read(root, f)), before)
  assert.ok(exists(root, 'frontend/src/auth/ui/AuthGate.jsx'))
  assert.ok(exists(root, '.devcommons.json'))
})

test('files you edited or added stay; --force deletes the edited ones', () => {
  const { root } = installed()
  write(root, 'frontend/src/auth/ui/LoginPage.jsx', '// my own login page\n')
  write(root, 'frontend/src/auth/ui/mine.js', 'export const x = 1\n')
  const r = cli(root, 'remove', 'auth', '--yes')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(root, 'frontend/src/auth/ui/LoginPage.jsx'), '// my own login page\n')
  assert.ok(exists(root, 'frontend/src/auth/ui/mine.js'))
  assert.ok(!exists(root, 'frontend/src/auth/ui/AuthGate.jsx'))
  assert.match(r.stdout, /you changed it/)
  assert.match(r.stdout, /not part of devcommons/)

  const again = installed()
  write(again.root, 'frontend/src/auth/ui/LoginPage.jsx', '// edited\n')
  assert.equal(cli(again.root, 'remove', 'auth', '--yes', '--force').status, 0)
  assert.ok(!exists(again.root, 'frontend/src/auth'))
})

test('python caches do not keep the backend folder alive', () => {
  const { root } = installed()
  fs.mkdirSync(path.join(root, 'backend/auth_module/__pycache__'))
  write(root, 'backend/auth_module/__pycache__/setup.cpython-312.pyc', 'x')
  assert.equal(cli(root, 'remove', 'auth', '--yes').status, 0)
  assert.ok(!exists(root, 'backend/auth_module'))
})

test('an edit you changed since install is left for you to undo by hand', () => {
  const { root } = installed()
  const mangled = read(root, 'frontend/vite.config.js').replace(/\n\s*server:.*\n/, '\n  server: weird(),\n')
  assert.notEqual(mangled, read(root, 'frontend/vite.config.js'))
  write(root, 'frontend/vite.config.js', mangled)
  const r = cli(root, 'remove', 'auth', '--yes')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(root, 'frontend/vite.config.js'), mangled)
  assert.match(r.stdout, /by hand/)
  assert.ok(!exists(root, 'frontend/src/auth'), 'the rest is still removed')
})

test('edits already undone are reported, not an error', () => {
  const { root, original } = installed()
  write(root, 'frontend/src/main.jsx', original['frontend/src/main.jsx'])
  const r = cli(root, 'remove', 'auth', '--yes')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /nothing to undo/)
  assert.equal(read(root, 'frontend/src/main.jsx'), original['frontend/src/main.jsx'])
})

test('remove then add again works', () => {
  const { root } = installed()
  assert.equal(cli(root, 'remove', 'auth', '--yes').status, 0)
  assert.equal(cli(root, 'add', '--yes').status, 0)
  assert.match(read(root, 'frontend/src/main.jsx'), /<AuthGate><App \/><\/AuthGate>/)
  assert.equal(JSON.parse(read(root, '.devcommons.json')).features.length, 1)
})

test('remove explains itself when nothing was installed or the name is wrong', () => {
  const root = fixture()
  const none = cli(root, 'remove', 'auth', '--yes')
  assert.equal(none.status, 1)
  assert.match(none.stderr, /No \.devcommons\.json/)
  cli(root, 'add', '--yes')
  const wrong = cli(root, 'remove', 'payments', '--yes')
  assert.equal(wrong.status, 1)
  assert.match(wrong.stderr, /not installed/)
})

test('without --yes it asks first, and answering no changes nothing', () => {
  const { root } = installed()
  const r = spawnSync('node', [CLI, 'remove', 'auth'], { cwd: root, encoding: 'utf8', timeout: 30000, input: 'n\n' })
  assert.match(r.stdout, /Cancelled/)
  assert.ok(exists(root, 'frontend/src/auth/ui/AuthGate.jsx'))
})

// ---------------------------------------------------------------- the ui option

test('--option ui=headless installs the core only and wraps with AuthProvider', () => {
  const root = fixture()
  const r = cli(root, 'add', '--yes', '--option', 'ui=headless')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(exists(root, 'frontend/src/auth/core/forms.js'))
  assert.ok(!exists(root, 'frontend/src/auth/ui'))
  assert.ok(!exists(root, 'frontend/src/auth/index.headless.js'))
  const index = read(root, 'frontend/src/auth/index.js')
  assert.match(index, /useLoginForm/)
  assert.doesNotMatch(index, /AuthGate|\.\/ui\//)
  assert.match(read(root, 'frontend/src/main.jsx'), /<AuthProvider>/)
  assert.doesNotMatch(read(root, 'frontend/src/main.jsx'), /AuthGate/)
  assert.match(r.stdout, /useLoginForm/, 'next steps explain the headless usage')
  assert.deepEqual(JSON.parse(read(root, '.devcommons.json')).features[0].options, { ui: 'headless', env: 'vite' })
})

test('default install has both layers and the demo-style index', () => {
  const root = fixture()
  assert.equal(cli(root, 'add', '--yes').status, 0)
  assert.ok(exists(root, 'frontend/src/auth/core/forms.js'))
  assert.ok(exists(root, 'frontend/src/auth/ui/LoginPage.jsx'))
  assert.match(read(root, 'frontend/src/auth/index.js'), /AuthGate/)
  assert.deepEqual(JSON.parse(read(root, '.devcommons.json')).features[0].options, { ui: 'default', env: 'vite' })
})

test('headless add then remove restores the project', () => {
  const root = fixture()
  const original = Object.fromEntries(EDITED.map((f) => [f, read(root, f)]))
  cli(root, 'add', '--yes', '--option', 'ui=headless')
  const r = cli(root, 'remove', '--yes')
  assert.equal(r.status, 0, r.stderr)
  for (const f of EDITED) assert.equal(read(root, f), original[f], f)
  assert.ok(!exists(root, 'frontend/src/auth'))
})

test('a bad option value or name is refused with the valid choices', () => {
  const root = fixture()
  const bad = cli(root, 'add', '--yes', '--option', 'ui=fancy')
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /default, headless/)
  const unknown = cli(root, 'add', '--yes', '--option', 'theme=dark')
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown option "theme"/)
  assert.ok(!exists(root, 'frontend/src/auth'))
})

test('interactive mode asks which UI to install', () => {
  const root = fixture()
  // stack -> 1, folder? y, folder? y, ui -> 2 (headless), npm install? n, backend url, origin, firebase now? n, go ahead? y
  const r = spawnSync('node', [CLI, 'add'], { cwd: root, encoding: 'utf8', timeout: 30000, input: ['1', 'y', 'y', '2', 'n', '', '', 'n', 'y', ''].join('\n') })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /How should the sign-in screens be built/)
  assert.ok(!exists(root, 'frontend/src/auth/ui'))
  assert.ok(exists(root, 'frontend/src/auth/core'))
})

test('remove on an install from before the core/ui split reverts the edits and lists the files', () => {
  const root = fixture()
  const original = read(root, 'backend/main.py')
  cli(root, 'add', '--yes')
  const rec = JSON.parse(read(root, '.devcommons.json'))
  delete rec.features[0].options // what a pre-split record looks like
  write(root, '.devcommons.json', JSON.stringify(rec))
  const r = cli(root, 'remove', '--yes')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(root, 'backend/main.py'), original)
  assert.match(r.stdout, /older devcommons/)
  assert.ok(exists(root, 'frontend/src/auth/ui/LoginPage.jsx'), 'files are not guessed at')
})
