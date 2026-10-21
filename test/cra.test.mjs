import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cli, read, exists, write } from './helpers.mjs'
import { fitSide, detectPackageManager, detectPythonManager, jsInstallCommand, pyInstallCommand, detectProject } from '../scripts/lib/detect.mjs'
import { planPatches, planReverts, applyPatches } from '../scripts/lib/patch.mjs'

const manifest = JSON.parse(fs.readFileSync(new URL('../features/auth/react-vite-fastapi-firebase/feature.json', import.meta.url), 'utf8'))

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cra-'))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  return root
}

/** A Create React App + FastAPI project. */
function craFixture(extra = {}) {
  return tree({
    'frontend/package.json': '{\n  "name": "shop",\n  "dependencies": {\n    "react": "18",\n    "react-scripts": "5"\n  }\n}\n',
    'frontend/src/index.js': "import ReactDOM from 'react-dom/client'\nimport App from './App'\nReactDOM.createRoot(document.getElementById('root')).render(<App />)\n",
    'backend/requirements.txt': 'fastapi\n',
    'backend/main.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n',
    ...extra,
  })
}

// ------------------------------------------------------------ detection

test('fitSide accepts any-of groups', () => {
  const need = ['react', ['vite', 'cra']]
  assert.equal(fitSide(need, { tags: ['react', 'cra'], label: 'x' }).status, 'match')
  assert.equal(fitSide(need, { tags: ['react', 'vite'], label: 'x' }).status, 'match')
  const miss = fitSide(need, { tags: ['react', 'next'], label: 'React + Next' })
  assert.equal(miss.status, 'mismatch')
  assert.equal(miss.expects, 'react + (vite | cra)')
  assert.equal(fitSide(need, null).expects, 'react + (vite | cra)')
})

test('detectProject tags react-scripts as cra and records the package manager', () => {
  const root = craFixture({ 'frontend/pnpm-lock.yaml': '' })
  const f = detectProject(root).frontends[0]
  assert.ok(f.tags.includes('cra') && f.tags.includes('react'))
  assert.equal(f.packageManager, 'pnpm')
})

test('package manager: lockfile, monorepo root lockfile, packageManager field, default', () => {
  const pkg = '{"dependencies":{"react":"18"}}'
  assert.equal(detectPackageManager(tree({ 'web/package.json': pkg, 'web/yarn.lock': '' }), undefined), 'npm') // root defaults to dir, nothing in root
  const a = tree({ 'web/package.json': pkg, 'web/yarn.lock': '' })
  assert.equal(detectPackageManager(path.join(a, 'web'), a), 'yarn')
  const b = tree({ 'apps/web/package.json': pkg, 'pnpm-lock.yaml': '' })
  assert.equal(detectPackageManager(path.join(b, 'apps/web'), b), 'pnpm')
  const c = tree({ 'web/package.json': '{"packageManager":"bun@1.1.0"}' })
  assert.equal(detectPackageManager(path.join(c, 'web'), c), 'bun')
  const d = tree({ 'web/package.json': pkg, 'web/bun.lockb': '' })
  assert.equal(detectPackageManager(path.join(d, 'web'), d), 'bun')
  const e = tree({ 'web/package.json': pkg })
  assert.equal(detectPackageManager(path.join(e, 'web'), e), 'npm')
})

test('it never looks above the project root for a lockfile', () => {
  const outer = tree({ 'pnpm-lock.yaml': '', 'proj/web/package.json': '{}' })
  const root = path.join(outer, 'proj')
  assert.equal(detectPackageManager(path.join(root, 'web'), root), 'npm')
})

test('install commands per manager', () => {
  assert.equal(jsInstallCommand('npm', ['firebase']), 'npm install firebase')
  assert.equal(jsInstallCommand('pnpm', ['firebase']), 'pnpm add firebase')
  assert.equal(jsInstallCommand('yarn', ['firebase']), 'yarn add firebase')
  assert.equal(jsInstallCommand('bun', ['firebase']), 'bun add firebase')
  assert.equal(pyInstallCommand('pip', ['fastapi', 'uvicorn[standard]']), 'pip install fastapi "uvicorn[standard]"')
  assert.equal(pyInstallCommand('poetry', ['fastapi']), 'poetry add fastapi')
  assert.equal(pyInstallCommand('uv', ['fastapi']), 'uv add fastapi')
})

