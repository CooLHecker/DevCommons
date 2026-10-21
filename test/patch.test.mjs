import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { planPatches, planReverts, applyPatches, renderDiff } from '../scripts/lib/patch.mjs'

const manifest = JSON.parse(
  fs.readFileSync(new URL('../features/auth/react-vite-fastapi-firebase/feature.json', import.meta.url), 'utf8'),
)
const vars = { backendUrl: 'http://localhost:8000', frontendOrigin: 'http://localhost:5173' }

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'))
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(root, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, content)
  }
  return root
}
const run = (root, extra = {}) =>
  planPatches(manifest.patches, { dirs: { frontend: path.join(root, 'web'), backend: path.join(root, 'api') }, vars, options: { ui: 'default', env: 'vite' }, ...extra })
const byId = (plan, id) => plan.find((r) => r.id === id)

const MAIN_JSX = `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`

test('wrap-root wraps <App /> and adds the import', () => {
  const root = project({ 'web/src/main.jsx': MAIN_JSX })
  const r = byId(run(root), 'wrap-root')
  assert.equal(r.status, 'apply')
  assert.match(r.after, /import \{ AuthGate \} from '\.\/auth'\n/)
  assert.match(r.after, /<AuthGate>\n {6}<App \/>\n {4}<\/AuthGate>/)
  assert.ok(r.after.indexOf("from './auth'") > r.after.indexOf("from './App.jsx'"))
})

test('wrap-root is idempotent', () => {
  const root = project({ 'web/src/main.jsx': MAIN_JSX })
  applyPatches(run(root), root)
  assert.equal(byId(run(root), 'wrap-root').status, 'applied')
})

test('wrap-root works with semicolons, double quotes and tsx', () => {
  const src = `import React from "react";\nimport ReactDOM from "react-dom/client";\nimport Root from "./Root";\n\nReactDOM.createRoot(document.getElementById("root")!).render(<Root />);\n`
  const root = project({ 'web/src/main.tsx': src })
  const r = byId(run(root), 'wrap-root')
  assert.equal(r.status, 'apply')
  assert.match(r.after, /import \{ AuthGate \} from "\.\/auth";/)
  assert.match(r.after, /render\(<AuthGate><Root \/><\/AuthGate>\)/)
})

test('wrap-root gives up (manual) when several components are rendered', () => {
  const src = `import { createRoot } from 'react-dom/client'\ncreateRoot(el).render(<><Header /><Page /></>)\n`
  const root = project({ 'web/src/main.jsx': src })
  const r = byId(run(root), 'wrap-root')
  assert.equal(r.status, 'manual')
  assert.match(r.reason, /several/)
})

test('wrap-root gives up when there is no entry file', () => {
  const root = project({ 'web/package.json': '{}' })
  assert.equal(byId(run(root), 'wrap-root').status, 'manual')
})

test('wrap-root keeps CRLF line endings', () => {
  const root = project({ 'web/src/main.jsx': MAIN_JSX.replace(/\n/g, '\r\n') })
  const plan = run(root)
  applyPatches(plan, root)
  const out = fs.readFileSync(path.join(root, 'web/src/main.jsx'), 'utf8')
  assert.ok(out.includes('\r\n'))
  assert.ok(!/[^\r]\n/.test(out))
})

const VITE_PLAIN = `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n`

test('vite-proxy adds a server block when there is none', () => {
  const root = project({ 'web/vite.config.js': VITE_PLAIN })
  const r = byId(run(root), 'vite-proxy')
  assert.equal(r.status, 'apply')
  assert.match(r.after, /server: \{ proxy: \{ '\/api': 'http:\/\/localhost:8000', \} \},/)
  assert.doesNotThrow(() => new Function(r.after.replace(/^import .*$/gm, '').replace('export default', 'return')))
})

test('vite-proxy adds proxy inside an existing server block, even a one-liner', () => {
  const src = `export default defineConfig({\n  server: { port: 3000 },\n})\n`
  const root = project({ 'web/vite.config.js': src })
  const r = byId(run(root), 'vite-proxy')
  assert.equal(r.status, 'apply')
  assert.match(r.after, /server: \{\n\s+\/\/ devcommons:auth\n\s+proxy: \{ '\/api': 'http:\/\/localhost:8000', \}, port: 3000 \}/)
})

