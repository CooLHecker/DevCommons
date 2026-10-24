// devcommons doctor: is an installed feature still healthy?
//
// Pure checks over an install record + the project folders; the CLI prints the results.
// Every check returns { area, status: 'ok' | 'warn' | 'fail' | 'skip', title, detail?, fix? }.
// Rules: never print an env value (names only), never print key material, never change a file.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { planPatches } from './patch.mjs'
import { detectBackend, detectFrontend, detectPackageManager, detectPythonManager, jsInstallCommand, pyInstallCommand } from './detect.mjs'
import { readEnvFiles, envLookup, parseEnv } from './envfile.mjs'
import { gitRepo, isIgnored, isTracked, trackedMatching, looksSecret, redact, keyFilePath, secretTargets } from './safety.mjs'

export const AREAS = ['Files', 'Edits to your files', 'Environment', 'Packages', 'Connection', 'Safety']
const EDITS = AREAS[1]

const R = (area, status, title, extra = {}) => ({ area, status, title, ...extra })
const exists = (p) => fs.existsSync(p)
const readText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const posix = (p) => p.split(path.sep).join('/')
const relTo = (cwd, p) => {
  const r = path.relative(cwd, p)
  return !r ? '.' : r.startsWith('..') || path.isAbsolute(r) ? p : `./${posix(r)}`
}
const list = (items, max = 6) => (items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`)
const SKIP_DIRS = new Set(['node_modules', 'venv', '.venv', 'env', 'dist', 'build', '__pycache__', '.git', 'site-packages', 'auth_module'])

/** Same hash the installer records (line endings ignored). Keep in sync with hashFile in cli.mjs. */
const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file).toString('utf8').replace(/\r\n/g, '\n')).digest('hex')

function walk(dir, exts, limit = 400) {
  const out = []
  const stack = [dir]
  while (stack.length && out.length < limit) {
    const cur = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(path.join(cur, e.name))
      } else if (exts.includes(path.extname(e.name))) out.push(path.join(cur, e.name))
    }
  }
  return out
}

// ---------------------------------------------------------------- the entry point

/**
 * ctx: { entry (from .devcommons.json), variant (catalogue variant, env keys already renamed),
 *        chosen ({ frontend?, backend?, options }), cwd, flags, conformance?, io? }
 * io (tests): { fetch, run }
 */
export async function runDoctor(ctx) {
  const io = { fetch: globalThis.fetch, run: spawnSync, ...ctx.io }
  const c = { ...ctx, io, flags: ctx.flags ?? {}, repo: gitRepo(ctx.cwd) }
  const results = []
  results.push(...checkFiles(c))
  results.push(...checkEdits(c))
  results.push(...checkEnvironment(c))
  results.push(...checkPackages(c))
  results.push(...(await checkConnection(c)))
  results.push(...checkSafety(c))
  return results
}

export const summarize = (results) => ({
  ok: results.filter((r) => r.status === 'ok').length,
  warn: results.filter((r) => r.status === 'warn').length,
  fail: results.filter((r) => r.status === 'fail').length,
  skip: results.filter((r) => r.status === 'skip').length,
})

// ---------------------------------------------------------------- files

function checkFiles({ entry, variant, chosen, cwd }) {
  const out = []
  const area = AREAS[0]
  const latest = variant.manifest.version
  if (entry.version && entry.version !== latest) {
    out.push(R(area, 'warn', `installed ${entry.feature} ${entry.version}; this devcommons ships ${latest}`, { fix: `devcommons update ${entry.feature}` }))
  }
  for (const side of ['frontend', 'backend']) {
    if (entry[side] && !chosen[side]) out.push(R(area, 'fail', `the ${side} folder ${entry[side]} no longer exists`, { fix: `restore the folder, or run: devcommons remove ${entry.feature}` }))
  }

  let present = 0
  let edited = 0
  const missing = []
  if (entry.hashes) {
    for (const [key, hash] of Object.entries(entry.hashes)) {
      const file = path.join(cwd, ...key.split('/'))
      if (!exists(file)) missing.push(key)
      else {
        present++
        if (hashFile(file) !== hash) edited++
      }
    }
  } else {
    for (const p of entry.copied ?? []) (exists(path.join(cwd, p)) ? present++ : missing.push(p))
  }
  if (missing.length) {
    out.push(
      R(area, 'fail', `${missing.length} installed file(s) are missing`, {
        detail: list(missing, 8),
        fix: `restore them (git checkout), or: devcommons remove ${entry.feature} && devcommons add ${entry.feature} ${entry.stack}`,
      }),
    )
  } else if (present) {
    out.push(R(area, 'ok', `${present} installed file(s) present${edited ? `, ${edited} edited by you (fine)` : ''}`))
  }
  return out
}

// ---------------------------------------------------------------- edits (wrap, setup call, ...)

const PROXY_TYPES = new Set(['vite-proxy', 'cra-proxy']) // judged in "Connection", where the env alternative is known

/** Is the patch's effect somewhere other than the entry file (user wired it by hand)? Returns the file or null. */
function foundElsewhere(patch, side, dir) {
  let re
  let exts
  if (patch.type === 'wrap-root') {
    re = new RegExp(`<${patch.component}[\\s>/]`)
    exts = ['.js', '.jsx', '.ts', '.tsx', '.mjs']
  } else {
    const name = /^\s*(\w+)\s*\(/.exec(patch.call ?? '')?.[1]
    if (!name) return null
    re = new RegExp(`\\b${name}\\s*\\(`)
    exts = patch.type === 'py-setup-call' ? ['.py'] : ['.js', '.mjs', '.cjs', '.ts']
  }
  const root = side === 'frontend' ? path.join(dir, 'src') : dir
  const skipModule = patch.type === 'wrap-root' ? path.join(dir, patch.module ?? 'src/auth') : null
  for (const file of walk(root, exts)) {
    if (skipModule && file.startsWith(skipModule + path.sep)) continue
    const text = readText(file)
    if (text && re.test(text)) return file
  }
  return null
}

function folderFlags(entry) {
  return ['frontend', 'backend'].filter((s) => entry[s]).map((s) => `--${s} ${entry[s]}`).join(' ')
}

function checkEdits({ entry, variant, chosen, cwd }) {
  const manifest = variant.manifest
  if (!manifest.patches) return []
  const backend = chosen.backend ? detectBackend(chosen.backend) : null
  const plan = planPatches(manifest.patches, {
    dirs: { frontend: chosen.frontend, backend: chosen.backend },
    vars: { backendUrl: 'http://localhost:8000', frontendOrigin: 'http://localhost:5173' },
    entry: backend?.entry ?? null,
    feature: entry.feature,
    options: chosen.options,
  })
  const out = []
  for (const r of plan) {
    if (PROXY_TYPES.has(r.type)) continue
    const def = (manifest.patches[r.side] ?? []).find((p) => (p.id ?? p.type) === r.id)
    if (r.status === 'applied') {
      out.push(R(EDITS, 'ok', `${r.id} is in place`))
    } else if (r.status === 'apply') {
      const elsewhere = def ? foundElsewhere(def, r.side, chosen[r.side]) : null
      if (elsewhere) out.push(R(EDITS, 'ok', `${r.id} is in place`, { detail: `found in ${relTo(cwd, elsewhere)}` }))
      else {
        out.push(
          R(EDITS, 'fail', `${r.id} is not applied (nothing in ${relTo(cwd, r.file)})`, {
            detail: 'the feature is installed but not wired into your app',
            fix: `devcommons add ${entry.feature} ${entry.stack} ${folderFlags(entry)} --patch`,
          }),
        )
      }
    } else if (r.status === 'manual') {
      out.push(R(EDITS, 'warn', `${r.id}: could not check (${r.reason})`, { fix: r.manualLines.length ? r.manualLines.filter(Boolean) : undefined }))
    }
  }
  return out
}

// ---------------------------------------------------------------- environment

function validateServiceAccount(obj) {
  const problems = []
  if (!obj || typeof obj !== 'object') return { problems: ['not a JSON object'], projectId: null }
  if (obj.type !== 'service_account') problems.push('"type" is not service_account (is this the web-app config instead of a service-account key?)')
  for (const k of ['project_id', 'private_key', 'client_email']) if (typeof obj[k] !== 'string' || !obj[k]) problems.push(`"${k}" is missing`)
  if (typeof obj.private_key === 'string' && obj.private_key && !/BEGIN [A-Z ]*PRIVATE KEY/.test(obj.private_key)) problems.push('"private_key" does not look like a key')
  return { problems, projectId: typeof obj.project_id === 'string' ? obj.project_id : null }
}

function checkEnvironment({ entry, variant, chosen, cwd }) {
  const area = AREAS[2]
  const manifest = variant.manifest
  const out = []
  const envs = {}
  for (const side of ['frontend', 'backend']) if (chosen[side]) envs[side] = readEnvFiles(chosen[side], side)
  const secretEnvNames = new Set((manifest.secrets?.files ?? []).flatMap((s) => [s.env, s.inlineEnv, s.adcEnv].filter(Boolean)))

  for (const side of ['frontend', 'backend']) {
    const defaults = manifest.envDefaults?.[side]
    if (!chosen[side] || !defaults) continue
    const keys = Object.keys(defaults).filter((k) => !secretEnvNames.has(k))
    if (keys.length === 0) continue
    const unset = keys.filter((k) => !envLookup(envs[side], k)?.value)
    if (unset.length === 0) {
      out.push(R(area, 'ok', `${side}: all ${keys.length} setting(s) have a value`, { detail: list(keys) }))
      continue
    }
    const help = (manifest.postInstall?.[side] ?? []).map((i) => (typeof i === 'string' ? null : i)).filter(Boolean).find((i) => (i.unlessFilled ?? []).some((k) => unset.includes(k)))?.text
    out.push(
      R(area, 'fail', `${side}: ${unset.length} of ${keys.length} setting(s) not set`, {
        detail: unset.join(', '),
        fix: `${help ?? 'Fill them in'}${envs[side].length ? '' : ` (no .env in ${relTo(cwd, chosen[side])} yet)`}`,
      }),
    )
  }

  for (const def of manifest.secrets?.files ?? []) {
    const dir = chosen[def.side]
    if (!dir) continue
    out.push(...checkKeyFile(def, dir, envs, manifest, chosen, cwd))
  }

  // a private key in a variable the browser bundle can read
  for (const f of envs.frontend ?? []) {
    const leaks = [...f.values].filter(([, v]) => looksSecret(v)).map(([k]) => k)
    if (leaks.length) out.push(R(area, 'fail', `${f.name} in the frontend holds key material (${list(leaks)})`, { detail: 'variables in the frontend are bundled into the page everyone downloads', fix: 'remove it from the frontend; the service-account key belongs on the backend only' }))
  }
  return out
}

function checkKeyFile(def, dir, envs, manifest, chosen, cwd) {
  const area = AREAS[2]
  const label = def.label ?? def.env
  const lookup = (k) => envLookup(envs[def.side] ?? [], k)
  const inline = def.inlineEnv ? lookup(def.inlineEnv)?.value : ''
  const keyPath = lookup(def.env)?.value
  const adc = def.adcEnv ? lookup(def.adcEnv)?.value : ''
  let projectId = null
  const out = []

  if (inline) {
    let obj = null
    try {
      obj = JSON.parse(inline)
    } catch {
      /* message below is fixed text on purpose: a parse error can quote the secret */
    }
    const v = validateServiceAccount(obj)
    if (v.problems.length) return [R(area, 'fail', `${def.inlineEnv} is not a valid ${label}`, { detail: v.problems.join('; '), fix: def.help })]
    projectId = v.projectId
    out.push(R(area, 'ok', `${label} is set through ${def.inlineEnv}`, { detail: projectId ? `project ${projectId}` : undefined }))
  } else if (keyPath) {
    const file = keyFilePath(dir, keyPath)
    if (!file || !exists(file) || !fs.statSync(file).isFile()) {
      return [
        R(area, 'fail', `${label} not found at ${file ? relTo(cwd, file) : keyPath}`, {
          detail: `${def.env} points there; relative paths are resolved from the folder you start the server in`,
          fix: def.help,
        }),
      ]
    }
    let obj = null
    try {
      obj = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      /* fixed text below */
    }
    const v = validateServiceAccount(obj)
    if (v.problems.length) return [R(area, 'fail', `${label} (${relTo(cwd, file)}) is not valid`, { detail: v.problems.join('; '), fix: def.help })]
    projectId = v.projectId
    out.push(R(area, 'ok', `${label} found and valid`, { detail: `${relTo(cwd, file)}${projectId ? `, project ${projectId}` : ''}` }))
  } else if (adc) {
    projectId = adc
    out.push(R(area, 'ok', `${label}: using the platform's default credentials for project ${adc}`, { detail: 'not checked here (it only works where those credentials exist)' }))
  } else {
    return [R(area, 'fail', `${label} is not configured`, { fix: `set ${def.env} (path to the key)${def.inlineEnv ? `, or ${def.inlineEnv}` : ''}${def.adcEnv ? `, or ${def.adcEnv}` : ''} in ${relTo(cwd, dir)}/.env. ${def.help ?? ''}`.trim() })]
  }

  // the frontend and the key must belong to the same project, or every token is rejected
  const prompt = (manifest.prompts ?? []).find((p) => p.key === def.projectIdPrompt)
  if (prompt?.env && chosen[prompt.side] && projectId) {
    const mine = envLookup(envs[prompt.side] ?? [], prompt.env)?.value
    if (mine && mine.toLowerCase() !== projectId.toLowerCase()) {
      out.push(R(area, 'fail', `the ${prompt.side} uses project "${mine}" but the ${label} is for "${projectId}"`, { detail: 'every sign-in token would be rejected by the backend', fix: `use the key from the same project as ${prompt.env}` }))
    } else if (mine) out.push(R(area, 'ok', `${prompt.side} and backend use the same project`, { detail: projectId }))
  }
  return out
}

