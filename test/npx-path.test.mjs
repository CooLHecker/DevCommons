// Regression: when devcommons itself lives under a node_modules folder (as it does with npx),
// the copy step must still copy the feature files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('copies files when the catalogue sits inside node_modules', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-npx-'))
  const copy = path.join(tmp, 'node_modules', 'devcommons')
  fs.cpSync(ROOT, copy, { recursive: true, filter: (s) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(path.relative(ROOT, s)) })
  const proj = path.join(tmp, 'proj')
  fs.mkdirSync(path.join(proj, 'server'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'server', 'package.json'), JSON.stringify({ dependencies: { express: '^4' } }))
  fs.writeFileSync(path.join(proj, 'server', 'app.js'), "const express = require('express')\nconst app = express()\nmodule.exports = app\n")
  const r = spawnSync(process.execPath, [path.join(copy, 'scripts', 'cli.mjs'), 'add', 'auth', 'express-firebase', '--backend', './server', '--yes'], { cwd: proj, encoding: 'utf8' })
  assert.ok(fs.existsSync(path.join(proj, 'server', 'auth_module', 'index.js')), r.stdout + r.stderr)
})
