import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { looksSecret, redact, ignoredByGitignoreFiles, planGitignore, gitRepo, isIgnored, dirtyFiles, stashFiles, isTracked, secretTargets } from '../scripts/lib/safety.mjs'
import { parseEnv, envLookup } from '../scripts/lib/envfile.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dc-safe-'))
const put = (root, rel, text = '') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}
const hasGit = spawnSync('git', ['--version']).status === 0
const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' })
const PEM = '-----BEGIN PRIVATE KEY-----\nMIIFAKEFAKEFAKE\n-----END PRIVATE KEY-----\n'

test('looksSecret: private keys and service-account JSON, not Firebase web config', () => {
  assert.ok(looksSecret(PEM))
  assert.ok(looksSecret('-----BEGIN RSA PRIVATE KEY-----'))
  assert.ok(looksSecret('{"type": "service_account", "project_id": "x"}'))
  assert.ok(looksSecret('{"private_key": "abc"}'))
  assert.ok(!looksSecret('AIzaSyD-public-web-api-key'))
  assert.ok(!looksSecret('my-app.firebaseapp.com'))
  assert.ok(!looksSecret('./serviceAccountKey.json'))
  assert.ok(!looksSecret(''))
})

test('redact: key material never survives', () => {
  const out = redact(`oops ${PEM} and {"private_key": "SECRETSECRET"}`)
  assert.ok(!out.includes('MIIFAKE') && !out.includes('SECRETSECRET'))
  assert.ok(out.includes('[redacted'))
})

test('parseEnv / envLookup: quotes, export, comments, priority', () => {
  const m = parseEnv('# c\nA=1\nexport B="two words"\nC=x # trailing\nD=\n')
  assert.deepEqual([...m], [['A', '1'], ['B', 'two words'], ['C', 'x'], ['D', '']])
  const files = [{ name: '.env', values: new Map([['K', 'a']]) }, { name: '.env.local', values: new Map([['K', 'b']]) }]
  assert.deepEqual(envLookup(files, 'K', {}), { value: 'b', from: '.env.local' })
  assert.equal(envLookup(files, 'NOPE', {}), null)
  assert.equal(envLookup(files, 'NOPE', { NOPE: 'z' }).from, 'environment')
})

test('gitignore matcher (no git needed): anchoring, globs, negation, dirs, nesting', () => {
  const root = tmp()
  const f = (rel) => path.join(root, rel)
  put(root, '.gitignore', '.env\n/backend/key.json\n*.pem\n!keep.pem\nsecrets/\n**/cache/**\n# comment\n')
  assert.ok(ignoredByGitignoreFiles(root, f('.env')))
  assert.ok(ignoredByGitignoreFiles(root, f('frontend/.env')), 'unanchored matches at any depth')
  assert.ok(ignoredByGitignoreFiles(root, f('backend/key.json')))
  assert.ok(!ignoredByGitignoreFiles(root, f('other/backend/key.json')), 'anchored does not')
  assert.ok(ignoredByGitignoreFiles(root, f('a/b.pem')))
  assert.ok(!ignoredByGitignoreFiles(root, f('a/keep.pem')), 'negation')
  assert.ok(ignoredByGitignoreFiles(root, f('x/secrets/anything.txt')), 'ignored folder hides its files')
  assert.ok(ignoredByGitignoreFiles(root, f('x/cache/deep/file')))
  assert.ok(!ignoredByGitignoreFiles(root, f('src/app.js')))
  put(root, 'web/.gitignore', '*.local\n')
  assert.ok(ignoredByGitignoreFiles(root, f('web/.env.local')), 'nested .gitignore')
  assert.ok(!ignoredByGitignoreFiles(root, f('api/.env.local')))
})

