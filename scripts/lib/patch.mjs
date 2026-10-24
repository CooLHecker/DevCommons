// Patch engine: small, conservative edits to the user's own files
// (wrap the root component, add a dev proxy, call setup_auth(app)).
//
// Rules every handler follows:
//   * idempotent: if the change is already there it reports "applied" and does nothing
//   * conservative: if the file does not look the way it expects it reports "manual"
//     (with a reason) instead of guessing; the CLI then prints the manual snippet
//   * pure: handlers only compute { before, after }; writing happens in applyPatches()

import fs from 'node:fs'
import path from 'node:path'

const norm = (t) => t.replace(/\r\n/g, '\n')
const toPosix = (p) => p.split(path.sep).join('/')
const fill = (s, vars) => String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '')

function firstExisting(dir, names) {
  for (const n of names) {
    const f = path.join(dir, n)
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f
  }
  return null
}

const lineStart = (text, idx) => text.lastIndexOf('\n', idx - 1) + 1
const lineIndent = (text, idx) => text.slice(lineStart(text, idx)).match(/^[ \t]*/)[0]

/** Index of the ")" matching the "(" at openIdx. Skips strings and #/// comments. Returns -1 if unbalanced. */
function matchParen(text, openIdx) {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const triple = text.startsWith(ch.repeat(3), i)
      const quote = triple ? ch.repeat(3) : ch
      i += quote.length
      while (i < text.length && !text.startsWith(quote, i)) i += text[i] === '\\' ? 2 : 1
      i += quote.length - 1
    } else if (ch === '#' || (ch === '/' && text[i + 1] === '/')) {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) return i
  }
  return -1
}

/** Does a manifest "when" condition ({ ui: 'headless' }) hold for the chosen options? No options given = no filtering. */
export function whenMatches(when, options) {
  if (!when || !options) return true
  return Object.entries(when).every(([k, v]) => options[k] === v)
}

const manual = (reason) => ({ status: 'manual', reason })
const applied = () => ({ status: 'applied' })
const absent = () => ({ status: 'absent' })

/** Marker text left next to every line devcommons adds, so "remove" can find it again. */
const markerTag = (ctx) => `devcommons:${ctx.feature ?? 'auth'}`
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Files a revert should look at: the ones recorded at install time first, then the usual names. */
function candidates(dir, names, ctx) {
  const recorded = (ctx.recordedFiles ?? []).filter((f) => f.startsWith(dir + path.sep))
  const named = names.map((n) => path.join(dir, n))
  return [...new Set([...recorded, ...named])].filter((f) => fs.existsSync(f) && fs.statSync(f).isFile())
}

// ---------------------------------------------------------------- wrap-root (React)

