import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cli, read, exists } from './helpers.mjs'
import { detectProject } from '../scripts/lib/detect.mjs'
import { planPatches, planReverts, applyPatches } from '../scripts/lib/patch.mjs'

const manifest = JSON.parse(fs.readFileSync(new URL('../features/auth/express-firebase/feature.json', import.meta.url), 'utf8'))

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-exp-'))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  return root
}

const CJS = "const express = require('express')\nconst app = express()\napp.use(express.json())\napp.listen(process.env.PORT || 4000)\n"
const ESM = "import express from 'express'\nimport cors from 'cors'\n\nconst app = express()\napp.listen(3000)\n"
const VITE_FRONT = {
  'web/package.json': '{"dependencies":{"react":"18"},"devDependencies":{"vite":"5"}}',
  'web/src/main.jsx': "import { createRoot } from 'react-dom/client'\nimport App from './App'\ncreateRoot(document.getElementById('root')).render(<App />)\n",
  'web/vite.config.js': "import { defineConfig } from 'vite'\nexport default defineConfig({ plugins: [] })\n",
}
const EXPRESS_BACK = (server = CJS) => ({ 'api/package.json': '{"dependencies":{"express":"4"}}', 'api/server.js': server })

const ctxFor = (root, extra = {}) => ({ dirs: { backend: path.join(root, 'api') }, vars: { frontendOrigin: 'http://localhost:5173' }, feature: 'auth', ...extra })
const plan = (root, extra) => planPatches(manifest.patches, ctxFor(root, extra))[0]

// ------------------------------------------------------------ detection

test('detect: Express entry file and port', () => {
  const a = detectProject(tree(EXPRESS_BACK())).backends[0]
  assert.deepEqual([a.entry, a.port], ['server.js', 4000])
  const b = detectProject(tree({ 'api/package.json': '{"dependencies":{"express":"4"},"scripts":{"start":"node src/boot.js"}}', 'api/src/boot.js': "const express = require('express')\nconst port = 8081\nexpress().listen(port)\n" })).backends[0]
  assert.equal(b.entry, 'src/boot.js')
  assert.equal(b.port, 8081)
  const c = detectProject(tree({ 'api/package.json': '{"dependencies":{"express":"4"}}' })).backends[0]
  assert.equal(c.entry, null)
  assert.ok(!('port' in c))
})

// ------------------------------------------------------------ js-setup-call patch

test('CommonJS app: adds the require and the call, idempotent, reverts byte for byte', () => {
  const root = tree(EXPRESS_BACK())
  const before = read(root, 'api/server.js')
  const r = plan(root)
  assert.equal(r.status, 'apply')
  applyPatches([r], root)
  assert.equal(
    read(root, 'api/server.js'),
    "const express = require('express')\nconst { setupAuth } = require('./auth_module') // devcommons:auth\nconst app = express()\n\nsetupAuth(app, { corsOrigins: ['http://localhost:5173'] }) // devcommons:auth\napp.use(express.json())\napp.listen(process.env.PORT || 4000)\n",
  )
  assert.equal(plan(root).status, 'applied')
  const [u] = planReverts(manifest.patches, ctxFor(root))
  applyPatches([u], root)
  assert.equal(read(root, 'api/server.js'), before)
})

test('ES-module app: import with the .js extension, semicolons and double quotes kept, reverts', () => {
  const src = 'import express from "express";\nimport path from "node:path";\n\nconst app = express();\napp.listen(3000);\n'
  const root = tree(EXPRESS_BACK(src))
  const r = plan(root)
  applyPatches([r], root)
  const out = read(root, 'api/server.js')
  assert.match(out, /import \{ setupAuth \} from "\.\/auth_module\/index\.js"; \/\/ devcommons:auth/)
  assert.match(out, /setupAuth\(app, \{ corsOrigins: \['http:\/\/localhost:5173'\] \}\); \/\/ devcommons:auth/)
  assert.ok(out.indexOf('setupAuth } from') > out.indexOf('node:path'), 'import goes after the existing imports')
  const [u] = planReverts(manifest.patches, ctxFor(root))
  applyPatches([u], root)
  assert.equal(read(root, 'api/server.js'), src)
})

