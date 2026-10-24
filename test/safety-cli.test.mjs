import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { CLI, fixture, cli, read, write, exists } from './helpers.mjs'

const hasGit = spawnSync('git', ['--version']).status === 0
const git = (root, ...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' })
const committed = () => {
  const root = fixture()
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'start')
  return root
}
const out = (r) => r.stdout + r.stderr
const PEM_LINE = '-----BEGIN PRIVATE KEY-----'

// ------------------------------------------------------------ .gitignore

test('add --yes keeps .env and the key file out of git, shows it as an edit, and records nothing to revert', () => {
  const root = fixture()
  const r = cli(root, 'add', 'auth', '--yes')
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /edit {2}\.\/\.gitignore/)
  assert.equal(read(root, '.gitignore'), '# devcommons: keep secrets out of git\n.env\n/backend/serviceAccountKey.json\n')
  assert.ok(!exists(root, '.devcommons/backup/.gitignore'), 'there was no original to back up')
  assert.ok(!JSON.parse(read(root, '.devcommons.json')).features[0].patched.includes('.gitignore'))
  assert.ok(!/Add \.env and the key file/.test(r.stdout), 'no manual step left for something that is done')
  const again = cli(root, 'add', 'auth', '--yes')
  assert.equal(read(root, '.gitignore').match(/\.env/g).length, 1, 'running again does not repeat the lines')
  assert.match(again.stdout, /already in place {2}gitignore/)
})

test('an existing .gitignore is extended, backed up, and anything it already covers is not repeated', () => {
  const root = fixture()
  write(root, '.gitignore', 'node_modules\n.env\n')
  assert.equal(cli(root, 'add', 'auth', '--yes').status, 0)
  assert.equal(read(root, '.gitignore'), 'node_modules\n.env\n\n# devcommons: keep secrets out of git\n/backend/serviceAccountKey.json\n')
  assert.equal(read(root, '.devcommons/backup/.gitignore'), 'node_modules\n.env\n')
})

test('without --patch (copy only) .gitignore is not touched; the lines are printed as a next step', () => {
  const root = fixture()
  const r = cli(root, 'add', 'auth', 'react-vite-fastapi-firebase', '--frontend', './frontend', '--backend', './backend')
  assert.equal(r.status, 0, out(r))
  assert.ok(!exists(root, '.gitignore'))
  assert.match(r.stdout, /Add these lines to \.gitignore/)
  assert.match(r.stdout, /\/backend\/serviceAccountKey\.json/)
  const off = cli(fixture(), 'add', 'auth', '--yes', '--no-patch')
  assert.match(off.stdout, /Add these lines to \.gitignore/)
})

test('--dry-run shows the .gitignore edit and writes nothing', () => {
  const root = fixture()
  const r = cli(root, 'add', 'auth', '--yes', '--dry-run')
  assert.match(r.stdout, /edit {2}\.\/\.gitignore/)
  assert.ok(!exists(root, '.gitignore') && !exists(root, '.devcommons.json'))
})

test('remove leaves the .gitignore lines alone (harmless, and you may rely on them now)', () => {
  const root = fixture()
  cli(root, 'add', 'auth', '--yes')
  assert.equal(cli(root, 'remove', 'auth', '--yes').status, 0)
  assert.match(read(root, '.gitignore'), /\.env/)
})

// ------------------------------------------------------------ never write a private key

test('a private key pasted into a prompt is refused: not written, not echoed back', () => {
  const root = fixture()
  const input = ['1', 'y', 'y', '2', 'n', '', '', 'y', PEM_LINE, '', '', '', 'y', ''].join('\n')
  const r = spawnSync('node', [CLI, 'add'], { cwd: root, encoding: 'utf8', timeout: 30000, input })
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /looks like a private key/)
  assert.ok(!read(root, 'frontend/.env').includes('BEGIN'), 'not in the .env')
  assert.match(read(root, 'frontend/.env'), /^VITE_FIREBASE_API_KEY=$/m)
  const echoed = r.stdout.split('\n').filter((l) => l.includes('PRIVATE KEY') && !l.startsWith('Firebase apiKey:')) // the prompt line is the terminal echoing what was typed
  assert.deepEqual(echoed, [], 'devcommons never repeats it')
  assert.ok(!read(root, '.devcommons.json').includes('BEGIN'))
})

// ------------------------------------------------------------ uncommitted changes

test('a clean git tree is not slowed down', { skip: !hasGit }, () => {
  const root = committed()
  const r = cli(root, 'add', 'auth', '--yes')
  assert.equal(r.status, 0, out(r))
  assert.ok(!/uncommitted/.test(out(r)))
})

