import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const CLI = fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url))

/** A small Vite + FastAPI project in a temp folder. */
export function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-e2e-'))
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  w('frontend/package.json', '{"dependencies":{"react":"18"},"devDependencies":{"vite":"5"}}')
  w('frontend/src/main.jsx', "import { createRoot } from 'react-dom/client'\nimport App from './App'\ncreateRoot(document.getElementById('root')).render(<App />)\n")
  w('frontend/vite.config.js', "import { defineConfig } from 'vite'\nexport default defineConfig({ plugins: [] })\n")
  w('backend/requirements.txt', 'fastapi\n')
  w('backend/main.py', 'from fastapi import FastAPI\n\napp = FastAPI()\n')
  return root
}

export const cli = (cwd, ...args) => spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', timeout: 30000, input: '' })
export const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')
export const exists = (root, rel) => fs.existsSync(path.join(root, rel))
export const write = (root, rel, text) => fs.writeFileSync(path.join(root, rel), text)

export const EDITED = ['frontend/src/main.jsx', 'frontend/vite.config.js', 'backend/main.py']