test('vite-proxy adds a route to an existing proxy and is idempotent', () => {
  const src = `export default defineConfig({\n  server: {\n    proxy: {\n      '/other': 'http://x',\n    },\n  },\n})\n`
  const root = project({ 'web/vite.config.js': src })
  const r = byId(run(root), 'vite-proxy')
  assert.equal(r.status, 'apply')
  assert.match(r.after, /proxy: \{\n\s+\/\/ devcommons:auth\n\s+'\/api': 'http:\/\/localhost:8000',\n\s+'\/other'/)
  applyPatches(run(root), root)
  assert.equal(byId(run(root), 'vite-proxy').status, 'applied')
})

test('vite-proxy handles the function form of defineConfig', () => {
  const src = `export default defineConfig(({ mode }) => ({\n  plugins: [],\n}))\n`
  const root = project({ 'web/vite.config.js': src })
  assert.equal(byId(run(root), 'vite-proxy').status, 'apply')
})

test('vite-proxy says it is already there when /api is proxied', () => {
  const root = project({ 'web/vite.config.js': `export default { server: { proxy: { '/api': 'http://localhost:9000' } } }` })
  assert.equal(byId(run(root), 'vite-proxy').status, 'applied')
})

test('vite-proxy gives up on a config it cannot read', () => {
  const root = project({ 'web/vite.config.js': `export default someFactory()\n` })
  assert.equal(byId(run(root), 'vite-proxy').status, 'manual')
})

const MAIN_PY = `from fastapi import (
    FastAPI,
    Depends,
)
import os

app = FastAPI(
    title="x",
)


@app.get("/")
def home():
    return {}
`

test('py-setup-call adds the import and the call after the app is created', () => {
  const root = project({ 'api/main.py': MAIN_PY })
  const r = byId(run(root), 'setup-auth')
  assert.equal(r.status, 'apply')
  const lines = r.after.split('\n')
  const imp = lines.findIndex((l) => l.startsWith('from auth_module import setup_auth'))
  const call = lines.findIndex((l) => l.startsWith('setup_auth(app, cors_origins=["http://localhost:5173"])'))
  const appLine = lines.findIndex((l) => l.startsWith('app = FastAPI('))
  assert.ok(imp > lines.findIndex((l) => l === 'import os') && imp < appLine)
  assert.ok(call > appLine + 2)
  assert.ok(r.after.includes('@app.get("/")'))
})

test('py-setup-call omits cors_origins when the app already sets CORS, and honours another variable name', () => {
  const src = `from fastapi import FastAPI\nfrom fastapi.middleware.cors import CORSMiddleware\n\nserver = FastAPI()\nserver.add_middleware(CORSMiddleware, allow_origins=["*"])\n`
  const root = project({ 'api/main.py': src })
  const r = byId(run(root), 'setup-auth')
  assert.equal(r.status, 'apply')
  assert.match(r.after, /\nsetup_auth\(server\)  # devcommons:auth/)
})

test('py-setup-call is idempotent and uses the detected entry file', () => {
  const root = project({ 'api/server.py': MAIN_PY, 'api/main.py': '# nothing here\n' })
  const plan = run(root, { entry: 'server.py' })
  assert.equal(byId(plan, 'setup-auth').file, path.join(root, 'api/server.py'))
  applyPatches(plan, root)
  assert.equal(byId(run(root, { entry: 'server.py' }), 'setup-auth').status, 'applied')
})

test('py-setup-call gives up when no FastAPI app is found', () => {
  const root = project({ 'api/main.py': 'print("hi")\n' })
  assert.equal(byId(run(root), 'setup-auth').status, 'manual')
})

test('applyPatches saves a backup of the original', () => {
  const root = project({ 'web/src/main.jsx': MAIN_JSX })
  applyPatches(run(root), root)
  const backup = fs.readFileSync(path.join(root, '.devcommons/backup/web/src/main.jsx'), 'utf8')
  assert.equal(backup, MAIN_JSX)
})

test('renderDiff shows only changed lines with context', () => {
  const d = renderDiff('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nc\nd\nX\ne\nf\ng\nh')
  assert.match(d, /\+ X/)
  assert.ok(!d.includes('- '))
})

// ---------------------------------------------------------------- reverts

const runBack = (root) =>
  planReverts(manifest.patches, { dirs: { frontend: path.join(root, 'web'), backend: path.join(root, 'api') }, feature: 'auth' })
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')

/** apply every patch, revert every patch, and expect the original text back */
function roundTrip(files) {
  const root = project(files)
  applyPatches(run(root, { feature: 'auth' }), root)
  for (const f of Object.keys(files)) if (files[f] === read(root, f)) assert.fail(`${f} was not edited`)
  applyPatches(runBack(root), root)
  for (const [f, text] of Object.entries(files)) assert.equal(read(root, f), text, f)
  assert.ok(runBack(root).every((r) => r.status === 'absent'), 'nothing left to undo')
}

const PY = `from fastapi import FastAPI\nimport os\n\napp = FastAPI()\n\n\n@app.get('/')\ndef home():\n    return {}\n`

test('revert restores the original for the common project shapes', () => {
  roundTrip({ 'web/src/main.jsx': MAIN_JSX, 'web/vite.config.js': VITE_PLAIN, 'api/main.py': PY })
})

test('revert restores semicolons, double quotes and a one-line root', () => {
  roundTrip({
    'web/src/main.tsx': `import React from "react";\nimport Root from "./Root";\n\nReactDOM.createRoot(el).render(<Root />);\n`,
    'web/vite.config.js': `export default defineConfig({ plugins: [] })\n`,
    'api/main.py': PY,
  })
})

test('revert restores an existing proxy and an existing one-line server block', () => {
  roundTrip({ 'web/src/main.jsx': MAIN_JSX, 'web/vite.config.js': `export default defineConfig({\n  server: {\n    proxy: {\n      '/other': 'http://x',\n    },\n  },\n})\n` })
  roundTrip({ 'web/src/main.jsx': MAIN_JSX, 'web/vite.config.js': `export default defineConfig({\n  server: { port: 3000 },\n})\n` })
})

test('revert handles CORS-aware python and keeps CRLF', () => {
  const py = PY.replace('\n', '\r\n').replace(/\n/g, '\r\n')
  roundTrip({ 'web/src/main.jsx': MAIN_JSX.replace(/\n/g, '\r\n'), 'api/main.py': py })
})

test('revert of wrap-root leaves an import that also pulls in other names', () => {
  const root = project({ 'web/src/main.jsx': MAIN_JSX })
  applyPatches(run(root, { feature: 'auth' }), root)
  fs.writeFileSync(path.join(root, 'web/src/main.jsx'), read(root, 'web/src/main.jsx').replace("{ AuthGate }", "{ AuthGate, useAuth }"))
  const r = byId(runBack(root), 'wrap-root')
  assert.equal(r.status, 'apply')
  assert.match(r.after, /import \{ AuthGate, useAuth \} from '\.\/auth'/)
  assert.doesNotMatch(r.after, /<AuthGate>/)
})

test('revert gives up when the wrapper has props or appears twice', () => {
  const root = project({ 'web/src/main.jsx': MAIN_JSX })
  applyPatches(run(root, { feature: 'auth' }), root)
  const edited = read(root, 'web/src/main.jsx').replace('<AuthGate>', '<AuthGate fallback={null}>')
  fs.writeFileSync(path.join(root, 'web/src/main.jsx'), edited)
  assert.equal(byId(runBack(root), 'wrap-root').status, 'manual')
})

test('revert says absent when devcommons never edited the file', () => {
  const root = project({ 'web/src/main.jsx': MAIN_JSX, 'web/vite.config.js': VITE_PLAIN, 'api/main.py': PY })
  assert.ok(runBack(root).every((r) => r.status === 'absent'))
})

test('revert finds the call in a recorded file with an unusual name', () => {
  const root = project({ 'api/run.py': `from fastapi import FastAPI\n\napp = FastAPI()\n` })
  applyPatches(planPatches(manifest.patches, { dirs: { backend: path.join(root, 'api') }, vars, entry: 'run.py', feature: 'auth' }), root)
  assert.equal(byId(planReverts(manifest.patches, { dirs: { backend: path.join(root, 'api') }, feature: 'auth' }), 'setup-auth').status, 'absent')
  const back = planReverts(manifest.patches, { dirs: { backend: path.join(root, 'api') }, feature: 'auth', recordedFiles: [path.join(root, 'api/run.py')] })
  assert.equal(byId(back, 'setup-auth').status, 'apply')
})

test('the headless option wraps with AuthProvider instead of AuthGate, and only that', () => {
  const root = project({ 'web/src/main.jsx': MAIN_JSX })
  const plan = run(root, { options: { ui: 'headless', env: 'vite' } }).filter((r) => r.side === 'frontend')
  assert.ok(!plan.some((r) => r.id === 'wrap-root'))
  const r = byId(plan, 'wrap-root-provider')
  assert.equal(r.status, 'apply')
  assert.match(r.after, /import \{ AuthProvider \} from '\.\/auth'/)
  assert.match(r.after, /<AuthProvider>\n {6}<App \/>\n {4}<\/AuthProvider>/)
  applyPatches([r], root)
  const back = byId(runBack(root), 'wrap-root-provider')
  assert.equal(back.status, 'apply')
  applyPatches([back], root)
  assert.equal(read(root, 'web/src/main.jsx'), MAIN_JSX)
})