test('python manager: poetry, uv, pipenv, pip', () => {
  assert.equal(detectPythonManager(tree({ 'pyproject.toml': '[tool.poetry]\nname="x"\n' })), 'poetry')
  assert.equal(detectPythonManager(tree({ 'pyproject.toml': '[project]\nname="x"\n', 'uv.lock': '' })), 'uv')
  assert.equal(detectPythonManager(tree({ 'Pipfile': '' })), 'pipenv')
  assert.equal(detectPythonManager(tree({ 'requirements.txt': 'fastapi\n' })), 'pip')
})

// ------------------------------------------------------------ cra-proxy patch

const ctxFor = (root, extra = {}) => ({ dirs: { frontend: path.join(root, 'frontend') }, vars: { backendUrl: 'http://localhost:8000' }, options: { ui: 'default', env: 'cra' }, feature: 'auth', ...extra })
const craPatches = { frontend: manifest.patches.frontend.filter((p) => p.id === 'cra-proxy') }

test('cra-proxy adds "proxy" to package.json, is idempotent, and reverts byte for byte', () => {
  const root = craFixture()
  const before = read(root, 'frontend/package.json')
  const [r] = planPatches(craPatches, ctxFor(root))
  assert.equal(r.status, 'apply')
  applyPatches([r], root)
  const text = read(root, 'frontend/package.json')
  assert.equal(JSON.parse(text).proxy, 'http://localhost:8000')
  assert.match(text, /^\{\n  "proxy": "http:\/\/localhost:8000",\n  "name": "shop"/)
  assert.equal(planPatches(craPatches, ctxFor(root))[0].status, 'applied')

  const [u] = planReverts(craPatches, ctxFor(root, { recordedFiles: [path.join(root, 'frontend/package.json')] }))
  assert.equal(u.status, 'apply')
  applyPatches([u], root)
  assert.equal(read(root, 'frontend/package.json'), before)
})

test('cra-proxy does not guess: other proxy, setupProxy.js, odd layouts, broken JSON', () => {
  const other = craFixture({ 'frontend/package.json': '{\n  "dependencies": {"react":"18","react-scripts":"5"},\n  "proxy": "http://localhost:9999"\n}\n' })
  const a = planPatches(craPatches, ctxFor(other))[0]
  assert.equal(a.status, 'manual')
  assert.match(a.reason, /already has "proxy"/)

  const setup = craFixture({ 'frontend/src/setupProxy.js': 'module.exports = () => {}\n' })
  assert.equal(planPatches(craPatches, ctxFor(setup))[0].status, 'manual')

  const oneLine = craFixture({ 'frontend/package.json': '{"dependencies":{"react":"18","react-scripts":"5"}}' })
  assert.equal(planPatches(craPatches, ctxFor(oneLine))[0].status, 'manual')

  const broken = craFixture({ 'frontend/package.json': '{ nope' })
  assert.equal(planPatches(craPatches, ctxFor(broken))[0].status, 'manual')
})

test('cra-proxy revert ignores a proxy line devcommons did not write (file not in the record)', () => {
  const root = craFixture({ 'frontend/package.json': '{\n  "proxy": "http://localhost:9999",\n  "name": "x"\n}\n' })
  const [u] = planReverts(craPatches, ctxFor(root, { recordedFiles: [] }))
  assert.equal(u.status, 'absent')
})

// ------------------------------------------------------------ end to end

test('--yes on a Create React App project: REACT_APP_ keys, CRA config, proxy, port 3000', () => {
  const root = craFixture()
  const r = cli(root, 'add', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /env: cra \(detected cra\)/)

  const env = read(root, 'frontend/.env')
  assert.match(env, /REACT_APP_FIREBASE_API_KEY=/)
  assert.doesNotMatch(env, /VITE_/)

  const config = read(root, 'frontend/src/auth/config.js')
  assert.match(config, /process\.env\.REACT_APP_FIREBASE_API_KEY/)
  assert.doesNotMatch(config, /import\.meta/)
  assert.ok(!exists(root, 'frontend/env'), 'catalogue-only folder must not be copied')

  assert.equal(JSON.parse(read(root, 'frontend/package.json')).proxy, 'http://localhost:8000')
  assert.match(read(root, 'frontend/src/index.js'), /<AuthGate>/)
  assert.match(read(root, 'backend/main.py'), /setup_auth\(app, cors_origins=\["http:\/\/localhost:3000"\]\)/)
  assert.match(r.stdout, /Fill in the empty REACT_APP_FIREBASE_\* values/)

  const rec = JSON.parse(read(root, '.devcommons.json')).features[0]
  assert.deepEqual(rec.options, { ui: 'default', env: 'cra' })
  assert.equal(rec.patched.length, 3)
  // nothing in the installed frontend still reads Vite's env
  for (const f of ['core/api.js', 'core/firebase.js']) assert.doesNotMatch(read(root, `frontend/src/auth/${f}`), /import\.meta/)
})

test('CRA: a second run changes nothing; update is up to date; remove restores your files', () => {
  const root = craFixture()
  const originals = Object.fromEntries(['frontend/package.json', 'frontend/src/index.js', 'backend/main.py'].map((f) => [f, read(root, f)]))
  cli(root, 'add', '--yes')
  const after = ['frontend/package.json', 'frontend/src/index.js', 'backend/main.py'].map((f) => read(root, f))
  assert.equal(cli(root, 'add', '--yes').status, 0)
  assert.deepEqual(['frontend/package.json', 'frontend/src/index.js', 'backend/main.py'].map((f) => read(root, f)), after)

  const up = cli(root, 'update', '--yes')
  assert.equal(up.status, 0, up.stderr + up.stdout)
  assert.match(up.stdout, /already up to date/)

  const rm = cli(root, 'remove', '--yes')
  assert.equal(rm.status, 0, rm.stderr + rm.stdout)
  for (const [f, text] of Object.entries(originals)) assert.equal(read(root, f), text, f)
  assert.ok(!exists(root, 'frontend/src/auth'))
  assert.match(rm.stdout, /REACT_APP_FIREBASE_API_KEY/)
})

test('--option env=cra overrides detection; a bad value is rejected', () => {
  const root = craFixture()
  const bad = cli(root, 'add', '--yes', '--option', 'env=webpack')
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr + bad.stdout, /not valid/)
  const r = cli(root, 'add', '--yes', '--option', 'env=cra')
  assert.equal(r.status, 0)
  assert.match(read(root, 'frontend/src/auth/config.js'), /REACT_APP_/)
})