// ---------------------------------------------------------------- packages

function resolveNodePackage(dir, name) {
  let cur = path.resolve(dir)
  for (;;) {
    if (exists(path.join(cur, 'node_modules', name, 'package.json'))) return true
    const parent = path.dirname(cur)
    if (parent === cur) return false
    cur = parent
  }
}
const hasPnp = (dir) => {
  let cur = path.resolve(dir)
  for (;;) {
    if (exists(path.join(cur, '.pnp.cjs')) || exists(path.join(cur, '.pnp.js'))) return true
    const parent = path.dirname(cur)
    if (parent === cur) return false
    cur = parent
  }
}

function checkNodePackages(side, dir, packages, cwd) {
  const area = AREAS[3]
  const pkg = readJson(path.join(dir, 'package.json'))
  if (!pkg) return [R(area, 'warn', `${side}: no readable package.json in ${relTo(cwd, dir)}`)]
  const pm = detectPackageManager(dir, cwd)
  if (hasPnp(dir)) return [R(area, 'skip', `${side}: Yarn Plug'n'Play, installed packages not checked`)]
  const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }
  const out = []
  const fine = []
  for (const name of packages) {
    if (!(name in declared)) out.push(R(area, 'fail', `${side}: ${name} is not in ${relTo(cwd, path.join(dir, 'package.json'))}`, { fix: jsInstallCommand(pm, [name]) }))
    else if (!resolveNodePackage(dir, name)) out.push(R(area, 'fail', `${side}: ${name} is listed but not installed`, { fix: `${pm} install   (in ${relTo(cwd, dir)})` }))
    else fine.push(name)
  }
  if (fine.length) out.push(R(area, 'ok', `${side}: ${list(fine)} installed`))
  return out
}