test('add --yes stops before writing anything when a file it would edit has uncommitted changes', { skip: !hasGit }, () => {
  const root = committed()
  write(root, 'backend/main.py', `${read(root, 'backend/main.py')}# my work in progress\n`)
  const r = cli(root, 'add', 'auth', '--yes')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /uncommitted changes/)
  assert.match(r.stderr, /\.\/backend\/main\.py/)
  assert.ok(!/frontend\/src\/main\.jsx/.test(r.stderr), 'only the files that are really dirty')
  assert.match(r.stderr, /--allow-dirty/)
  assert.ok(!exists(root, 'backend/auth_module') && !exists(root, '.devcommons.json') && !exists(root, 'frontend/src/auth'), 'nothing was written')
  assert.match(read(root, 'backend/main.py'), /work in progress/)
})

test('--allow-dirty and --force go ahead, and the work in progress is kept', { skip: !hasGit }, () => {
  for (const flag of ['--allow-dirty', '--force']) {
    const root = committed()
    write(root, 'backend/main.py', `${read(root, 'backend/main.py')}# my work in progress\n`)
    const r = cli(root, 'add', 'auth', '--yes', flag)
    assert.equal(r.status, 0, out(r))
    assert.match(read(root, 'backend/main.py'), /work in progress/)
    assert.match(read(root, 'backend/main.py'), /setup_auth/)
  }
})

test('--dry-run on a dirty tree explains, and exits 0', { skip: !hasGit }, () => {
  const root = committed()
  write(root, 'backend/main.py', `${read(root, 'backend/main.py')}# wip\n`)
  const r = cli(root, 'add', 'auth', '--yes', '--dry-run')
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /Note: these files have uncommitted changes/)
  assert.ok(!exists(root, '.devcommons.json'))
})

test('files that are not edited do not matter; copy-only runs never edit, so they never stop', { skip: !hasGit }, () => {
  const root = committed()
  write(root, 'README.md', 'unrelated change\n')
  assert.equal(cli(root, 'add', 'auth', '--yes').status, 0)
  const other = committed()
  write(other, 'backend/main.py', `${read(other, 'backend/main.py')}# wip\n`)
  const r = cli(other, 'add', 'auth', 'react-vite-fastapi-firebase', '--frontend', './frontend', '--backend', './backend')
  assert.equal(r.status, 0, out(r))
  assert.match(read(other, 'backend/main.py'), /wip/)
})

test('a file git does not know yet counts as uncommitted work too', { skip: !hasGit }, () => {
  const root = fixture()
  git(root, 'init', '-q') // nothing committed: every file is untracked
  const r = cli(root, 'add', 'auth', '--yes')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /not tracked by git yet/)
})

test('outside a git repository there is nothing to compare with, so it just goes on', () => {
  const root = fixture()
  const r = spawnSync('node', [CLI, 'add', 'auth', '--yes'], { cwd: root, encoding: 'utf8', timeout: 30000, input: '', env: { ...process.env, DEVCOMMONS_NO_GIT: '1' } })
  assert.equal(r.status, 0, out(r))
})

test('remove --yes refuses to revert edits in a file with uncommitted changes; --allow-dirty overrides', { skip: !hasGit }, () => {
  const root = fixture()
  const original = read(root, 'backend/main.py')
  cli(root, 'add', 'auth', '--yes')
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'with auth')
  write(root, 'backend/main.py', `${read(root, 'backend/main.py')}# wip\n`)
  const r = cli(root, 'remove', 'auth', '--yes')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /would undo edits in them/)
  assert.match(read(root, 'backend/main.py'), /setup_auth/, 'not reverted')
  assert.ok(exists(root, 'backend/auth_module'), 'and nothing deleted')
  const ok = cli(root, 'remove', 'auth', '--yes', '--allow-dirty')
  assert.equal(ok.status, 0, out(ok))
  assert.ok(!/setup_auth/.test(read(root, 'backend/main.py')))
  assert.ok(read(root, 'backend/main.py').startsWith(original.trimEnd()))
})

test('interactive remove asks, and "Cancel" leaves everything as it was', { skip: !hasGit }, () => {
  const root = fixture()
  cli(root, 'add', 'auth', '--yes')
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'with auth')
  write(root, 'backend/main.py', `${read(root, 'backend/main.py')}# wip\n`)
  const cancel = spawnSync('node', [CLI, 'remove', 'auth'], { cwd: root, encoding: 'utf8', timeout: 30000, input: '1\n' })
  assert.match(cancel.stdout, /uncommitted changes/)
  assert.match(cancel.stdout, /Cancelled\./)
  assert.ok(exists(root, 'backend/auth_module'))
  const go = spawnSync('node', [CLI, 'remove', 'auth'], { cwd: root, encoding: 'utf8', timeout: 30000, input: '2\ny\n' })
  assert.equal(go.status, 0, out(go))
  assert.ok(!exists(root, 'backend/auth_module'))
})