test('planGitignore: adds only what is missing, keeps the file, dedupes .env, CRLF stays CRLF', () => {
  const root = tmp()
  const targets = [
    { side: 'frontend', pattern: '.env', file: path.join(root, 'frontend/.env') },
    { side: 'backend', pattern: '.env', file: path.join(root, 'backend/.env') },
    { side: 'backend', pattern: '/backend/serviceAccountKey.json', file: path.join(root, 'backend/serviceAccountKey.json') },
  ]
  const none = { inRepo: false }
  let plan = planGitignore(root, targets, none)
  assert.equal(plan.status, 'apply')
  assert.deepEqual(plan.patterns, ['.env', '/backend/serviceAccountKey.json'])
  assert.equal(plan.before, '')
  assert.match(plan.after, /^# devcommons: keep secrets out of git\n\.env\n\/backend\/serviceAccountKey\.json\n$/)

  put(root, '.gitignore', 'node_modules\r\ndist')
  plan = planGitignore(root, targets, none)
  assert.equal(plan.eol, '\r\n')
  assert.ok(plan.after.startsWith('node_modules\ndist\n\n# devcommons'), plan.after)

  put(root, '.gitignore', '.env\n/backend/serviceAccountKey.json\n')
  assert.equal(planGitignore(root, targets, none).status, 'applied')
  put(root, '.gitignore', '*.env\n')
  assert.deepEqual(planGitignore(root, targets, none).patterns, ['/backend/serviceAccountKey.json'], '*.env already covers .env; only the key is missing')
})

test('secretTargets: .env per side + the key file, but not a key outside the project', () => {
  const root = tmp()
  const manifest = JSON.parse(fs.readFileSync(new URL('../features/auth/react-vite-fastapi-firebase/feature.json', import.meta.url), 'utf8'))
  const chosen = { frontend: path.join(root, 'frontend'), backend: path.join(root, 'backend') }
  const t = secretTargets({ manifest, chosen, cwd: root })
  assert.deepEqual(t.map((x) => x.pattern), ['.env', '.env', '/backend/serviceAccountKey.json'])
  put(root, 'backend/.env', 'GOOGLE_APPLICATION_CREDENTIALS=/etc/keys/sa.json\n')
  assert.deepEqual(secretTargets({ manifest, chosen, cwd: root }).map((x) => x.pattern), ['.env', '.env'])
  put(root, 'backend/.env', 'GOOGLE_APPLICATION_CREDENTIALS=./secrets/sa.json\n')
  assert.ok(secretTargets({ manifest, chosen, cwd: root }).some((x) => x.pattern === '/backend/secrets/sa.json'))
})

test('git helpers: ignored, tracked, dirty, stash', { skip: !hasGit }, () => {
  const root = tmp()
  git(root, 'init', '-q')
  put(root, '.gitignore', '.env\n')
  put(root, 'a.txt', 'one\n')
  put(root, 'b.txt', 'one\n')
  put(root, '.env', 'X=1\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
  const repo = gitRepo(root)
  assert.ok(repo.inRepo)
  assert.ok(isIgnored(root, path.join(root, '.env'), repo))
  assert.ok(!isIgnored(root, path.join(root, 'a.txt'), repo))
  assert.ok(isIgnored(root, path.join(root, 'sub/.env'), repo), 'works for files that do not exist yet')
  assert.ok(isTracked(root, path.join(root, 'a.txt')))
  assert.ok(!isTracked(root, path.join(root, '.env')))

  assert.deepEqual(dirtyFiles(root, [path.join(root, 'a.txt'), path.join(root, 'b.txt')]), [])
  put(root, 'a.txt', 'changed\n')
  put(root, 'c.txt', 'new\n')
  const dirty = dirtyFiles(root, [path.join(root, 'a.txt'), path.join(root, 'b.txt'), path.join(root, 'c.txt')])
  assert.deepEqual(dirty.map((d) => [path.basename(d.file), d.untracked]), [['a.txt', false], ['c.txt', true]])

  const r = stashFiles(root, [path.join(root, 'a.txt')], 'test')
  assert.ok(r.ok, r.message)
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\n', 'stash restored the committed content')
  assert.equal(git(root, 'stash', 'list').stdout.includes('test'), true)
})

test('no git: DEVCOMMONS_NO_GIT falls back to reading .gitignore files', () => {
  const root = tmp()
  put(root, '.gitignore', '.env\n')
  const prev = process.env.DEVCOMMONS_NO_GIT
  process.env.DEVCOMMONS_NO_GIT = '1'
  try {
    assert.equal(gitRepo(root).inRepo, false)
    assert.ok(isIgnored(root, path.join(root, 'x/.env')))
    assert.ok(!isIgnored(root, path.join(root, 'x/app.js')))
    assert.deepEqual(dirtyFiles(root, [path.join(root, '.gitignore')]), [])
  } finally {
    if (prev === undefined) delete process.env.DEVCOMMONS_NO_GIT
    else process.env.DEVCOMMONS_NO_GIT = prev
  }
})