const PY_MODULES = { 'python-dotenv': 'dotenv', 'firebase-admin': 'firebase_admin', pyyaml: 'yaml', pillow: 'PIL' }
const pyName = (spec) => /^[A-Za-z0-9_.-]+/.exec(spec)?.[0] ?? spec
const pyModule = (spec) => PY_MODULES[pyName(spec).toLowerCase()] ?? pyName(spec).toLowerCase().replace(/[-.]/g, '_')
const PY_PROBE = 'import importlib.util as u, json, sys\ndef has(m):\n    try: return u.find_spec(m) is not None\n    except Exception: return False\nprint(json.dumps({m: has(m) for m in sys.argv[1:]}))'

function findPython(backendDir, cwd) {
  const win = process.platform === 'win32'
  const venvPy = (root) => path.join(root, win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python')
  for (const base of [backendDir, cwd]) for (const v of ['.venv', 'venv', 'env']) if (exists(venvPy(path.join(base, v)))) return { cmd: venvPy(path.join(base, v)), project: true }
  if (process.env.VIRTUAL_ENV && exists(venvPy(process.env.VIRTUAL_ENV))) return { cmd: venvPy(process.env.VIRTUAL_ENV), project: true }
  return { cmd: win ? 'python' : 'python3', project: false, alt: win ? 'py' : 'python' }
}

function checkPythonPackages(dir, packages, cwd, flags, io) {
  const area = AREAS[3]
  const out = []
  const manager = detectPythonManager(dir)
  const files = ['requirements.txt', 'pyproject.toml', 'Pipfile'].map((n) => readText(path.join(dir, n))).filter(Boolean).join('\n').toLowerCase()
  if (!files) out.push(R(area, 'warn', `backend: no requirements.txt or pyproject.toml in ${relTo(cwd, dir)}`, { detail: 'nothing records which packages the backend needs', fix: pyInstallCommand(manager, packages) }))
  else {
    const undeclared = packages.filter((p) => !new RegExp(`(^|[^a-z0-9])${pyName(p).toLowerCase().replace(/[-_.]+/g, '[-_.]')}([^a-z0-9]|$)`).test(files))
    if (undeclared.length) out.push(R(area, 'warn', `backend: ${list(undeclared)} not listed in your requirements`, { detail: 'it may work here, but a fresh install or a deploy would miss it', fix: pyInstallCommand(manager, undeclared) }))
  }

  if (flags.offline) return [...out, R(area, 'skip', 'backend: Python packages not checked (--offline)')]
  const mods = packages.map(pyModule)
  const py = findPython(dir, cwd)
  let r = io.run(py.cmd, ['-c', PY_PROBE, ...mods], { encoding: 'utf8', timeout: 15000, cwd: dir })
  if (r?.error && py.alt) r = io.run(py.alt, ['-c', PY_PROBE, ...mods], { encoding: 'utf8', timeout: 15000, cwd: dir })
  let found = null
  try {
    found = r && !r.error && r.status === 0 ? JSON.parse(r.stdout) : null
  } catch {
    /* handled below */
  }
  if (!found) return [...out, R(area, 'skip', 'backend: no Python found to check the packages with')]
  const missing = packages.filter((p, i) => !found[mods[i]])
  if (missing.length === 0) return [...out, R(area, 'ok', `backend: ${list(packages)} importable`, { detail: py.project ? 'using the project virtualenv' : 'using the Python on your PATH' })]
  return [
    ...out,
    R(area, py.project ? 'fail' : 'warn', `backend: cannot import ${list(missing.map(pyModule))}${py.project ? '' : ' with the Python on your PATH'}`, {
      detail: py.project ? undefined : 'if your backend runs in a virtualenv, activate it and run doctor again',
      fix: pyInstallCommand(manager, missing),
    }),
  ]
}

function checkPackages({ variant, chosen, cwd, flags, io }) {
  const deps = variant.manifest.dependencies ?? {}
  const out = []
  if (chosen.frontend && deps.frontend?.length) out.push(...checkNodePackages('frontend', chosen.frontend, deps.frontend, cwd))
  if (chosen.backend && deps.backend?.length) {
    const found = detectBackend(chosen.backend)
    if (found?.tags.includes('node')) out.push(...checkNodePackages('backend', chosen.backend, deps.backend, cwd))
    else out.push(...checkPythonPackages(chosen.backend, deps.backend, cwd, flags, io))
  }
  return out
}

// ---------------------------------------------------------------- connection

async function request(io, url, { method = 'GET', headers = {}, timeout = 3000 } = {}) {
  try {
    const res = await io.fetch(url, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(timeout) })
    const text = (await res.text().catch(() => '')).slice(0, 4000)
    return { ok: true, status: res.status, headers: res.headers, text }
  } catch (err) {
    return { ok: false, timedOut: err?.name === 'TimeoutError', error: err?.cause?.code ?? err?.name ?? 'error' }
  }
}
const jsonOf = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
const short = (s, n = 80) => redact(String(s ?? '')).replace(/\s+/g, ' ').slice(0, n)