test('a Vite project still gets VITE_ keys and the Vite config', () => {
  const root = tree({
    'frontend/package.json': '{"dependencies":{"react":"18"},"devDependencies":{"vite":"5"}}',
    'frontend/src/main.jsx': "import { createRoot } from 'react-dom/client'\nimport App from './App'\ncreateRoot(document.getElementById('root')).render(<App />)\n",
    'frontend/vite.config.js': "import { defineConfig } from 'vite'\nexport default defineConfig({ plugins: [] })\n",
    'backend/requirements.txt': 'fastapi\n',
    'backend/main.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n',
  })
  const r = cli(root, 'add', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(read(root, 'frontend/.env'), /VITE_FIREBASE_API_KEY=/)
  assert.match(read(root, 'frontend/src/auth/config.js'), /import\.meta\.env\.VITE_/)
  assert.doesNotMatch(read(root, 'frontend/package.json'), /proxy/)
  assert.deepEqual(JSON.parse(read(root, '.devcommons.json')).features[0].options, { ui: 'default', env: 'vite' })
})

test('a record from 0.7.0 (no "env" option) still removes cleanly as a Vite install', () => {
  const root = tree({
    'frontend/package.json': '{"dependencies":{"react":"18"},"devDependencies":{"vite":"5"}}',
    'frontend/src/main.jsx': "import { createRoot } from 'react-dom/client'\nimport App from './App'\ncreateRoot(document.getElementById('root')).render(<App />)\n",
    'frontend/vite.config.js': "import { defineConfig } from 'vite'\nexport default defineConfig({ plugins: [] })\n",
  })
  cli(root, 'add', '--yes')
  const rec = JSON.parse(read(root, '.devcommons.json'))
  delete rec.features[0].options.env
  write(root, '.devcommons.json', JSON.stringify(rec))
  const rm = cli(root, 'remove', '--yes')
  assert.equal(rm.status, 0, rm.stderr + rm.stdout)
  assert.ok(!exists(root, 'frontend/src/auth'), 'config.js and the rest are deleted')
})

test('the install lines follow the project\'s package managers', () => {
  const root = craFixture({ 'frontend/pnpm-lock.yaml': '', 'backend/pyproject.toml': '[tool.poetry]\nname = "api"\n' })
  const r = cli(root, 'add', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /pnpm add firebase/)
  assert.doesNotMatch(r.stdout, /npm install firebase/)
  assert.match(r.stdout, /poetry add fastapi "uvicorn\[standard\]" firebase-admin python-dotenv/)
})