function wrapRoot(patch, ctx) {
  const dir = ctx.dirs.frontend
  const file = firstExisting(dir, patch.files)
  if (!file) return manual(`no entry file found (looked for ${patch.files.join(', ')})`)
  const raw = fs.readFileSync(file, 'utf8')
  const text = norm(raw)
  const component = patch.component

  if (new RegExp(`<${component}[\\s>/]`).test(text)) return applied()

  const renderIdx = text.indexOf('.render(')
  if (renderIdx === -1) return manual(`no ".render(" call found in ${path.basename(file)}`)
  const open = renderIdx + '.render'.length
  const close = matchParen(text, open)
  if (close === -1) return manual(`could not read the render call in ${path.basename(file)}`)

  const body = text.slice(open, close)
  const elements = [...body.matchAll(/<([A-Z][\w.]*)\b[^<>]*?\/>/g)]
  let target = elements.length === 1 ? elements[0] : elements.find((m) => m[1] === 'App')
  if (!target) {
    return manual(
      elements.length === 0
        ? 'no self-closing component such as <App /> found inside render(...)'
        : 'several components are rendered; wrap the one that should be signed-in only',
    )
  }

  const start = open + target.index
  const end = start + target[0].length
  const indent = lineIndent(text, start)
  const alone = text.slice(lineStart(text, start), start).trim() === ''
  const elem = target[0]

  let replacement
  if (alone && !elem.includes('\n')) {
    replacement = `<${component}>\n${indent}  ${elem}\n${indent}</${component}>`
  } else if (alone) {
    const inner = elem.split('\n').map((l) => `  ${l}`).join('\n')
    replacement = `<${component}>\n${indent}${inner}\n${indent}</${component}>`
  } else {
    replacement = `<${component}>${elem}</${component}>`
  }
  let after = text.slice(0, start) + replacement + text.slice(end)

  // import { AuthGate } from './auth'
  let spec = toPosix(path.relative(path.dirname(file), path.join(dir, patch.module)))
  if (!spec.startsWith('.')) spec = `./${spec}`
  const imports = [...after.matchAll(/^import\b[^;]*?['"][^'"]+['"];?[ \t]*$/gm)]
  const last = imports[imports.length - 1]
  const q = (imports[0]?.[0].match(/['"]/) || ["'"])[0]
  const semi = last && last[0].trimEnd().endsWith(';') ? ';' : ''
  const importLine = `import { ${component} } from ${q}${spec}${q}${semi}`
  if (last) {
    const at = last.index + last[0].length
    after = `${after.slice(0, at)}\n${importLine}${after.slice(at)}`
  } else {
    after = `${importLine}\n${after}`
  }
  return { status: 'apply', file, before: text, after, eol: raw.includes('\r\n') ? '\r\n' : '\n' }
}

// ---------------------------------------------------------------- vite-proxy

function viteProxy(patch, ctx) {
  const dir = ctx.dirs.frontend
  const file = firstExisting(dir, ['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts'])
  if (!file) return manual('no vite.config.* found')
  const raw = fs.readFileSync(file, 'utf8')
  const text = norm(raw)
  const route = patch.path || '/api'
  const target = fill(patch.target, ctx.vars)

  if (/\bproxy\b/.test(text) && new RegExp(`['"]${route}['"]\\s*:`).test(text)) return applied()

  const entry = `'${route}': '${target}',`
  const marker = `// ${markerTag(ctx)}`
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  let after = null

  let m = /\bproxy\s*:\s*\{/.exec(text)
  if (m) {
    const ind = lineIndent(text, m.index) + '  '
    const at = m.index + m[0].length
    after = `${text.slice(0, at)}\n${ind}${marker}\n${ind}${entry}${text.slice(at)}`
  } else if ((m = /\bserver\s*:\s*\{/.exec(text))) {
    const ind = lineIndent(text, m.index) + '  '
    const at = m.index + m[0].length
    after = `${text.slice(0, at)}\n${ind}${marker}\n${ind}proxy: { ${entry} },${text.slice(at)}`
  } else if ((m = /defineConfig\(\s*(?:\([^)]*\)\s*=>\s*\(?\s*)?\{/.exec(text))) {
    const ind = lineIndent(text, m.index + m[0].length - 1) + '  '
    const at = m.index + m[0].length
    after = `${text.slice(0, at)}\n${ind}${marker}\n${ind}server: { proxy: { ${entry} } },${text.slice(at)}`
  }
  if (!after) return manual('vite.config has a structure I would not guess at')
  return { status: 'apply', file, before: text, after, eol }
}

// ---------------------------------------------------------------- cra-proxy (Create React App)

/** CRA's dev server proxies unknown requests to the "proxy" string in package.json. */
function craProxy(patch, ctx) {
  const dir = ctx.dirs.frontend
  const file = path.join(dir, 'package.json')
  if (!fs.existsSync(file)) return manual('no package.json found')
  if (firstExisting(dir, ['src/setupProxy.js', 'src/setupProxy.ts'])) return manual('src/setupProxy.js already exists; add the /api proxy there')
  const raw = fs.readFileSync(file, 'utf8')
  const text = norm(raw)
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return manual('package.json is not valid JSON')
  }
  const target = fill(patch.target, ctx.vars)
  if (!target) return manual('no backend URL to proxy to')
  if (json.proxy !== undefined) {
    if (json.proxy === target) return applied()
    return manual(`package.json already has "proxy": ${JSON.stringify(json.proxy)}; point it at ${target}, or proxy "${patch.path || '/api'}" in src/setupProxy.js`)
  }
  const m = /^\{[ \t]*\n([ \t]+)"/.exec(text)
  if (!m) return manual('package.json has a layout I would not guess at')
  const after = text.replace(/^\{[ \t]*\n/, `{\n${m[1]}"proxy": ${JSON.stringify(target)},\n`)
  try {
    if (JSON.parse(after).proxy !== target) throw new Error('proxy missing')
  } catch {
    return manual('package.json has a layout I would not guess at')
  }
  return { status: 'apply', file, before: text, after, eol: raw.includes('\r\n') ? '\r\n' : '\n' }
}

// ---------------------------------------------------------------- py-setup-call (FastAPI)

function pySetupCall(patch, ctx) {
  const dir = ctx.dirs.backend
  const names = [...(ctx.entry ? [ctx.entry] : []), ...patch.files]
  let file = null
  let raw = ''
  let m = null
  for (const n of names) {
    const f = path.join(dir, n)
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue
    const t = fs.readFileSync(f, 'utf8')
    const found = /^(\w+)\s*(?::[^=\n]+)?=\s*FastAPI\(/m.exec(norm(t))
    if (found) {
      file = f
      raw = t
      m = found
      break
    }
  }
  if (!file) return manual(`no FastAPI app found (looked in ${names.join(', ')})`)
  const text = norm(raw)
  if (/\bsetup_auth\s*\(/.test(text)) return applied()

  const appVar = m[1]
  const open = m.index + m[0].length - 1
  const close = matchParen(text, open)
  if (close === -1) return manual('could not read the FastAPI(...) call')
  const stmtEnd = text.indexOf('\n', close)
  const at = stmtEnd === -1 ? text.length : stmtEnd

  const useAlt = patch.altWhen && patch.altCall && new RegExp(patch.altWhen).test(text)
  const call = fill(useAlt ? patch.altCall : patch.call, { ...ctx.vars, app: appVar })
  let after = `${text.slice(0, at)}\n\n${call}  # ${markerTag(ctx)}${text.slice(at)}`

  // import goes after the last top-level import that comes before the app is created
  const before = after.slice(0, m.index)
  const lines = before.split('\n')
  let lastImportEnd = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^(import|from)\s/.test(line)) {
      let endLine = i
      let depth = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length
      while (depth > 0 && endLine + 1 < lines.length) {
        endLine++
        depth += (lines[endLine].match(/\(/g) || []).length - (lines[endLine].match(/\)/g) || []).length
      }
      lastImportEnd = lines.slice(0, endLine + 1).join('\n').length
      i = endLine
    }
  }
  const importLine = `${patch.import}  # ${markerTag(ctx)}`
  after = lastImportEnd === -1 ? `${importLine}\n${after}` : `${after.slice(0, lastImportEnd)}\n${importLine}${after.slice(lastImportEnd)}`
  return { status: 'apply', file, before: text, after, eol: raw.includes('\r\n') ? '\r\n' : '\n' }
}

// ---------------------------------------------------------------- js-setup-call (Express)

const JS_APP = /^([ \t]*)(?:const|let|var)\s+(\w+)\s*=\s*express\(\s*\)[ \t]*(;?)[ \t]*$/m

function jsSetupCall(patch, ctx) {
  const dir = ctx.dirs.backend
  const names = [...(ctx.entry ? [ctx.entry] : []), ...patch.files]
  let file = null
  let raw = ''
  let m = null
  for (const n of [...new Set(names)]) {
    const f = path.join(dir, n)
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue
    const t = fs.readFileSync(f, 'utf8')
    const found = JS_APP.exec(norm(t))
    if (found) {
      file = f
      raw = t
      m = found
      break
    }
  }
  if (!file) return manual(`no \`const app = express()\` found (looked in ${[...new Set(names)].join(', ')})`)
  const text = norm(raw)
  if (/\bsetupAuth\s*\(/.test(text)) return applied()

  const [whole, indent, appVar, semi] = m
  const esm = /^\s*import[\s{*]/m.test(text)
  const q = (text.match(/(?:from\s*|require\()(['"])/) || [null, "'"])[1]
  let spec = toPosix(path.relative(path.dirname(file), path.join(dir, patch.module)))
  if (!spec.startsWith('.')) spec = `./${spec}`
  if (esm) spec += '/index.js'
  const marker = `// ${markerTag(ctx)}`
  const importLine = esm ? `import { setupAuth } from ${q}${spec}${q}${semi} ${marker}` : `const { setupAuth } = require(${q}${spec}${q})${semi} ${marker}`

  const useAlt = patch.altWhen && patch.altCall && new RegExp(patch.altWhen).test(text)
  const call = fill(useAlt ? patch.altCall : patch.call, { ...ctx.vars, app: appVar })
  const stmtEnd = m.index + whole.length
  let after = `${text.slice(0, stmtEnd)}\n\n${indent}${call}${semi} ${marker}${text.slice(stmtEnd)}`

  // the import goes after the last top-level import/require that comes before the app is created
  const head = after.slice(0, m.index)
  const imports = [...head.matchAll(/^import\b[^;]*?['"][^'"\n]+['"];?[ \t]*(?:\/\/.*)?$|^import\s+['"][^'"\n]+['"];?[ \t]*$|^(?:const|let|var)\s+[^=\n]+=\s*require\([^)\n]*\)[^\n]*$/gm)]
  const last = imports[imports.length - 1]
  if (last) {
    const at = last.index + last[0].length
    after = `${after.slice(0, at)}\n${importLine}${after.slice(at)}`
  } else {
    const lead = /^(?:#![^\n]*\n)?(?:['"]use strict['"];?[ \t]*\n)?/.exec(after)[0]
    after = `${lead}${importLine}\n${after.slice(lead.length)}`
  }
  return { status: 'apply', file, before: text, after, eol: raw.includes('\r\n') ? '\r\n' : '\n' }
}

const HANDLERS = { 'wrap-root': wrapRoot, 'vite-proxy': viteProxy, 'cra-proxy': craProxy, 'py-setup-call': pySetupCall, 'js-setup-call': jsSetupCall }

// ---------------------------------------------------------------- reverts (used by "devcommons remove")
// Each one undoes exactly what its handler above adds. Same contract: pure, conservative,
// and "manual" (with a reason) when the file no longer looks like what devcommons wrote.

function unwrapRoot(patch, ctx) {
  const comp = patch.component
  let file = null
  let raw = ''
  for (const f of candidates(ctx.dirs.frontend, patch.files, ctx)) {
    const t = fs.readFileSync(f, 'utf8')
    if (new RegExp(`<${comp}[\\s>/]`).test(t)) {
      file = f
      raw = t
      break
    }
  }
  if (!file) return absent()
  const text = norm(raw)
  const open = `<${comp}>`
  const close = `</${comp}>`
  const o = text.indexOf(open)
  const c = text.indexOf(close)
  const once = (s) => text.split(s).length - 1 === 1
  if (!once(open) || !once(close) || o > c) {
    return manual(`${path.basename(file)} uses <${comp}> in a way I would not guess at; remove the wrapper and its import by hand`)
  }

  const inner = text.slice(o + open.length, c)
  const tail = text.slice(c + close.length)
  const alone = text.slice(lineStart(text, o), o).trim() === ''
  let after
  if (inner.includes('\n')) {
    let body = inner
      .replace(/^[ \t]*\n/, '')
      .replace(/\n[ \t]*$/, '')
      .split('\n')
      .map((l) => l.replace(/^ {1,2}/, ''))
      .join('\n')
    if (!alone) body = body.trimStart()
    after = text.slice(0, alone ? lineStart(text, o) : o) + body + tail
  } else {
    after = text.slice(0, o) + inner.trim() + tail
  }

  // import { AuthGate } from './auth'   (only when it imports nothing else)
  const base = escapeRe(path.basename(patch.module))
  const imp = new RegExp(`^import\\s*\\{\\s*${comp}\\s*\\}\\s*from\\s*['"](?:[^'"]*/)?${base}(?:/index(?:\\.\\w+)?)?['"];?[ \\t]*\\n?`, 'm')
  after = after.replace(imp, '')
  return { status: 'apply', file, before: text, after, eol: raw.includes('\r\n') ? '\r\n' : '\n' }
}

function unviteProxy(patch, ctx) {
  const marker = `// ${markerTag(ctx)}`
  const names = ['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts']
  let file = null
  let raw = ''
  for (const f of candidates(ctx.dirs.frontend, names, ctx)) {
    const t = fs.readFileSync(f, 'utf8')
    if (t.includes(marker)) {
      file = f
      raw = t
      break
    }
  }
  if (!file) return absent()
  const text = norm(raw)
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.trim() === marker)
  const next = lines[i + 1]
  const route = escapeRe(patch.path || '/api')
  const entry = `'${route}'\\s*:\\s*'[^']*',?`
  const onlyEntry = new RegExp(`^\\s*${entry}\\s*$`)
  const wholeServer = new RegExp(`server:\\s*\\{\\s*proxy:\\s*\\{\\s*${entry}\\s*\\}\\s*\\},?\\s*`)
  const proxyBlock = new RegExp(`proxy:\\s*\\{\\s*${entry}\\s*\\},?[ \\t]*`)

  let replaced
  if (next === undefined) replaced = undefined
  else if (onlyEntry.test(next)) replaced = ''
  else if (wholeServer.test(next)) replaced = next.replace(wholeServer, '')
  else if (proxyBlock.test(next)) replaced = next.replace(proxyBlock, '')
  if (replaced === undefined) return manual(`the proxy line after the devcommons marker in ${path.basename(file)} was changed; remove the '${patch.path || '/api'}' proxy by hand`)

  if (replaced.trim() === '') lines.splice(i, 2)
  else if (i > 0 && lines[i - 1].trimEnd().endsWith('{')) {
    // the config was a one-liner like defineConfig({ plugins: [] }): put it back on one line
    lines.splice(i - 1, 3, `${lines[i - 1].trimEnd()} ${replaced.trim()}`)
  } else lines.splice(i, 2, replaced)
  return { status: 'apply', file, before: text, after: lines.join('\n'), eol: raw.includes('\r\n') ? '\r\n' : '\n' }
}

/**
 * package.json has no comments to leave a marker in, so this only looks at a package.json that the
 * install record says devcommons edited, and only removes a one-line "proxy" string.
 */
function uncraProxy(patch, ctx) {
  const dir = ctx.dirs.frontend
  for (const f of (ctx.recordedFiles ?? []).filter((x) => path.basename(x) === 'package.json' && x.startsWith(dir + path.sep) && fs.existsSync(x))) {
    const raw = fs.readFileSync(f, 'utf8')
    const text = norm(raw)
    let json
    try {
      json = JSON.parse(text)
    } catch {
      return manual('package.json is not valid JSON; remove the "proxy" line by hand')
    }
    if (typeof json.proxy !== 'string') return absent()
    const after = text.replace(/^[ \t]+"proxy"[ \t]*:[ \t]*"[^"\n]*",[ \t]*\n/m, '')
    let ok = false
    try {
      ok = after !== text && JSON.parse(after).proxy === undefined
    } catch {
      /* stays false */
    }
    if (!ok) return manual('the "proxy" line in package.json was changed; remove it by hand')
    return { status: 'apply', file: f, before: text, after, eol: raw.includes('\r\n') ? '\r\n' : '\n' }
  }
  return absent()
}

function unpySetupCall(patch, ctx) {
  const marker = `# ${markerTag(ctx)}`
  let file = null
  let raw = ''
  for (const f of candidates(ctx.dirs.backend, patch.files, ctx)) {
    const t = fs.readFileSync(f, 'utf8')
    if (t.includes(marker)) {
      file = f
      raw = t
      break
    }
  }
  if (!file) return absent()
  const text = norm(raw)
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trimEnd().endsWith(marker)) {
      out.push(line)
      continue
    }
    // the call was added after a blank line; take that blank line away with it
    if (!/^(import|from)\s/.test(line) && out.length && out[out.length - 1].trim() === '') out.pop()
  }
  return { status: 'apply', file, before: text, after: out.join('\n'), eol: raw.includes('\r\n') ? '\r\n' : '\n' }
}

function unjsSetupCall(patch, ctx) {
  const marker = `// ${markerTag(ctx)}`
  let file = null
  let raw = ''
  for (const f of candidates(ctx.dirs.backend, patch.files, ctx)) {
    const t = fs.readFileSync(f, 'utf8')
    if (t.includes(marker)) {
      file = f
      raw = t
      break
    }
  }
  if (!file) return absent()
  const text = norm(raw)
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trimEnd().endsWith(marker)) {
      out.push(line)
      continue
    }
    // the call was added after a blank line; take that blank line away with it
    if (!/^(import\s|(?:const|let|var)\s.*require\()/.test(line.trimStart()) && out.length && out[out.length - 1].trim() === '') out.pop()
  }
  return { status: 'apply', file, before: text, after: out.join('\n'), eol: raw.includes('\r\n') ? '\r\n' : '\n' }
}

const REVERTERS = { 'wrap-root': unwrapRoot, 'vite-proxy': unviteProxy, 'cra-proxy': uncraProxy, 'py-setup-call': unpySetupCall, 'js-setup-call': unjsSetupCall }

// ---------------------------------------------------------------- public API

/**
 * Work out what each patch in the manifest would do, without writing anything.
 *   patches: { frontend: [...], backend: [...] } from feature.json
 *   ctx:     { dirs: { frontend, backend }, vars, entry }   (only requested sides are planned)
 * Returns [{ id, type, side, status: 'apply'|'applied'|'manual', file?, before?, after?, reason?, manualLines }]
 */
export function planPatches(patches = {}, ctx, handlers = HANDLERS) {
  const reverting = handlers === REVERTERS
  const out = []
  for (const side of ['frontend', 'backend']) {
    if (!ctx.dirs[side]) continue
    for (const patch of patches[side] ?? []) {
      if (!reverting && !whenMatches(patch.when, ctx.options)) continue
      const handler = handlers[patch.type]
      let result
      if (!handler) result = manual(`unknown patch type "${patch.type}"`)
      else {
        try {
          result = handler(patch, ctx)
        } catch (err) {
          result = manual(`could not analyse the file (${err.message})`)
        }
      }
      out.push({ id: patch.id ?? patch.type, type: patch.type, side, manualLines: reverting ? [] : (patch.manual ?? []).map((l) => fill(l, ctx.vars)), ...result })
    }
  }
  return out
}

/**
 * The opposite of planPatches: what would remove devcommons' edits again?
 * Statuses: 'apply' (edit ready), 'absent' (nothing of ours in the file), 'manual' (edited since; do it by hand).
 * ctx additionally takes recordedFiles (absolute paths from .devcommons.json) and feature.
 */
export function planReverts(patches = {}, ctx) {
  return planPatches(patches, { vars: {}, ...ctx }, REVERTERS)
}

/** Minimal line diff (LCS) rendered with 2 lines of context. */
export function renderDiff(before, after, context = 2) {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > 4_000_000) return '  (file too large to preview)'
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push([' ', a[i]])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', a[i++]])
    else ops.push(['+', b[j++]])
  }
  while (i < a.length) ops.push(['-', a[i++]])
  while (j < b.length) ops.push(['+', b[j++]])

  const keep = new Array(ops.length).fill(false)
  ops.forEach(([t], k) => {
    if (t === ' ') return
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true
  })
  const lines = []
  let gap = false
  ops.forEach(([t, s], k) => {
    if (!keep[k]) return (gap = lines.length > 0)
    if (gap) lines.push('    ...')
    gap = false
    lines.push(`  ${t} ${s}`)
  })
  return lines.join('\n')
}

/** Write the planned changes. Originals are copied to <projectRoot>/.devcommons/backup/ first. */
export function applyPatches(results, projectRoot) {
  const changed = []
  for (const r of results) {
    if (r.status !== 'apply') continue
    const rel = path.relative(projectRoot, r.file)
    const safeRel = rel.startsWith('..') || path.isAbsolute(rel) ? path.basename(r.file) : rel
    const backup = path.join(projectRoot, '.devcommons', 'backup', safeRel)
    if (fs.existsSync(r.file) && !fs.existsSync(backup)) {
      fs.mkdirSync(path.dirname(backup), { recursive: true })
      fs.writeFileSync(backup, r.before.replace(/\n/g, r.eol))
    }
    fs.writeFileSync(r.file, r.after.replace(/\n/g, r.eol))
    changed.push(r.file)
  }
  return changed
}
