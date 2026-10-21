// Project detection: figure out what frontend/backend the user already has,
// so the CLI can suggest the right stack variant and folders.
// Pure functions over the filesystem, no side effects.

import fs from 'node:fs'
import path from 'node:path'

const SKIP_DIRS = new Set(['node_modules', 'venv', 'env', 'dist', 'build', 'out', 'coverage', '__pycache__', 'site-packages'])
const FRONTEND_NAMES = ['frontend', 'client', 'web', 'app', 'ui', 'site']
const BACKEND_NAMES = ['backend', 'server', 'api', 'service']

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const readJson = (file) => {
  const text = readText(file)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const hasFile = (dir, ...names) => names.some((n) => fs.existsSync(path.join(dir, n)))

/** The root plus its sub-folders down to maxDepth (skips node_modules, venvs, dot-folders). */
export function scanDirs(root, maxDepth = 2) {
  const out = [{ dir: root, depth: 0 }]
  let level = [root]
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next = []
    for (const dir of level) {
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
        const full = path.join(dir, entry.name)
        out.push({ dir: full, depth })
        next.push(full)
      }
    }
    level = next
  }
  return out
}

/** Is `dir` a JS frontend? Returns { side, dir, tags, label } or null. */
export function detectFrontend(dir) {
  const pkg = readJson(path.join(dir, 'package.json'))
  if (!pkg) return null
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const has = (name) => name in deps

  const tags = new Set()
  if (has('react')) tags.add('react')
  if (has('next')) {
    tags.add('next')
    tags.add('react')
  }
  if (has('react-scripts')) tags.add('cra')
  if (has('vue')) tags.add('vue')
  if (has('svelte')) tags.add('svelte')
  if (has('@angular/core')) tags.add('angular')
  if (has('vite') || hasFile(dir, 'vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts')) tags.add('vite')

  if (!['react', 'vue', 'svelte', 'angular', 'vite'].some((t) => tags.has(t))) return null

  if (has('typescript') || hasFile(dir, 'tsconfig.json')) tags.add('typescript')
  if (has('tailwindcss')) tags.add('tailwind')
  if (has('firebase')) tags.add('firebase')
  if (has('react-router-dom') || has('react-router')) tags.add('react-router')

  const parts = []
  if (tags.has('next')) parts.push('Next.js')
  else if (tags.has('cra')) parts.push('React (CRA)')
  else if (tags.has('react')) parts.push('React')
  else if (tags.has('vue')) parts.push('Vue')
  else if (tags.has('svelte')) parts.push('Svelte')
  else if (tags.has('angular')) parts.push('Angular')
  if (tags.has('vite')) parts.push('Vite')
  let label = parts.join(' + ') || 'JS frontend'
  if (tags.has('typescript')) label += ' (TypeScript)'

  return { side: 'frontend', dir, tags: [...tags], label }
}

const NODE_ENTRIES = ['server.js', 'app.js', 'index.js', 'main.js', 'src/server.js', 'src/app.js', 'src/index.js', 'src/main.js', 'server.mjs', 'app.mjs', 'index.mjs', 'server.cjs', 'app.cjs', 'index.cjs']

