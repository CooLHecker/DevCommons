// Keeping secrets out of git, and not clobbering uncommitted work.
//   * git helpers (repo? ignored? tracked? dirty? stash)
//   * .gitignore planning (uses `git check-ignore` when git is there, a small matcher when it is not)
//   * a guard that stops private keys from being written to files or echoed
// Zero dependencies. Set DEVCOMMONS_NO_GIT=1 to behave as if git is not installed.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readEnvFiles, envLookup } from './envfile.mjs'

const norm = (t) => t.replace(/\r\n/g, '\n')
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const posix = (p) => p.split(path.sep).join('/')

// ---------------------------------------------------------------- secrets

const SECRET_PATTERNS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /"private_key"\s*:/, /"type"\s*:\s*"service_account"/]

/** Does this value look like a private key or a service-account JSON? (Firebase *web* config is public and does not match.) */
export const looksSecret = (value) => SECRET_PATTERNS.some((re) => re.test(String(value ?? '')))

/** Remove private-key material from text that is about to be shown. */
export function redact(text) {
  return String(text)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted key]')
    .replace(/("private_key"\s*:\s*")[^"]*(")/g, '$1[redacted]$2')
}

/** Absolute path of a key file named in an env value (relative to the side's folder). null when it cannot be resolved. */
export function keyFilePath(sideDir, value) {
  if (!value) return null
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(1))
  return path.resolve(sideDir, value)
}

// ---------------------------------------------------------------- git

function runGit(cwd, args) {
  if (process.env.DEVCOMMONS_NO_GIT) return { ok: false, missing: true, status: null, stdout: '', stderr: '' }
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
  if (r.error) return { ok: false, missing: r.error.code === 'ENOENT', status: null, stdout: '', stderr: String(r.error.code ?? 'error') }
  return { ok: r.status === 0, missing: false, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** { inRepo, top } for the folder devcommons runs in. */
export function gitRepo(cwd) {
  const r = runGit(cwd, ['rev-parse', '--show-toplevel'])
  return r.ok ? { inRepo: true, top: r.stdout.trim() } : { inRepo: false, top: null, gitMissing: r.missing }
}

/** Is this file in git's index? */
export const isTracked = (cwd, file) => runGit(cwd, ['ls-files', '--error-unmatch', '--', file]).ok

/** Every tracked path (relative to the repo root) whose name matches `re`. */
export function trackedMatching(cwd, re) {
  const r = runGit(cwd, ['ls-files', '-z'])
  return r.ok ? r.stdout.split('\0').filter((p) => p && re.test(p)) : []
}

/** Files among `files` with uncommitted changes (modified, staged or untracked): [{ file, code, untracked }]. */
export function dirtyFiles(cwd, files) {
  const out = []
  for (const file of files) {
    const r = runGit(cwd, ['status', '--porcelain', '--untracked-files=all', '--', file])
    const line = r.ok ? r.stdout.split('\n').find(Boolean) : null
    if (line) out.push({ file, code: line.slice(0, 2), untracked: line.startsWith('??') })
  }
  return out
}

/** git stash push for exactly these (tracked) files. */
export function stashFiles(cwd, files, message) {
  const r = runGit(cwd, ['stash', 'push', '-m', message, '--', ...files])
  return { ok: r.ok, message: redact((r.stderr || r.stdout).trim().split('\n')[0] ?? '') }
}

// ---------------------------------------------------------------- .gitignore matching (fallback when git is not available)

function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/'
        if (atStart && glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else if (atStart && i + 2 >= glob.length) {
          re += '.*'
          i += 1
        } else {
          re += '[^/]*'
          i += 1
        }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2)
      if (end > i) {
        let cls = glob.slice(i + 1, end)
        if (cls[0] === '!') cls = `^${cls.slice(1)}`
        re += `[${cls.replace(/\\/g, '\\\\')}]`
        i = end
      } else re += '\\['
    } else if (c === '\\' && i + 1 < glob.length) re += escapeRe(glob[++i])
    else re += escapeRe(c)
  }
  return new RegExp(`^${re}$`)
}

function parseRules(text) {
  const rules = []
  for (let line of norm(text).split('\n')) {
    line = line.replace(/(?<!\\)[ \t]+$/, '')
    if (!line || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1)
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1)
    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    if (!line) continue
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    rules.push({ negate, dirOnly, anchored, re: globToRegExp(line) })
  }
  return rules
}