/** The /api proxy the frontend dev server has, if any: { found, target } */
function frontendProxy(dir, prefix = '/api') {
  const key = prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const vite = ['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts'].map((n) => path.join(dir, n)).find(exists)
  if (vite) {
    const text = readText(vite) ?? ''
    if (!/\bproxy\b/.test(text) || !new RegExp(`['"]${key}['"]\\s*:`).test(text)) return { found: false, port: /\bport\s*:\s*(\d{2,5})/.exec(text)?.[1] }
    const target = new RegExp(`['"]${key}['"]\\s*:\\s*['"]([^'"]+)['"]`).exec(text)?.[1] ?? new RegExp(`['"]${key}['"]\\s*:\\s*\\{[^}]*?target\\s*:\\s*['"]([^'"]+)['"]`).exec(text)?.[1] ?? null
    return { found: true, target, port: /\bport\s*:\s*(\d{2,5})/.exec(text)?.[1] }
  }
  const pkg = readJson(path.join(dir, 'package.json'))
  if (typeof pkg?.proxy === 'string') return { found: true, target: pkg.proxy }
  if (['src/setupProxy.js', 'src/setupProxy.ts'].some((n) => exists(path.join(dir, n)))) return { found: true, target: null }
  return { found: false }
}

const portOf = (url) => {
  try {
    const u = new URL(url)
    return u.port || (u.protocol === 'https:' ? '443' : '80')
  } catch {
    return null
  }
}