test('an app that already uses the cors package gets setupAuth(app) without corsOrigins', () => {
  const root = tree(EXPRESS_BACK(ESM))
  applyPatches([plan(root)], root)
  const out = read(root, 'api/server.js')
  assert.match(out, /\nsetupAuth\(app\) \/\/ devcommons:auth\n/)
  assert.doesNotMatch(out, /corsOrigins/)
})

test('an entry in src/ named by the detector is found; a nested module path is computed', () => {
  const root = tree({ 'api/package.json': '{"dependencies":{"express":"4"}}', 'api/src/app.js': "const express = require('express')\nconst app = express()\n" })
  const entry = 'src/app.js'
  const r = plan(root, { entry })
  assert.equal(r.status, 'apply')
  applyPatches([r], root)
  assert.match(read(root, 'api/src/app.js'), /require\('\.\.\/auth_module'\)/)
})

test('use strict / shebang stay on top when there is nothing to import after', () => {
  const root = tree(EXPRESS_BACK("#!/usr/bin/env node\n'use strict'\nconst app = require('express')()\n"))
  // `require('express')()` is not the shape we edit: it must fall back, not guess
  assert.equal(plan(root).status, 'manual')
  const root2 = tree(EXPRESS_BACK("'use strict'\nvar express = require('express')\nvar app = express()\n"))
  assert.equal(plan(root2).status, 'apply')
})

test('no app found, or an unreadable layout: manual steps, nothing written', () => {
  const root = tree(EXPRESS_BACK("module.exports = require('./boot')\n"))
  const r = plan(root)
  assert.equal(r.status, 'manual')
  assert.match(r.reason, /express\(\)/)
  assert.match(r.manualLines.join('\n'), /setupAuth\(app, \{ corsOrigins: \['http:\/\/localhost:5173'\] \}\)/)
})

test('revert leaves a file alone when devcommons did not edit it', () => {
  const root = tree(EXPRESS_BACK())
  assert.equal(planReverts(manifest.patches, ctxFor(root))[0].status, 'absent')
})

// ------------------------------------------------------------ end to end: each half gets its own stack

test('--yes on React+Vite with an Express API: Express module in api/, React half in web/, no FastAPI anywhere', () => {
  const root = tree({ ...VITE_FRONT, ...EXPRESS_BACK("const express = require('express')\nconst app = express()\napp.listen(process.env.PORT || 4000)\n") })
  const r = cli(root, 'add', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)

  assert.ok(exists(root, 'api/auth_module/core.js'))
  assert.ok(!exists(root, 'api/auth_module/main.py') && !exists(root, 'api/auth_module/routes.py'))
  assert.match(read(root, 'api/server.js'), /setupAuth\(app, \{ corsOrigins: \['http:\/\/localhost:5173'\] \}\)/)
  assert.match(read(root, 'api/.env'), /GOOGLE_APPLICATION_CREDENTIALS/)

  assert.ok(exists(root, 'web/src/auth/core/AuthContext.jsx'))
  assert.ok(!exists(root, 'web/auth_module') && !exists(root, 'web/.env.example'))
  assert.match(read(root, 'web/src/main.jsx'), /<AuthGate>/)
  assert.match(read(root, 'web/vite.config.js'), /'\/api': 'http:\/\/localhost:4000'/, 'proxy follows the port found in server.js')

  const rec = JSON.parse(read(root, '.devcommons.json')).features
  assert.deepEqual(rec.map((f) => [f.stack, f.frontend, f.backend]).sort(), [
    ['express-firebase', null, './api'],
    ['react-vite-fastapi-firebase', './web', null],
  ])
  assert.match(r.stdout, /npm install firebase-admin dotenv/)
})