/** The file that creates the app (package.json main / start script first, then the usual names) and the port it listens on. */
function findNodeEntry(dir, pkg) {
  const fromScripts = ['start', 'dev'].flatMap((k) => [...String(pkg.scripts?.[k] ?? '').matchAll(/([\w./-]+\.[cm]?js)\b/g)].map((m) => m[1].replace(/^\.\//, '')))
  const names = [...new Set([pkg.main, ...fromScripts, ...NODE_ENTRIES].filter((n) => typeof n === 'string'))]
  for (const name of names) {
    const text = readText(path.join(dir, name))
    if (!text || !/\bexpress\s*\(|\bfastify\s*\(|\bnew\s+Koa\s*\(|\bHono\s*\(/.test(text)) continue
    const port = /\bPORT\s*(?:\|\||\?\?)\s*(\d{2,5})\b/.exec(text) ?? /\.listen\(\s*(\d{2,5})\b/.exec(text) ?? /\b(?:const|let|var)\s+(?:port|PORT)\s*=\s*(\d{2,5})\b/.exec(text)
    return { entry: name, port: port ? Number(port[1]) : null }
  }
  return { entry: null, port: null }
}

/** Is `dir` a backend (Python or Node)? Returns { side, dir, tags, label, entry } or null. */
export function detectBackend(dir) {
  // Python
  const manifests = ['requirements.txt', 'pyproject.toml', 'Pipfile']
    .map((n) => readText(path.join(dir, n)))
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  const entryFile = ['main.py', 'app.py', 'server.py'].find((n) => {
    const text = readText(path.join(dir, n))
    return text && /\b(FastAPI|Flask)\(/.test(text)
  })
  const entryText = entryFile ? readText(path.join(dir, entryFile)) : ''

  const pyTags = new Set()
  if (/fastapi/.test(manifests) || /FastAPI\(/.test(entryText)) pyTags.add('fastapi')
  if (/flask/.test(manifests) || /Flask\(/.test(entryText)) pyTags.add('flask')
  if (/django/.test(manifests) || hasFile(dir, 'manage.py')) pyTags.add('django')
  if (pyTags.size || manifests) {
    pyTags.add('python')
    const framework = ['fastapi', 'flask', 'django'].find((t) => pyTags.has(t))
    const label = framework ? `${{ fastapi: 'FastAPI', flask: 'Flask', django: 'Django' }[framework]} (Python)` : 'Python'
    const port = /\bport\s*=\s*(\d{2,5})\b/.exec(entryText ?? '')?.[1]
    return { side: 'backend', dir, tags: [...pyTags], label, entry: entryFile || null, ...(port ? { port: Number(port) } : {}) }
  }

  // Node
  const pkg = readJson(path.join(dir, 'package.json'))
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const nodeTags = new Set()
    if ('express' in deps) nodeTags.add('express')
    if ('fastify' in deps) nodeTags.add('fastify')
    if ('@nestjs/core' in deps) nodeTags.add('nest')
    if ('koa' in deps) nodeTags.add('koa')
    if ('hono' in deps) nodeTags.add('hono')
    if (nodeTags.size) {
      nodeTags.add('node')
      const names = { express: 'Express', fastify: 'Fastify', nest: 'NestJS', koa: 'Koa', hono: 'Hono' }
      const framework = Object.keys(names).find((t) => nodeTags.has(t))
      const { entry, port } = findNodeEntry(dir, pkg)
      return { side: 'backend', dir, tags: [...nodeTags], label: `${names[framework]} (Node)`, entry, ...(port ? { port } : {}) }
    }
  }
  return null
}

/** Scan `root` and return every frontend/backend candidate, best guess first. */
export function detectProject(root) {
  const frontends = []
  const backends = []
  for (const { dir, depth } of scanDirs(root)) {
    const f = detectFrontend(dir)
    if (f) frontends.push({ ...f, depth, packageManager: detectPackageManager(dir, root) })
    const b = detectBackend(dir)
    if (b) backends.push({ ...b, depth, ...(b.tags.includes('python') ? { pythonManager: detectPythonManager(dir) } : {}) })
  }
  // Shallower first; a conventional folder name (frontend/, api/, ...) breaks ties.
  const rank = (names) => (c) => c.depth * 2 + (names.includes(path.basename(c.dir).toLowerCase()) ? 0 : 1)
  frontends.sort((a, b) => rank(FRONTEND_NAMES)(a) - rank(FRONTEND_NAMES)(b))
  backends.sort((a, b) => rank(BACKEND_NAMES)(a) - rank(BACKEND_NAMES)(b))
  return { root, frontends, backends }
}

/**
 * How well does a detected folder fit what a stack variant expects?
 *   required: tags from feature.json "detect" (all must be present), e.g. ["react", "vite"]
 */
export function fitSide(required, found) {
  if (!required || required.length === 0) return { status: 'unknown' }
  const describe = (t) => (Array.isArray(t) ? `(${t.join(' | ')})` : t)
  const expects = required.map(describe).join(' + ')
  if (!found) return { status: 'none', expects }
  const present = (t) => (Array.isArray(t) ? t.some((x) => found.tags.includes(x)) : found.tags.includes(t))
  const missing = required.filter((t) => !present(t))
  if (missing.length === 0) return { status: 'match' }
  return { status: 'mismatch', expects, found: found.label }
}

/**
 * Which package manager does this JS project use? Looks for a lockfile in `dir`, then in the
 * folders above it up to `root` (monorepos keep one lockfile at the top), then the
 * "packageManager" field of package.json. Falls back to npm.
 */
export function detectPackageManager(dir, root = dir) {
  const locks = [
    ['pnpm', ['pnpm-lock.yaml']],
    ['yarn', ['yarn.lock']],
    ['bun', ['bun.lockb', 'bun.lock']],
    ['npm', ['package-lock.json', 'npm-shrinkwrap.json']],
  ]
  let cur = path.resolve(dir)
  const top = path.resolve(root)
  for (;;) {
    for (const [name, files] of locks) if (hasFile(cur, ...files)) return name
    const field = readJson(path.join(cur, 'package.json'))?.packageManager
    const named = typeof field === 'string' ? field.split('@')[0] : ''
    if (['pnpm', 'yarn', 'bun', 'npm'].includes(named)) return named
    if (cur === top) break
    const parent = path.dirname(cur)
    if (parent === cur || !parent.startsWith(top)) break
    cur = parent
  }
  return 'npm'
}

/** The command that adds JS packages with that package manager. */
export function jsInstallCommand(pm, packages) {
  const list = packages.join(' ')
  if (pm === 'pnpm') return `pnpm add ${list}`
  if (pm === 'yarn') return `yarn add ${list}`
  if (pm === 'bun') return `bun add ${list}`
  return `npm install ${list}`
}

/** poetry / uv / pipenv / pip, from the files in a Python folder. */
export function detectPythonManager(dir) {
  const pyproject = readText(path.join(dir, 'pyproject.toml')) ?? ''
  if (hasFile(dir, 'poetry.lock') || /^\[tool\.poetry\]/m.test(pyproject)) return 'poetry'
  if (hasFile(dir, 'uv.lock') || /^\[tool\.uv\]/m.test(pyproject)) return 'uv'
  if (hasFile(dir, 'Pipfile')) return 'pipenv'
  return 'pip'
}

/** The command that adds Python packages with that manager. */
export function pyInstallCommand(manager, packages) {
  const quoted = packages.map((p) => (p.includes('[') ? `"${p}"` : p)).join(' ')
  if (manager === 'poetry') return `poetry add ${quoted}`
  if (manager === 'uv') return `uv add ${quoted}`
  if (manager === 'pipenv') return `pipenv install ${quoted}`
  return `pip install ${quoted}`
}