async function checkConnection(c) {
  const { entry, variant, chosen, cwd, flags, io } = c
  const area = AREAS[4]
  const doc = variant.manifest.doctor
  if (!doc?.probe) return []
  const out = []
  const prefix = flags.prefix ?? doc.probe.prefix ?? '/api'
  const route = `${prefix}${doc.probe.path}`
  const backendInfo = chosen.backend ? detectBackend(chosen.backend) : null
  const frontendInfo = chosen.frontend ? detectFrontend(chosen.frontend) : null

  // ---- static: how does the browser reach the backend?
  let direct = false
  let proxy = { found: false }
  let apiUrl = ''
  if (chosen.frontend) {
    apiUrl = (doc.apiUrlEnv && envLookup(readEnvFiles(chosen.frontend, 'frontend'), doc.apiUrlEnv)?.value) || ''
    proxy = frontendProxy(chosen.frontend, prefix)
    if (/^https?:\/\//.test(apiUrl)) {
      direct = true
      out.push(R(area, 'ok', `the frontend calls ${apiUrl} directly (${doc.apiUrlEnv})`, { detail: 'the backend has to allow CORS for your frontend origin' }))
    } else if (proxy.found) {
      out.push(R(area, 'ok', `dev proxy ${prefix} -> ${proxy.target ?? '(set in your own proxy file)'}`))
      const want = backendInfo?.port
      const got = proxy.target ? portOf(proxy.target) : null
      if (want && got && String(want) !== got) out.push(R(area, 'warn', `the proxy points at port ${got}, but your backend listens on ${want} (${backendInfo.entry})`, { fix: `change the proxy target to http://localhost:${want}` }))
    } else {
      const patch = (variant.manifest.patches?.frontend ?? []).find((p) => PROXY_TYPES.has(p.type) && (!p.when || Object.entries(p.when).every(([k, v]) => chosen.options?.[k] === v)))
      out.push(
        R(area, 'fail', `no ${prefix} proxy and no ${doc.apiUrlEnv ?? 'API URL'} set`, {
          detail: `requests to ${prefix} would reach your frontend dev server, not the backend`,
          fix: patch?.manual?.length ? patch.manual.map((l) => l.replace(/\{\{backendUrl\}\}/g, 'http://localhost:8000')).filter(Boolean) : `devcommons add ${entry.feature} ${entry.stack} ${folderFlags(entry)} --patch`,
        }),
      )
    }
  }

  if (flags.offline) return [...out, R(area, 'skip', 'live checks not run (--offline)')]

  // ---- live: where is the backend?
  const apiBase = direct ? apiUrl.replace(/\/+$/, '').replace(new RegExp(`${prefix.replace(/[/.]/g, '\\$&')}$`), '') : ''
  const base = (flags.url || apiBase || (proxy.found && proxy.target) || (backendInfo?.port ? `http://localhost:${backendInfo.port}` : backendInfo?.tags.includes('python') ? 'http://localhost:8000' : '')).replace(/\/+$/, '')
  if (!base) return [...out, R(area, 'skip', 'live checks skipped: no backend URL known', { fix: 'run doctor with --url http://localhost:PORT' })]

  const target = `${base}${route}`
  const first = await request(io, target)
  if (!first.ok) {
    return [...out, R(area, 'warn', `backend not reachable at ${base}`, { detail: first.timedOut ? 'timed out' : 'connection refused or failed', fix: `start it, or tell doctor where it runs: --url http://localhost:PORT` })]
  }
  const body = jsonOf(first.text)
  const bearer = (first.headers.get('www-authenticate') ?? '').toLowerCase().startsWith('bearer')
  if (first.status === 401 && body?.detail === 'Missing bearer token' && bearer) {
    out.push(R(area, 'ok', `GET ${route} answers 401 "Missing bearer token"`, { detail: `${base} is up and enforcing auth${c.conformance ? `\nfull contract check: node ${c.conformance} ${base}` : ''}` }))
  } else if (first.status === 401) {
    out.push(R(area, 'warn', `GET ${route} answers 401, but not the way the contract says`, { detail: `detail: ${short(body?.detail ?? first.text)}; WWW-Authenticate: ${bearer ? 'Bearer' : 'missing'}` }))
  } else if (first.status === 404 || first.status === 405) {
    out.push(R(area, 'fail', `GET ${route} -> ${first.status}: the auth routes are not mounted at ${base}`, { detail: 'is setup_auth / setupAuth called, and is this the right server?', fix: `if you changed the prefix, pass it: --prefix /yourprefix` }))
  } else if (first.status === 200) {
    out.push(R(area, 'fail', `GET ${route} -> 200 without a token`, { detail: 'the route answers anyone: auth is not being enforced' }))
  } else {
    out.push(R(area, 'fail', `GET ${route} -> ${first.status}`, { detail: `the server errored: ${short(body?.detail ?? first.text)}`, fix: 'check the backend logs' }))
  }

  if (first.status === 401 || first.status === 200) {
    const second = await request(io, target, { headers: { Authorization: 'Bearer devcommons-doctor-probe' } })
    const b2 = jsonOf(second.text)
    if (second.ok && second.status === 401 && typeof b2?.detail === 'string' && b2.detail.startsWith('Invalid token')) out.push(R(area, 'ok', 'a bad token is rejected with 401 "Invalid token" (verification runs)'))
    else if (second.ok && second.status >= 500) out.push(R(area, 'fail', 'the backend crashed while verifying a token', { detail: short(b2?.detail ?? second.text), fix: 'usually the credentials: see the Environment section and the backend log' }))
    else if (second.ok) out.push(R(area, 'warn', `a bad token got ${second.status} instead of 401 "Invalid token"`, { detail: short(b2?.detail ?? second.text) }))
  }

  // ---- live: the browser's view (proxy, CORS)
  if (chosen.frontend) {
    const tags = frontendInfo?.tags ?? []
    const origin = (flags.origin || `http://localhost:${proxy.port ?? (tags.includes('vite') ? 5173 : 3000)}`).replace(/\/+$/, '')
    if (!direct) {
      const via = await request(io, `${origin}${route}`)
      if (!via.ok) out.push(R(area, 'skip', `frontend dev server not running at ${origin}, proxy not tested`))
      else if (via.status === 401 && jsonOf(via.text)?.detail) out.push(R(area, 'ok', `the dev server at ${origin} forwards ${prefix} to the backend`))
      else out.push(R(area, 'fail', `the dev server at ${origin} answers ${route} itself (${via.status}), it does not reach the backend`, { fix: 'check the proxy setting above, then restart the dev server (proxy settings are read at startup)' }))
    }
    const pre = await request(io, target, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } })
    if (pre.ok) {
      const allow = pre.headers.get('access-control-allow-origin')
      if (allow === origin || allow === '*') out.push(R(area, 'ok', `CORS allows ${origin}`))
      else if (direct) out.push(R(area, 'fail', `CORS does not allow ${origin}, and the browser calls the backend directly`, { fix: `allow that origin in the backend (setup_auth(..., cors_origins=[...]) / setupAuth(app, { corsOrigins: [...] }))` }))
      else out.push(R(area, 'skip', `CORS does not list ${origin}: fine while the dev proxy is used`, { detail: 'you need it when the browser calls the backend directly (another domain in production)' }))
    }
  }
  return out
}