test('that install removes cleanly, half by half', () => {
  const root = tree({ ...VITE_FRONT, ...EXPRESS_BACK() })
  const originals = Object.fromEntries(['web/src/main.jsx', 'web/vite.config.js', 'api/server.js'].map((f) => [f, read(root, f)]))
  cli(root, 'add', '--yes')
  const rm1 = cli(root, 'remove', 'auth', 'express-firebase', '--yes')
  assert.equal(rm1.status, 0, rm1.stderr + rm1.stdout)
  assert.equal(read(root, 'api/server.js'), originals['api/server.js'])
  assert.ok(!exists(root, 'api/auth_module'))
  assert.ok(exists(root, 'web/src/auth'), 'the frontend half is untouched')
  const rm2 = cli(root, 'remove', 'auth', 'react-vite-fastapi-firebase', '--yes')
  assert.equal(rm2.status, 0, rm2.stderr + rm2.stdout)
  for (const [f, text] of Object.entries(originals)) assert.equal(read(root, f), text, f)
  assert.ok(!exists(root, '.devcommons.json'))
})

test('Express only, no frontend: installs the backend and stops there', () => {
  const root = tree(EXPRESS_BACK())
  const r = cli(root, 'add', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(exists(root, 'api/auth_module/index.js'))
  assert.match(read(root, 'api/server.js'), /setupAuth\(app/)
  assert.doesNotMatch(r.stdout, /The frontend part/)
})

test('React + FastAPI projects are unchanged: one stack, both halves', () => {
  const root = tree({
    ...VITE_FRONT,
    'backend/requirements.txt': 'fastapi\n',
    'backend/main.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n',
  })
  const r = cli(root, 'add', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(exists(root, 'backend/auth_module/routes.py'))
  assert.ok(exists(root, 'web/src/auth/index.js'))
  assert.equal(JSON.parse(read(root, '.devcommons.json')).features.length, 1)
})

test('naming the stack with --yes installs that stack and tells you what is left, without doing it', () => {
  const root = tree({ ...VITE_FRONT, ...EXPRESS_BACK() })
  const r = cli(root, 'add', 'auth', 'express-firebase', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(exists(root, 'api/auth_module/index.js'))
  assert.ok(!exists(root, 'web/src/auth'))
  assert.match(r.stdout, /Next: devcommons add auth react-vite-fastapi-firebase --frontend \.\/web/)
})

test('the FastAPI stack named against an Express project leaves the backend alone', () => {
  const root = tree({ ...VITE_FRONT, ...EXPRESS_BACK() })
  const r = cli(root, 'add', 'auth', 'react-vite-fastapi-firebase', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /Not installing the backend part: found Express \(Node\)/)
  assert.ok(!exists(root, 'api/auth_module/routes.py'))
  assert.ok(exists(root, 'web/src/auth/index.js'))
  assert.match(r.stdout, /Next: devcommons add auth express-firebase --backend \.\/api/)
})

test('--dry-run shows both halves and changes nothing', () => {
  const root = tree({ ...VITE_FRONT, ...EXPRESS_BACK() })
  const r = cli(root, 'add', '--yes', '--dry-run')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /Adding auth \(express-firebase\)/)
  assert.match(r.stdout, /Adding auth \(react-vite-fastapi-firebase\)/)
  assert.ok(!exists(root, 'api/auth_module') && !exists(root, 'web/src/auth') && !exists(root, '.devcommons.json'))
})

test('an ES-module Express project and a pnpm backend', () => {
  const root = tree({ ...VITE_FRONT, 'api/package.json': '{"type":"module","dependencies":{"express":"4"}}', 'api/pnpm-lock.yaml': '', 'api/server.js': ESM })
  const r = cli(root, 'add', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(read(root, 'api/server.js'), /import \{ setupAuth \} from '\.\/auth_module\/index\.js'/)
  assert.match(r.stdout, /pnpm add firebase-admin dotenv/)
  assert.match(read(root, 'web/vite.config.js'), /localhost:3000/)
})

test('explicit folders and --patch install only the stack you name, only into the folder you name', () => {
  const root = tree({ ...VITE_FRONT, ...EXPRESS_BACK() })
  const r = cli(root, 'add', 'auth', 'express-firebase', '--backend', 'api', '--patch')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(exists(root, 'api/auth_module/index.js'))
  assert.ok(!exists(root, 'web/src/auth'))
  assert.doesNotMatch(r.stdout, /The frontend part/)
})