/** Would the .gitignore files from `root` down to the file's folder ignore `file`? Pure file reading, no git. */
export function ignoredByGitignoreFiles(root, file) {
  const rel = path.relative(root, file)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
  const segs = posix(rel).split('/')
  const sources = []
  for (let depth = 0; depth < segs.length; depth++) {
    const dirRel = segs.slice(0, depth).join('/')
    const gi = path.join(root, ...segs.slice(0, depth), '.gitignore')
    if (fs.existsSync(gi)) sources.push({ dirRel, rules: parseRules(fs.readFileSync(gi, 'utf8')) })
  }
  for (let i = 1; i <= segs.length; i++) {
    const p = segs.slice(0, i).join('/')
    const isDir = i < segs.length
    let state = false
    for (const { dirRel, rules } of sources) {
      if (dirRel && !p.startsWith(`${dirRel}/`)) continue
      const local = dirRel ? p.slice(dirRel.length + 1) : p
      for (const r of rules) {
        if (r.dirOnly && !isDir) continue
        if (r.re.test(r.anchored ? local : local.split('/').pop())) state = !r.negate
      }
    }
    if (state) return true // an ignored folder hides everything below it
  }
  return false
}

/** Do the ignore rules cover this file? Uses git when it can, the file matcher otherwise. */
export function isIgnored(cwd, file, repo = gitRepo(cwd)) {
  if (repo.inRepo) {
    const r = runGit(cwd, ['check-ignore', '--no-index', '-q', '--', file])
    if (r.status === 0) return true
    if (r.status === 1) return false
  }
  return ignoredByGitignoreFiles(cwd, file)
}

// ---------------------------------------------------------------- what to keep out of git

/**
 * The files a feature's secrets live in: its .env files and any key file named in the manifest's
 * "secrets.files". [{ side, pattern, file, label }]   pattern = the .gitignore line that covers it.
 */
export function secretTargets({ manifest, chosen, cwd }) {
  const out = []
  for (const side of ['frontend', 'backend']) {
    if (!chosen[side] || !manifest.envDefaults?.[side]) continue
    out.push({ side, pattern: '.env', file: path.join(chosen[side], '.env'), label: `${side} .env` })
  }
  for (const s of manifest.secrets?.files ?? []) {
    const dir = chosen[s.side]
    if (!dir) continue
    const files = readEnvFiles(dir, s.side)
    const value = envLookup(files, s.env, {})?.value || manifest.envDefaults?.[s.side]?.[s.env] || ''
    const abs = keyFilePath(dir, value)
    if (!abs || value.startsWith('~')) continue
    const rel = path.relative(cwd, abs)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue // lives outside the project: nothing to ignore here
    out.push({ side: s.side, pattern: `/${posix(rel)}`, file: abs, label: s.label ?? s.env, secret: true })
  }
  return out
}

/**
 * Which of `targets` would git still pick up? Returns an edit in the same shape the patch engine uses
 * ({ status: 'apply' | 'applied', file, before, after, eol, manualLines }) so it is previewed and applied like any other edit.
 */
export function planGitignore(cwd, targets, repo = gitRepo(cwd)) {
  const file = path.join(cwd, '.gitignore')
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const before = norm(raw)
  const patterns = []
  for (const t of targets) {
    if (patterns.includes(t.pattern) || isIgnored(cwd, t.file, repo)) continue
    patterns.push(t.pattern)
  }
  const base = { id: 'gitignore', type: 'gitignore', side: targets[0]?.side ?? 'backend', file, patterns }
  if (patterns.length === 0) return { ...base, status: 'applied', manualLines: [] }
  let lead = ''
  if (before !== '') {
    lead = before.endsWith('\n') ? '' : '\n'
    if (!/\n\n$/.test(before + lead)) lead += '\n' // one blank line before our block
  }
  const after = `${before}${lead}# devcommons: keep secrets out of git\n${patterns.join('\n')}\n`
  return {
    ...base,
    status: 'apply',
    before,
    after,
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
    manualLines: ['Add these lines to .gitignore so secrets are never committed:', '', ...patterns.map((p) => `     ${p}`)],
  }
}