// ---------------------------------------------------------------- safety

function checkSafety({ entry, variant, chosen, cwd, repo }) {
  const area = AREAS[5]
  const out = []
  const targets = secretTargets({ manifest: variant.manifest, chosen, cwd }).filter((t) => exists(t.file))
  const extraEnv = []
  for (const side of ['frontend', 'backend']) {
    if (!chosen[side]) continue
    for (const f of readEnvFiles(chosen[side], side)) if (!targets.some((t) => t.file === f.file)) extraEnv.push({ side, pattern: f.name, file: f.file, label: `${side} ${f.name}` })
  }
  const all = [...targets, ...extraEnv]
  if (all.length === 0) return out

  const loose = []
  for (const t of all) {
    if (isIgnored(cwd, t.file, repo)) continue
    const hasKey = Boolean(t.secret) || [...parseEnv(readText(t.file) ?? '').values()].some(looksSecret)
    loose.push({ ...t, hasKey })
  }
  if (loose.length === 0) out.push(R(area, 'ok', `${list(all.map((t) => relTo(cwd, t.file)))} ${all.length === 1 ? 'is' : 'are'} covered by .gitignore`))
  for (const t of loose) {
    out.push(
      R(area, t.hasKey || t.secret ? 'fail' : 'warn', `${relTo(cwd, t.file)} is not ignored by git`, {
        detail: t.secret || t.hasKey ? 'it holds a secret key; one "git add ." would commit it' : 'it will hold your settings and any keys you add later',
        fix: `add "${t.pattern}" to .gitignore   (devcommons doctor --fix does it)`,
      }),
    )
  }

  if (!repo.inRepo) return [...out, R(area, 'skip', 'not a git repository: whether files are committed was not checked')]
  const reported = new Set()
  for (const t of all) {
    if (!isTracked(cwd, t.file)) continue
    reported.add(relTo(cwd, t.file))
    out.push(R(area, 'fail', `${relTo(cwd, t.file)} is committed to git`, { fix: [`git rm --cached ${relTo(cwd, t.file)}`, ...(t.secret ? ['then revoke this key in its console and create a new one: it is in your history now'] : [])] }))
  }
  for (const p of trackedMatching(cwd, /(^|\/)serviceAccount[^/]*\.json$|-firebase-adminsdk-[^/]*\.json$/i)) {
    const abs = path.join(repo.top, p)
    if (reported.has(relTo(cwd, abs))) continue
    out.push(R(area, 'fail', `${p} looks like a service-account key and is committed to git`, { fix: [`git rm --cached ${p}`, 'then revoke the key in its console and create a new one'] }))
  }
  return out
}
