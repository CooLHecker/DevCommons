import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectProject, detectFrontend, detectBackend, scanDirs, fitSide } from '../scripts/lib/detect.mjs'

/** Build a temp project from { 'relative/path': 'text' | object (written as JSON) }. */
function project(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-detect-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content))
  }
  return root
}

const pkg = (deps = {}, devDeps = {}) => ({ dependencies: deps, devDependencies: devDeps })
const rel = (root, c) => path.relative(root, c.dir).split(path.sep).join('/') || '.'

// ---------- scanDirs ----------

test('scanDirs: root plus two levels, skipping node_modules, venvs, dot-folders, build output', () => {
  const root = project({
    'a/b/c/deep.txt': '',
    'node_modules/x/y.txt': '',
    'venv/lib/z.txt': '',
    '.git/hooks/h.txt': '',
    'dist/out.txt': '',
    'src/ok/file.txt': '',
  })
  const dirs = scanDirs(root).map((d) => rel(root, d)).sort()
  assert.deepEqual(dirs, ['.', 'a', 'a/b', 'src', 'src/ok'])
})

test('scanDirs: a missing root does not throw', () => {
  assert.deepEqual(scanDirs(path.join(os.tmpdir(), 'dc-does-not-exist-xyz')).length, 1)
})

// ---------- empty / unrelated ----------

test('empty folder: nothing detected', () => {
  const found = detectProject(project())
  assert.deepEqual(found.frontends, [])
  assert.deepEqual(found.backends, [])
})

test('unrelated folder (docs, a plain package.json) is not a frontend or backend', () => {
  const root = project({ 'README.md': '# hi', 'package.json': pkg({ lodash: '4' }) })
  const found = detectProject(root)
  assert.equal(found.frontends.length, 0)
  assert.equal(found.backends.length, 0)
})

test('malformed package.json is ignored, not a crash', () => {
  const root = project({ 'package.json': '{ not json' })
  assert.doesNotThrow(() => detectProject(root))
  assert.equal(detectProject(root).frontends.length, 0)
})

// ---------- frontends ----------

test('React + Vite, tags and label', () => {
  const root = project({ 'package.json': pkg({ react: '18' }, { vite: '5' }) })
  const f = detectFrontend(root)
  assert.deepEqual([...f.tags].sort(), ['react', 'vite'])
  assert.equal(f.label, 'React + Vite')
})

test('Vite is recognised from vite.config alone', () => {
  const root = project({ 'package.json': pkg({ react: '18' }), 'vite.config.ts': 'export default {}' })
  assert.ok(detectFrontend(root).tags.includes('vite'))
})

test('Next.js implies react', () => {
  const f = detectFrontend(project({ 'package.json': pkg({ next: '14', react: '18' }) }))
  assert.ok(f.tags.includes('next') && f.tags.includes('react'))
  assert.equal(f.label, 'Next.js')
})

test('Next.js without an explicit react dependency still tags react', () => {
  const f = detectFrontend(project({ 'package.json': pkg({ next: '14' }) }))
  assert.ok(f.tags.includes('react'))
})

test('Create React App', () => {
  const f = detectFrontend(project({ 'package.json': pkg({ react: '18', 'react-scripts': '5' }) }))
  assert.ok(f.tags.includes('cra'))
  assert.equal(f.label, 'React (CRA)')
})

test('Vue, Svelte and Angular', () => {
  assert.ok(detectFrontend(project({ 'package.json': pkg({ vue: '3' }) })).tags.includes('vue'))
  assert.ok(detectFrontend(project({ 'package.json': pkg({}, { svelte: '4' }) })).tags.includes('svelte'))
  assert.ok(detectFrontend(project({ 'package.json': pkg({ '@angular/core': '17' }) })).tags.includes('angular'))
})

test('TypeScript, Tailwind, Firebase and react-router add tags', () => {
  const root = project({
    'package.json': pkg({ react: '18', firebase: '10', 'react-router-dom': '6' }, { typescript: '5', tailwindcss: '3', vite: '5' }),
  })
  const f = detectFrontend(root)
  for (const t of ['typescript', 'tailwind', 'firebase', 'react-router']) assert.ok(f.tags.includes(t), `missing ${t}`)
  assert.equal(f.label, 'React + Vite (TypeScript)')
})

test('TypeScript is detected from tsconfig.json too', () => {
  const root = project({ 'package.json': pkg({ react: '18' }), 'tsconfig.json': '{}' })
  assert.ok(detectFrontend(root).tags.includes('typescript'))
})

// ---------- backends ----------

test('FastAPI from requirements.txt', () => {
  const b = detectBackend(project({ 'requirements.txt': 'FastAPI==0.110\nuvicorn\n' }))
  assert.ok(b.tags.includes('fastapi') && b.tags.includes('python'))
  assert.equal(b.label, 'FastAPI (Python)')
})

test('FastAPI from the entry file when the manifest does not mention it', () => {
  const b = detectBackend(project({ 'requirements.txt': 'uvicorn\n', 'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n' }))
  assert.ok(b.tags.includes('fastapi'))
  assert.equal(b.entry, 'main.py')
})

