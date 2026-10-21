// Slow check (needs network for npm): install the feature into a fresh Vite project with the real CLI,
// then run the real build. Catches broken copies, wrong index selection, bad imports.
//
//   node test/build-installed.mjs [default|headless]     (npm run test:build)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { CLI } from './helpers.mjs'

const ui = process.argv[2] ?? 'default'
const root = fs.mkdtempSync(path.join(os.tmpdir(), `dc-build-${ui}-`))
const w = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}
const run = (cmd, args, cwd, env = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, ...env } })
  if (r.status !== 0) {
    console.error(`$ ${cmd} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`)
    process.exit(1)
  }
  return r.stdout
}

w('frontend/package.json', JSON.stringify({
  name: 'fixture', private: true, type: 'module',
  scripts: { build: 'vite build' },
  dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
  devDependencies: { vite: '^6.0.0', '@vitejs/plugin-react': '^4.3.4' },
}))
w('frontend/index.html', '<!doctype html><div id="root"></div><script type="module" src="/src/main.jsx"></script>')
w('frontend/vite.config.js', "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({ plugins: [react()] })\n")
w('frontend/src/main.jsx', "import { createRoot } from 'react-dom/client'\nimport App from './App'\n\ncreateRoot(document.getElementById('root')).render(<App />)\n")
w('frontend/src/App.jsx', "import { useAuth } from './auth'\n\nexport default function App() {\n  const { user } = useAuth()\n  return <p>{user ? 'signed in' : 'signed out'}</p>\n}\n")
w('backend/requirements.txt', 'fastapi\n')
w('backend/main.py', 'from fastapi import FastAPI\n\napp = FastAPI()\n')

// --install makes the CLI itself run "npm install firebase" in the frontend
run('node', [CLI, 'add', '--yes', '--install', '--option', `ui=${ui}`], root)
const main = fs.readFileSync(path.join(root, 'frontend/src/main.jsx'), 'utf8')
assert.match(main, ui === 'default' ? /<AuthGate>/ : /<AuthProvider>/)

run('npm', ['install', '--no-audit', '--no-fund'], path.join(root, 'frontend'))
run('npm', ['run', 'build'], path.join(root, 'frontend'), {
  VITE_FIREBASE_API_KEY: 'x', VITE_FIREBASE_AUTH_DOMAIN: 'x.firebaseapp.com', VITE_FIREBASE_PROJECT_ID: 'x', VITE_FIREBASE_APP_ID: 'x',
})

const assets = fs.readdirSync(path.join(root, 'frontend/dist/assets'))
const css = assets.filter((f) => f.endsWith('.css')).length
assert.equal(css > 0, ui === 'default', `ui=${ui}: expected ${ui === 'default' ? 'CSS' : 'no CSS'} in the bundle, found ${css} file(s)`)
console.log(`ok  ${ui}: installed into a fresh Vite project and built (${assets.length} assets, ${css} css)`)
fs.rmSync(root, { recursive: true, force: true })