test('Flask and Django', () => {
  assert.ok(detectBackend(project({ 'requirements.txt': 'flask\n' })).tags.includes('flask'))
  assert.ok(detectBackend(project({ 'requirements.txt': 'django\n' })).tags.includes('django'))
  assert.ok(detectBackend(project({ 'manage.py': '', 'requirements.txt': 'x\n' })).tags.includes('django'))
})

test('pyproject.toml counts as a Python manifest', () => {
  const b = detectBackend(project({ 'pyproject.toml': '[tool.poetry.dependencies]\nfastapi = "*"\n' }))
  assert.ok(b.tags.includes('fastapi'))
})

test('Node backends: Express, Fastify, Nest, Koa, Hono', () => {
  const cases = { express: 'express', fastify: 'fastify', '@nestjs/core': 'nest', koa: 'koa', hono: 'hono' }
  for (const [dep, tag] of Object.entries(cases)) {
    const b = detectBackend(project({ 'package.json': pkg({ [dep]: '1' }) }))
    assert.ok(b, `${dep} not detected`)
    assert.ok(b.tags.includes(tag) && b.tags.includes('node'))
  }
})

test('a React frontend is not mistaken for a Node backend', () => {
  assert.equal(detectBackend(project({ 'package.json': pkg({ react: '18' }, { vite: '5' }) })), null)
})

test('Python folder without a known framework is labelled plainly', () => {
  assert.equal(detectBackend(project({ 'requirements.txt': 'requests\n' })).label, 'Python')
})

test('known limit: any folder with a Python manifest is a backend candidate (docs/ included), ranked after a real one', () => {
  const root = project({ 'docs/requirements.txt': 'mkdocs\n', 'backend/requirements.txt': 'fastapi\n' })
  const found = detectProject(root)
  assert.deepEqual(found.backends.map((c) => rel(root, c)), ['backend', 'docs'])
})

// ---------- whole projects ----------

test('Vite + FastAPI in frontend/ and backend/', () => {
  const root = project({
    'frontend/package.json': pkg({ react: '18' }, { vite: '5' }),
    'backend/requirements.txt': 'fastapi\n',
    'backend/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  })
  const found = detectProject(root)
  assert.deepEqual(found.frontends.map((c) => rel(root, c)), ['frontend'])
  assert.deepEqual(found.backends.map((c) => rel(root, c)), ['backend'])
  assert.equal(found.backends[0].entry, 'main.py')
})

test('monorepo: apps/* and packages/* are found at depth 2', () => {
  const root = project({
    'apps/web/package.json': pkg({ react: '18' }, { vite: '5' }),
    'apps/api/requirements.txt': 'fastapi\n',
    'packages/ui/package.json': pkg({ react: '18' }),
  })
  const found = detectProject(root)
  assert.deepEqual(found.frontends.map((c) => rel(root, c)).sort(), ['apps/web', 'packages/ui'])
  assert.deepEqual(found.backends.map((c) => rel(root, c)), ['apps/api'])
  assert.ok(found.frontends.every((c) => c.depth === 2))
})

test('a project three levels down is out of reach (documented limit)', () => {
  const root = project({ 'a/b/c/package.json': pkg({ react: '18' }) })
  assert.equal(detectProject(root).frontends.length, 0)
})

test('two frontends: shallower wins, then a conventional folder name', () => {
  const root = project({
    'package.json': pkg({ react: '18' }),
    'client/package.json': pkg({ react: '18' }),
    'misc/package.json': pkg({ react: '18' }),
  })
  const order = detectProject(root).frontends.map((c) => rel(root, c))
  assert.equal(order[0], '.')
  assert.equal(order.indexOf('client') < order.indexOf('misc'), true)
})

test('two frontends at the same depth: the conventionally named one is first', () => {
  const root = project({
    'zzz/package.json': pkg({ react: '18' }),
    'web/package.json': pkg({ react: '18' }),
  })
  assert.equal(rel(root, detectProject(root).frontends[0]), 'web')
})

test('a frontend inside node_modules is never reported', () => {
  const root = project({ 'node_modules/some-lib/package.json': pkg({ react: '18' }) })
  assert.equal(detectProject(root).frontends.length, 0)
})

test('single-folder project: frontend and backend both at the root', () => {
  const root = project({
    'package.json': pkg({ react: '18' }, { vite: '5' }),
    'requirements.txt': 'fastapi\n',
  })
  const found = detectProject(root)
  assert.equal(rel(root, found.frontends[0]), '.')
  assert.equal(rel(root, found.backends[0]), '.')
})

// ---------- fitSide ----------

test('fitSide: unknown, none, match, mismatch', () => {
  const found = { tags: ['react', 'vite'], label: 'React + Vite' }
  assert.equal(fitSide(undefined, found).status, 'unknown')
  assert.equal(fitSide([], found).status, 'unknown')
  assert.equal(fitSide(['react'], null).status, 'none')
  assert.equal(fitSide(['react', 'vite'], found).status, 'match')
  const mm = fitSide(['react', 'next'], found)
  assert.equal(mm.status, 'mismatch')
  assert.equal(mm.found, 'React + Vite')
  assert.equal(mm.expects, 'react + next')
})
