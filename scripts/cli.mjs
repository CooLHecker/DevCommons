#!/usr/bin/env node
// devcommons CLI: drop a reusable feature into an existing project.
// Pure Node (18+), zero dependencies, works the same on Windows, macOS and Linux.
//
//   cd my-project && npx github:<you>/devcommons add        <- asks what it needs
//   devcommons add auth react-vite-fastapi-firebase --frontend ./web --backend ./api   <- no questions

import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { detectProject, detectFrontend, detectBackend, detectPackageManager, detectPythonManager, jsInstallCommand, pyInstallCommand, fitSide } from './lib/detect.mjs'
import { ask, confirm, select, closePrompts, InputEnded } from './lib/prompt.mjs'
import { planPatches, planReverts, renderDiff, applyPatches, whenMatches } from './lib/patch.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FEATURES = path.join(ROOT, 'features')
const CWD = process.cwd()

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s)
const bold = paint(1)
const dim = paint(2)
const red = paint(31)
const green = paint(32)
const yellow = paint(33)

const USAGE = `devcommons - drop reusable features into an existing project

Usage:
  devcommons add [feature] [stack] [options]   interactive: detects your project and asks what it needs
  devcommons remove [feature] [options]        undo an "add": revert the edits, delete the copied files you did not change
  devcommons update [feature] [options]        bring an installed feature up to the catalogue's version, keeping your edits
  devcommons detect                            show what devcommons sees in the current folder
  devcommons list                              show available features and stacks

Options:
  --frontend DIR   folder that contains your frontend's package.json
  --backend DIR    folder where your backend code lives
  --install        run "npm install" for the frontend packages
  --force          add: overwrite files that already exist.  remove: also delete copied files you have edited.  update: overwrite files you edited
  --dry-run        show what would happen, change nothing
  --patch          also edit your files (wrap the app, add the proxy, ...) without asking
  --no-patch       never edit your files; just print what to add by hand
  --option K=V     choose a variant option without being asked (repeatable), e.g. --option ui=headless
  --yes, -y        no questions: use detected folders and the best-fitting stack (remove: skip the confirmation)

By default devcommons only copies files. In interactive mode (and with --yes) it also makes the small
edits needed to wire the feature in, shows each one as a diff first, and keeps a backup of every
file it changes in .devcommons/backup/.

Examples:
  cd my-project && devcommons add
  devcommons add auth react-vite-fastapi-firebase --frontend ./web --backend ./api --install
  devcommons add auth --yes --dry-run
  devcommons add auth --option ui=headless
  devcommons remove auth --dry-run
  devcommons update --dry-run
`

function die(message) {
  console.error(`\n${red('Error:')} ${message}\n`)
  process.exit(1)
}

const rel = (p) => {
  const r = path.relative(CWD, p)
  if (!r) return '.'
  return r.startsWith('..') || path.isAbsolute(r) ? p : `./${r.replace(/\\/g, '/')}`
}

// ---------------------------------------------------------------- catalogue

function loadVariants() {
  const variants = []
  if (!fs.existsSync(FEATURES)) return variants
  for (const feature of fs.readdirSync(FEATURES)) {
    const featureDir = path.join(FEATURES, feature)
    if (!fs.statSync(featureDir).isDirectory()) continue
    for (const stack of fs.readdirSync(featureDir)) {
      const dir = path.join(featureDir, stack)
      const manifestPath = path.join(dir, 'feature.json')
      if (!fs.existsSync(manifestPath)) continue
      variants.push({ feature, stack, dir, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) })
    }
  }
  return variants
}

/** Which sides ("frontend" / "backend") does this variant install code for? */
function sidesOf(manifest) {
  const sides = new Set()
  for (const { to } of manifest.copy) {
    if (to.startsWith('<frontend>')) sides.add('frontend')
    if (to.startsWith('<backend>')) sides.add('backend')
  }
  return ['frontend', 'backend'].filter((s) => sides.has(s))
}

/**
 * Options a stack defines that older installs did not have (e.g. "env") get their default,
 * so a record written by an earlier devcommons keeps resolving the same files.
 */
function completeOptions(manifest, options) {
  const out = { ...options }
  for (const opt of manifest.options ?? []) if (out[opt.key] === undefined) out[opt.key] = opt.default ?? opt.choices[0].value
  return out
}

/**
 * The manifest writes env keys with one prefix ("VITE_..."). "envPrefix" says which option decides
 * the real prefix (Vite: VITE_, Create React App: REACT_APP_); this renames every key and every
 * mention of it, once, so the rest of the CLI only ever sees the right names.
 */
function withEnvPrefix(manifest, options) {
  const rule = manifest.envPrefix
  const to = rule?.values?.[options?.[rule?.option]]
  if (!rule || !to || to === rule.base) return manifest
  const rename = (text) => String(text).split(rule.base).join(to)
  const renameKeys = (obj = {}) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [rename(k), v]))
  const out = { ...manifest }
  if (manifest.envDefaults) out.envDefaults = Object.fromEntries(Object.entries(manifest.envDefaults).map(([side, keys]) => [side, renameKeys(keys)]))
  if (manifest.prompts) out.prompts = manifest.prompts.map((p) => (p.env ? { ...p, env: rename(p.env) } : p))
  if (manifest.postInstall) {
    out.postInstall = Object.fromEntries(
      Object.entries(manifest.postInstall).map(([side, items]) => [
        side,
        items.map((item) => (typeof item === 'string' ? rename(item) : { ...item, text: rename(item.text), ...(item.unlessFilled ? { unlessFilled: item.unlessFilled.map(rename) } : {}) })),
      ]),
    )
  }
  return out
}

/** The variant with its env keys named for the chosen options. */
const adjustVariant = (variant, options) => ({ ...variant, manifest: withEnvPrefix(variant.manifest, options) })

/** Compare a variant with the detected project. */
function fitVariant(variant, project) {
  const fit = {}
  let matches = 0
  let mismatches = 0
  for (const side of sidesOf(variant.manifest)) {
    const found = project[`${side}s`][0]
    fit[side] = fitSide(variant.manifest.detect?.[side], found)
    if (fit[side].status === 'match') matches++
    if (fit[side].status === 'mismatch') mismatches++
  }
  return { fit, matches, mismatches, score: matches * 2 - mismatches }
}

function rankVariants(variants, project) {
  return variants
    .map((v) => ({ ...v, ...fitVariant(v, project) }))
    .sort((a, b) => b.score - a.score || a.stack.localeCompare(b.stack))
}

function fitNotes(variant, sides = Object.keys(variant.fit)) {
  const notes = []
  for (const [side, f] of Object.entries(variant.fit)) {
    if (!sides.includes(side)) continue
    if (f.status === 'mismatch') notes.push(`${side}: expects ${f.expects}, found ${f.found}`)
    if (f.status === 'none') notes.push(`${side}: expects ${f.expects}, none detected`)
  }
  return notes
}

// ---------------------------------------------------------------- detection output

function printDetection(project) {
  console.log(`\n${bold('Looking at')} ${CWD}`)
  const row = (label, list) => {
    if (list.length === 0) return console.log(`  ${label.padEnd(9)} ${dim('not found')}`)
    list.slice(0, 3).forEach((c, i) => console.log(`  ${(i ? '' : label).padEnd(9)} ${c.label}  ${dim(rel(c.dir))}`))
    if (list.length > 3) console.log(`  ${''.padEnd(9)} ${dim(`...and ${list.length - 3} more`)}`)
  }
  row('frontend', project.frontends)
  row('backend', project.backends)
}

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (['--install', '--force', '--dry-run', '--yes', '--patch', '--no-patch'].includes(arg)) {
      flags[arg.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true
    } else if (arg === '-y') {
      flags.yes = true
    } else if (arg === '--option') {
      const pair = argv[++i]
      const eq = pair?.indexOf('=') ?? -1
      if (!pair || eq < 1) die('--option needs KEY=VALUE, e.g. --option ui=headless')
      flags.options = { ...flags.options, [pair.slice(0, eq)]: pair.slice(eq + 1) }
    } else if (arg === '--frontend' || arg === '--backend') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) die(`${arg} needs a folder`)
      flags[arg.slice(2)] = path.resolve(value)
    } else if (arg.startsWith('-')) {
      die(`Unknown option ${arg}\n\n${USAGE}`)
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

function checkFolder(side, dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return `${side} folder not found: ${dir}`
  if (side === 'frontend' && !fs.existsSync(path.join(dir, 'package.json'))) {
    return `No package.json in ${dir}. Point the frontend at the folder that contains your package.json.`
  }
  return null
}

// ---------------------------------------------------------------- install

/**
 * Add KEY=value lines that are missing from <dir>/.env, and fill keys that exist but are empty.
 * Never changes a key that already has a value.
 */
function appendEnv(dir, values, label, dry) {
  const file = path.join(dir, '.env')
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const have = new Map()
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/)
    if (m) have.set(m[1], m[2].trim())
  }
  const missing = Object.entries(values).filter(([k]) => !have.has(k))
  const fillable = Object.entries(values).filter(([k, v]) => have.get(k) === '' && v)
  if (missing.length === 0 && fillable.length === 0) return console.log(`  .env      already has the ${label} keys`)

  const summary = [...missing.map(([k]) => k), ...fillable.map(([k]) => `${k} (filled)`)].join(', ')
  if (dry) return console.log(`  would add ${summary}  ->  ${rel(file)}`)

  for (const [k, v] of fillable) text = text.replace(new RegExp(`^(\\s*${k}\\s*=)[ \\t]*(\\r?)$`, 'm'), (_, p1, p2) => `${p1}${v}${p2}`)
  if (missing.length) {
    const lead = text && !text.endsWith('\n') ? '\n\n' : text ? '\n' : ''
    text += `${lead}# ${label} (added by devcommons)\n${missing.map(([k, v]) => `${k}=${v}`).join('\n')}\n`
  }
  fs.writeFileSync(file, text)
  console.log(`  .env      added ${summary}  ->  ${rel(file)}`)
}

function targetsFor(variant, flags) {
  const bases = { '<frontend>': flags.frontend, '<backend>': flags.backend }
  const out = []
  for (const { from, to, when } of variant.manifest.copy) {
    if (!whenMatches(when, flags.options)) continue
    const placeholder = Object.keys(bases).find((p) => to.startsWith(p))
    const base = bases[placeholder]
    if (!base) continue // that side was not requested
    out.push({ from: path.join(variant.dir, from), dest: path.join(base, to.slice(placeholder.length)) })
  }
  return out
}

/** Copy files, set up .env, and report the package installs. Returns the list of copied paths. */
function runInstall(variant, flags, ctx) {
  const { feature, stack, manifest } = variant
  const dry = Boolean(flags.dryRun)
  const copied = []
  console.log(`\n${dry ? 'Dry run: ' : ''}Adding ${bold(feature)} (${stack})\n`)

  for (const { from, dest } of targetsFor(variant, flags)) {
    if (fs.existsSync(dest) && !flags.force) {
      console.log(`  skipped   ${rel(dest)} already exists (use --force to overwrite)`)
      continue
    }
    if (dry) {
      console.log(`  would copy ${rel(dest)}`)
      continue
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(from, dest, {
      recursive: true,
      force: true,
      // Test the path *inside* the feature folder only. The catalogue itself usually lives under a
      // node_modules folder (npx), so testing the full path would filter out every file.
      filter: (source) => !/(^|[\\/])(__pycache__|node_modules)([\\/]|$)/.test(path.relative(from, source)),
    })
    if (!fs.existsSync(dest) || (fs.statSync(dest).isDirectory() && fs.readdirSync(dest).length === 0)) {
      throw new Error(`Copy failed: ${rel(dest)} is missing or empty after copying from ${from}. Nothing in your code was edited.`)
    }
    copied.push(dest)
    console.log(`  copied    ${rel(dest)}`)
  }

  for (const side of ['frontend', 'backend']) {
    if (!flags[side] || !manifest.envDefaults?.[side]) continue
    appendEnv(flags[side], { ...manifest.envDefaults[side], ...ctx.envValues[side] }, `${feature} (${side})`, dry)
  }

  const frontendPkgs = manifest.dependencies?.frontend ?? []
  if (flags.frontend && frontendPkgs.length) {
    const command = jsInstallCommand(flags.packageManager ?? 'npm', frontendPkgs)
    if (flags.install && dry) {
      console.log(`\n  would run ${command}  (in ${rel(flags.frontend)})`)
    } else if (flags.install) {
      console.log(`\n  running   ${command}`)
      const result = spawnSync(command, { cwd: flags.frontend, stdio: 'inherit', shell: true })
      if (result.status !== 0) console.log(`  ${command.split(' ')[0]} failed; run it yourself in the frontend folder.`)
    } else {
      console.log(`\n  install   ${command}   (in ${rel(flags.frontend)}; or re-run with --install)`)
    }
  }

  const backendPkgs = manifest.dependencies?.backend ?? []
  if (flags.backend && backendPkgs.length) {
    if (flags.backendRuntime === 'node') {
      const command = jsInstallCommand(flags.backendPackageManager ?? 'npm', backendPkgs)
      if (flags.install && dry) {
        console.log(`\n  would run ${command}  (in ${rel(flags.backend)})`)
      } else if (flags.install) {
        console.log(`\n  running   ${command}`)
        const result = spawnSync(command, { cwd: flags.backend, stdio: 'inherit', shell: true })
        if (result.status !== 0) console.log(`  ${command.split(' ')[0]} failed; run it yourself in the backend folder.`)
      } else {
        console.log(`  install   ${command}   (in ${rel(flags.backend)}; or re-run with --install)`)
      }
    } else {
      console.log(`  install   ${pyInstallCommand(flags.pythonManager ?? 'pip', backendPkgs)}   (inside your Python environment)`)
    }
  }
  return copied
}

// ---------------------------------------------------------------- patches

/** Compute the edits for the chosen folders. */
function planEdits(variant, chosen, ctx) {
  const entry = ctx.project.backends.find((b) => b.dir === chosen.backend)?.entry ?? null
  return planPatches(variant.manifest.patches, {
    dirs: { frontend: chosen.frontend, backend: chosen.backend },
    vars: ctx.vars,
    entry,
    feature: variant.feature,
    options: chosen.options,
  })
}

function printEdits(plan, willApply) {
  if (plan.length === 0) return
  console.log(`\n${bold(willApply ? 'Edits to your files' : 'Edits (not applied)')}`)
  for (const r of plan) {
    if (r.status === 'applied') console.log(`  ${green('already in place')}  ${r.id}`)
    else if (r.status === 'manual') console.log(`  ${yellow('by hand')}  ${r.id}: ${r.reason}`)
    else {
      console.log(`  ${willApply ? 'edit' : 'could edit'}  ${rel(r.file)}  ${dim(`(${r.id})`)}`)
      console.log(renderDiff(r.before, r.after))
    }
  }
}

/** Current non-empty value of KEY in <dir>/.env, or ''. */
function envFileValue(dir, key) {
  try {
    const text = fs.readFileSync(path.join(dir, '.env'), 'utf8')
    return text.match(new RegExp(`^\\s*${key}\\s*=(.*)$`, 'm'))?.[1].trim() ?? ''
  } catch {
    return ''
  }
}

/** Steps the user still has to do: patches that were not applied, plus the manifest's postInstall list. */
function printNextSteps(variant, chosen, plan, appliedIds, envValues) {
  for (const side of ['frontend', 'backend']) {
    if (!chosen[side]) continue
    const steps = []
    for (const r of plan) {
      if (r.side !== side || r.status === 'applied' || appliedIds.has(r.id)) continue
      if (r.manualLines.length) steps.push(r.manualLines)
    }
    for (const item of variant.manifest.postInstall?.[side] ?? []) {
      const { text, unlessFilled = [], when } = typeof item === 'string' ? { text: item } : item
      if (!whenMatches(when, chosen.options)) continue
      if (unlessFilled.length && unlessFilled.every((k) => envValues[side]?.[k] || envFileValue(chosen[side], k))) continue
      steps.push([text])
    }
    if (steps.length === 0) continue
    console.log(`\nNext steps - ${side}:`)
    steps.forEach((lines, i) => {
      console.log(`  ${i + 1}. ${lines[0]}`)
      lines.slice(1).forEach((l) => console.log(l ? `     ${l}` : ''))
    })
  }
}

/** SHA-256 of a file with line endings normalised, so a Windows checkout (CRLF) hashes like the catalogue (LF). */
function hashFile(file) {
  const text = fs.readFileSync(file).toString('utf8').replace(/\r\n/g, '\n')
  return crypto.createHash('sha256').update(text).digest('hex')
}

/** Project-relative path with forward slashes: the key used in the record on every OS. */
const recordKey = (p) => path.relative(CWD, p).split(path.sep).join('/')

/** { "frontend/src/auth/index.js": "<sha256>", ... } for every file below the copied paths. */
function hashCopied(copied) {
  const out = {}
  for (const dest of copied) {
    if (!fs.existsSync(dest)) continue
    for (const sub of walkFiles(dest)) {
      const file = path.join(dest, sub)
      out[recordKey(file)] = hashFile(file)
    }
  }
  return out
}

/** Remember what was installed so a later update/remove knows what belongs to devcommons. */
function writeRecord(variant, chosen, copied, patchedFiles) {
  const file = path.join(CWD, '.devcommons.json')
  let record = { features: [] }
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    /* first install */
  }
  const same = (f) => f.feature === variant.feature && f.stack === variant.stack
  const previous = (record.features ?? []).find(same)
  const union = (a = [], b = []) => [...new Set([...a, ...b])]
  record.features = (record.features ?? []).filter((f) => !same(f))
  record.features.push({
    feature: variant.feature,
    stack: variant.stack,
    version: variant.manifest.version,
    installedAt: previous?.installedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    options: chosen.options ?? {},
    frontend: chosen.frontend ? rel(chosen.frontend) : null,
    backend: chosen.backend ? rel(chosen.backend) : null,
    copied: union(previous?.copied, copied.map(rel)),
    // what each copied file looked like when it was put there; lets remove/update tell your edits from ours
    // (a record from before hashes existed stays without them: a partial set would make remove keep everything)
    ...(!previous || previous.hashes ? { hashes: { ...previous?.hashes, ...hashCopied(copied) } } : {}),
    patched: union(previous?.patched, patchedFiles.map(rel)),
  })
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
}

/** Decide the variant options (ui, ...): --option flag > question (interactive) > default. */
async function resolveOptions(manifest, flags, interactive, frontend) {
  const out = {}
  const given = flags.options ?? {}
  const known = (manifest.options ?? []).map((o) => o.key)
  for (const key of Object.keys(given)) if (!known.includes(key)) die(`Unknown option "${key}". This stack has: ${known.join(', ') || 'none'}`)
  for (const opt of manifest.options ?? []) {
    const values = opt.choices.map((c) => c.value)
    if (given[opt.key] !== undefined) {
      if (!values.includes(given[opt.key])) die(`--option ${opt.key}=${given[opt.key]} is not valid. Choose one of: ${values.join(', ')}`)
      out[opt.key] = given[opt.key]
    } else if (opt.fromTags && frontend && Object.keys(opt.fromTags).some((tag) => frontend.tags.includes(tag))) {
      // decided by what the project is, not by a question (e.g. env: vite | cra)
      const tag = Object.keys(opt.fromTags).find((t) => frontend.tags.includes(t))
      out[opt.key] = opt.fromTags[tag]
      console.log(`  ${dim(`${opt.key}: ${out[opt.key]} (detected ${tag})`)}`)
    } else if (interactive && !opt.fromTags) {
      const def = Math.max(0, values.indexOf(opt.default))
      out[opt.key] = await select(opt.ask, opt.choices.map((c) => ({ label: c.label, hint: c.hint ? dim(c.hint) : '', value: c.value })), def)
    } else out[opt.key] = opt.default ?? values[0]
  }
  return out
}

/** Ask the manifest's questions (backend URL, Firebase values, ...). Non-interactive runs take the defaults. */
async function collectVars(manifest, chosen, interactive, project) {
  const found = (side) => project?.[`${side}s`]?.find((c) => c.dir === chosen[side]) ?? project?.[`${side}s`]?.[0]
  const optionDefault = (p) => {
    const byOption = p.defaultBy?.values?.[chosen.options?.[p.defaultBy.option]]
    if (byOption) return byOption
    // from what was detected in the other half of the project (its tags, its port)
    const tags = found(p.defaultByTag?.side)?.tags ?? []
    const tagHit = Object.keys(p.defaultByTag?.tags ?? {}).find((t) => tags.includes(t))
    if (tagHit) return p.defaultByTag.tags[tagHit]
    const port = found(p.defaultFromPort?.side)?.port
    if (port) return p.defaultFromPort.template.replace('{port}', port)
    return p.default ?? ''
  }
  const vars = {}
  const envValues = { frontend: {}, backend: {} }
  const groups = {}
  for (const p of manifest.prompts ?? []) {
    if (p.side && !chosen[p.side]) continue
    let value = optionDefault(p)
    if (interactive) {
      let askIt = true
      if (p.group) {
        if (!(p.group in groups)) groups[p.group] = await confirm(`\n${p.groupAsk ?? `Set ${p.group} now?`}`, false)
        askIt = groups[p.group]
      }
      if (askIt) value = (await ask(`${p.ask}${value ? ` [${value}]` : ''}: `)) || value
    }
    vars[p.key] = value
    if (p.env && p.side && value) envValues[p.side][p.env] = value
  }
  return { vars, envValues }
}

// ---------------------------------------------------------------- add (interactive or not)

/** Pick the folder for one side: flag > detected > ask. Returns an absolute path or null (skip). */
async function chooseFolder(side, found, flags) {
  if (flags[side]) return flags[side]
  const Side = side[0].toUpperCase() + side.slice(1)

  if (flags.yes) {
    if (found[0]) return found[0].dir
    console.log(`  ${yellow('skipping')} ${side}: nothing detected (pass --${side} DIR to set it)`)
    return null
  }

  let picked = null
  if (found.length === 1) {
    const c = found[0]
    if (await confirm(`\nUse ${bold(rel(c.dir))} for the ${side}? ${dim(`(${c.label})`)}`)) return c.dir
  } else if (found.length > 1) {
    picked = await select(`Which ${side} folder?`, [
      ...found.map((c) => ({ label: rel(c.dir), hint: dim(c.label), value: c.dir })),
      { label: 'Another folder...', value: '__other' },
      { label: `Skip the ${side}`, value: '__skip' },
    ])
    if (picked === '__skip') return null
    if (picked !== '__other') return picked
  }

  for (;;) {
    const answer = await ask(`\n${Side} folder (path, or press Enter to skip): `)
    if (!answer) return null
    const dir = path.resolve(CWD, answer)
    const problem = checkFolder(side, dir)
    if (!problem) return dir
    console.log(`  ${red(problem)}`)
  }
}

async function cmdAdd(positional, flags) {
  const variants = loadVariants()
  if (variants.length === 0) die('No features found in this devcommons install.')

  const complete = positional.length === 2 && (flags.frontend || flags.backend)
  const interactive = !complete && !flags.yes

  for (const side of ['frontend', 'backend']) {
    if (flags[side]) {
      const problem = checkFolder(side, flags[side])
      if (problem) die(problem)
    }
  }

  const project = detectProject(CWD)
  if (!complete && !flags._side) printDetection(project)

  // 1. feature
  const features = [...new Set(variants.map((v) => v.feature))]
  let feature = positional[0]
  if (feature && !features.includes(feature)) die(`No feature "${feature}". Available: ${features.join(', ')}`)
  if (!feature) {
    if (features.length === 1) feature = features[0]
    else if (flags.yes) die(`Say which feature to add (${features.join(', ')}).`)
    else feature = await select('What do you want to add?', features.map((f) => ({ label: f, value: f })))
  }

  // 2. stack variant
  const ranked = rankVariants(variants.filter((v) => v.feature === feature), project)
  let variant
  if (positional[1]) {
    variant = ranked.find((v) => v.stack === positional[1])
    if (!variant) die(`No stack "${positional[1]}" for ${feature}. Run "devcommons list" to see what exists.`)
  } else if (flags.yes) {
    const [best, second] = ranked
    if (best.score <= 0 || (second && second.score === best.score)) {
      die(`Could not pick a stack automatically. Name one: ${ranked.map((v) => v.stack).join(', ')}`)
    }
    variant = best
  } else if (ranked.length === 1) {
    variant = ranked[0]
  } else {
    variant = await select(
      `Which stack for ${feature}?`,
      ranked.map((v) => ({
        label: v.stack,
        hint: v.score > 0 && v.mismatches === 0 ? green('fits your project') : v.mismatches ? yellow('does not match what was detected') : '',
        value: v,
      })),
    )
  }
  if (!complete) console.log(`\n${bold('Stack:')} ${variant.stack}`)
  // Which halves of this stack belong in this project? A half that does not match what was found
  // (FastAPI code in an Express folder) is left out; the other stack for that side is offered afterwards.
  let wanted = sidesOf(variant.manifest)
  const skipped = []
  if (flags._side) wanted = wanted.filter((side) => side === flags._side)
  else if (!complete) {
    const fits = wanted.filter((side) => variant.fit[side]?.status !== 'mismatch')
    if (fits.length && fits.length < wanted.length) {
      for (const side of wanted.filter((x) => !fits.includes(x))) {
        skipped.push(side)
        console.log(`  ${yellow('!')} Not installing the ${side} part: found ${variant.fit[side].found}, this stack's ${side} is ${variant.fit[side].expects}`)
      }
      wanted = fits
    }
  }
  const notes = complete ? [] : fitNotes(variant, wanted)
  if (notes.length) {
    notes.forEach((n) => console.log(`  ${yellow('!')} ${n}`))
    if (interactive && !(await confirm('This stack may not fit. Continue anyway?', false))) return console.log('Cancelled.')
  }

  // 3. folders
  const chosen = { ...flags }
  // Explicit folders given on the command line: use exactly those and never ask about the other side.
  for (const side of wanted) chosen[side] = complete ? flags[side] : await chooseFolder(side, project[`${side}s`], flags)
  for (const side of ['frontend', 'backend']) if (!wanted.includes(side)) chosen[side] = undefined
  if (!chosen.frontend && !chosen.backend) die('Nothing to install: no frontend or backend folder was chosen.')

  // 4. options, conflicts, install, questions
  chosen.options = await resolveOptions(variant.manifest, flags, interactive, chosen.frontend ? detectFrontend(chosen.frontend) : null)
  variant = adjustVariant(variant, chosen.options)
  chosen.packageManager = chosen.frontend ? detectPackageManager(chosen.frontend, CWD) : null
  const backendFound = chosen.backend ? (project.backends.find((b) => b.dir === chosen.backend) ?? detectBackend(chosen.backend)) : null
  chosen.backendRuntime = backendFound?.tags.includes('node') ? 'node' : 'python'
  chosen.backendPackageManager = backendFound && chosen.backendRuntime === 'node' ? detectPackageManager(chosen.backend, CWD) : null
  chosen.pythonManager = backendFound && chosen.backendRuntime === 'python' ? detectPythonManager(chosen.backend) : null
  if (interactive) {
    const conflicts = targetsFor(variant, chosen).filter((t) => fs.existsSync(t.dest))
    if (conflicts.length && !chosen.force) {
      console.log('\nThese already exist:')
      conflicts.forEach((t) => console.log(`  ${rel(t.dest)}`))
      chosen.force = await confirm('Overwrite them?', false)
    }
    if (chosen.frontend && (variant.manifest.dependencies?.frontend ?? []).length && !chosen.install) {
      chosen.install = await confirm(`Run ${jsInstallCommand(chosen.packageManager, variant.manifest.dependencies.frontend)} in ${rel(chosen.frontend)} now?`)
    } else if (chosen.backendRuntime === 'node' && (variant.manifest.dependencies?.backend ?? []).length && !chosen.install) {
      chosen.install = await confirm(`Run ${jsInstallCommand(chosen.backendPackageManager, variant.manifest.dependencies.backend)} in ${rel(chosen.backend)} now?`)
    }
  }
  const ctx = { project, ...(await collectVars(variant.manifest, chosen, interactive, project)) }

  // Halves of the project this stack does not cover (a frontend-less variant, or a half left out above):
  // look for the stack that fits them, so each stack stays in its own folder and its own module.
  const leftover = complete || flags._side ? [] : ['frontend', 'backend'].filter((side) => !wanted.includes(side) && project[`${side}s`].length)
  const followUp = async () => {
    for (const side of leftover) {
      const here = project[`${side}s`][0]
      const other = ranked.find((v) => v.stack !== variant.stack && sidesOf(v.manifest).includes(side) && v.fit[side]?.status === 'match')
      if (!other) {
        console.log(`\n${yellow('!')} There is no ${feature} stack for your ${side} (${here.label}) yet. "devcommons list" shows what exists.`)
        continue
      }
      console.log(`\n${bold(`The ${side} part`)}: ${other.stack} fits your ${here.label}.`)
      if (!interactive && positional[1]) {
        console.log(`Next: devcommons add ${feature} ${other.stack} --${side} ${rel(here.dir)}`)
        continue
      }
      if (interactive && !(await confirm(`Add the ${side} part from ${other.stack} now?`, true))) {
        console.log(`Later: devcommons add ${feature} ${other.stack} --${side} ${rel(here.dir)}`)
        continue
      }
      await cmdAdd([feature, other.stack], { ...flags, _side: side })
    }
  }

  // 5. preview, confirm
  const patchMode = chosen.noPatch ? 'off' : interactive || chosen.yes || chosen.patch ? 'on' : 'manual'
  const hasPatches = Boolean(variant.manifest.patches)
  if (interactive) {
    runInstall(variant, { ...chosen, dryRun: true }, ctx)
    if (hasPatches && patchMode === 'on') printEdits(planEdits(variant, chosen, ctx), true)
    if (chosen.dryRun) return followUp()
    if (!(await confirm('\nGo ahead?'))) return console.log('Cancelled.')
  }

  // 6. do it
  const copied = runInstall(variant, chosen, ctx)
  let plan = []
  const appliedIds = new Set()
  const patchedFiles = []
  if (hasPatches && patchMode !== 'off') {
    plan = planEdits(variant, chosen, ctx)
    if (chosen.dryRun) {
      printEdits(plan, patchMode === 'on')
    } else if (patchMode === 'on') {
      if (!interactive) printEdits(plan, true)
      patchedFiles.push(...applyPatches(plan, CWD))
      plan.filter((r) => r.status === 'apply').forEach((r) => appliedIds.add(r.id))
      if (patchedFiles.length) console.log(`\n  Originals saved in ${rel(path.join(CWD, '.devcommons', 'backup'))}`)
    }
  } else if (hasPatches && !chosen.dryRun) {
    plan = planEdits(variant, chosen, ctx)
  }

  if (chosen.dryRun) {
    console.log(`\n${dim('Dry run: nothing was changed.')}\n`)
    return followUp()
  }
  writeRecord(variant, chosen, copied, patchedFiles)
  printNextSteps(variant, chosen, plan, appliedIds, ctx.envValues)
  console.log(`\nFull guide: features/${variant.feature}/${variant.stack}/README.md\n`)
  await followUp()
}


// ---------------------------------------------------------------- remove

/** All files below a path (relative paths), ignoring caches. A file path gives ['']. */
function walkFiles(root, sub = '') {
  const full = path.join(root, sub)
  if (!fs.statSync(full).isDirectory()) return ['']
  const out = []
  for (const name of fs.readdirSync(full)) {
    if (name === '__pycache__' || name === 'node_modules') continue
    const next = path.join(sub, name)
    if (fs.statSync(path.join(root, next)).isDirectory()) out.push(...walkFiles(root, next))
    else out.push(next)
  }
  return out
}

function sameContent(a, b) {
  const x = fs.readFileSync(a)
  const y = fs.readFileSync(b)
  return x.equals(y) || x.toString('utf8').replace(/\r\n/g, '\n') === y.toString('utf8').replace(/\r\n/g, '\n')
}

/** Which copied files are still exactly what devcommons put there (safe to delete) and which were edited or added by you. */
function planRemoval(variant, chosen, force, hashes) {
  const remove = []
  const edited = []
  const yours = []
  const dirs = []
  for (const { from, dest } of targetsFor(variant, chosen)) {
    if (!fs.existsSync(dest)) continue
    const isDir = fs.statSync(from).isDirectory()
    if (hashes) {
      // Judge against what was recorded at install time, so it still works after the catalogue changed.
      if (isDir) dirs.push(dest)
      for (const sub of walkFiles(dest)) {
        const file = path.join(dest, sub)
        const recorded = hashes[recordKey(file)]
        if (recorded === undefined) yours.push(file)
        else if (force || hashFile(file) === recorded) remove.push(file)
        else edited.push(file)
      }
      continue
    }
    const known = new Set()
    for (const sub of isDir ? walkFiles(from) : ['']) {
      const src = path.join(from, sub)
      const dst = path.join(dest, sub)
      known.add(dst)
      if (!fs.existsSync(dst)) continue
      if (force || sameContent(src, dst)) remove.push(dst)
      else edited.push(dst)
    }
    if (isDir) {
      dirs.push(dest)
      for (const sub of walkFiles(dest)) if (!known.has(path.join(dest, sub))) yours.push(path.join(dest, sub))
    }
  }
  return { remove, edited, yours, dirs }
}

/** Drop caches and empty folders left behind below dir (never a folder that still has files in it). */
function pruneEmpty(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return
  for (const name of fs.readdirSync(dir)) {
    const sub = path.join(dir, name)
    if (!fs.statSync(sub).isDirectory()) continue
    if (name === '__pycache__') fs.rmSync(sub, { recursive: true, force: true })
    else pruneEmpty(sub)
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
}

/** Remove empty folders going up from dir, never past a project side's root folder. */
function pruneParents(dir, stops) {
  while (dir && !stops.includes(dir) && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir)
    dir = path.dirname(dir)
  }
}

/** Read .devcommons.json and pick the installed feature the user means (asks if several match). */
async function pickInstalled(positional, flags, verb) {
  const recordFile = path.join(CWD, '.devcommons.json')
  let record
  try {
    record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
  } catch {
    die(`No .devcommons.json here, so there is nothing recorded to ${verb}. Run this in the project where you ran "devcommons add".`)
  }
  const installed = record.features ?? []
  if (installed.length === 0) die('.devcommons.json lists no features.')

  let matches = installed.filter((f) => (!positional[0] || f.feature === positional[0]) && (!positional[1] || f.stack === positional[1]))
  if (matches.length === 0) die(`"${positional.join(' ')}" is not installed here. Installed: ${installed.map((f) => `${f.feature} (${f.stack})`).join(', ')}`)
  if (matches.length > 1) {
    if (flags.yes) die(`Several match. Name one: ${matches.map((f) => `${f.feature} ${f.stack}`).join(', ')}`)
    matches = [await select(`Which one do you want to ${verb}?`, matches.map((f) => ({ label: `${f.feature} (${f.stack})`, value: f })))]
  }
  return { recordFile, record, installed, entry: matches[0] }
}

/** Folders an installed entry lives in, as absolute paths (a side whose folder is gone is skipped with a note). */
function recordedDirs(entry, manifest) {
  const chosen = { options: entry.options ? completeOptions(manifest, entry.options) : {} }
  for (const side of ['frontend', 'backend']) {
    if (!entry[side]) continue
    const dir = path.resolve(CWD, entry[side])
    if (fs.existsSync(dir)) chosen[side] = dir
    else console.log(`  ${yellow('skipping')} ${side}: ${entry[side]} no longer exists`)
  }
  return chosen
}

async function cmdRemove(positional, flags) {
  const { recordFile, record, installed, entry } = await pickInstalled(positional, flags, 'remove')
  let variant = loadVariants().find((v) => v.feature === entry.feature && v.stack === entry.stack)
  if (!variant) die(`${entry.feature} (${entry.stack}) is not in this devcommons install any more, so I cannot tell which edits were mine. Remove it by hand.`)

  // Installs made before the core/ui split copied one flat folder that the catalogue no longer has,
  // so the files cannot be compared. Edits are still reverted; the copied files are listed instead.
  const legacy = Boolean(variant.manifest.options?.length) && !entry.options
  const chosen = recordedDirs(entry, variant.manifest)
  variant = adjustVariant(variant, chosen.options)

  console.log(`\n${flags.dryRun ? 'Dry run: ' : ''}Removing ${bold(entry.feature)} (${entry.stack})`)
  const edits = planReverts(variant.manifest.patches, {
    dirs: chosen,
    feature: entry.feature,
    recordedFiles: (entry.patched ?? []).map((f) => path.resolve(CWD, f)),
  })
  const files = legacy ? { remove: [], edited: [], yours: [], dirs: [] } : planRemoval(variant, chosen, Boolean(flags.force), entry.hashes)

  console.log(`\n${bold('Edits to undo')}`)
  if (edits.length === 0) console.log(`  ${dim('none recorded')}`)
  for (const r of edits) {
    if (r.status === 'absent') console.log(`  ${dim('nothing to undo')}  ${r.id}`)
    else if (r.status === 'manual') console.log(`  ${yellow('by hand')}  ${r.id}: ${r.reason}`)
    else {
      console.log(`  undo  ${rel(r.file)}  ${dim(`(${r.id})`)}`)
      console.log(renderDiff(r.before, r.after))
    }
  }
  console.log(`\n${bold('Files')}`)
  files.remove.forEach((f) => console.log(`  delete  ${rel(f)}`))
  files.edited.forEach((f) => console.log(`  ${yellow('keep')}    ${rel(f)}  ${dim('(you changed it; use --force to delete)')}`))
  files.yours.forEach((f) => console.log(`  ${yellow('keep')}    ${rel(f)}  ${dim('(not part of devcommons)')}`))
  if (legacy) {
    console.log(`  ${yellow('by hand')}  installed by an older devcommons; delete these yourself:`)
    ;(entry.copied ?? []).forEach((f) => console.log(`            ${f}`))
  } else if (files.remove.length + files.edited.length === 0) console.log(`  ${dim('nothing to delete')}`)

  if (flags.dryRun) return console.log(`\n${dim('Dry run: nothing was changed.')}\n`)
  if (!flags.yes && !(await confirm('\nGo ahead?', false))) return console.log('Cancelled.')

  const patched = applyPatches(edits, CWD)
  files.remove.forEach((f) => fs.rmSync(f, { force: true }))
  files.dirs.forEach(pruneEmpty)
  files.remove.forEach((f) => pruneParents(path.dirname(f), [chosen.frontend, chosen.backend]))

  record.features = installed.filter((f) => f !== entry)
  if (record.features.length === 0) fs.rmSync(recordFile)
  else fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`)

  console.log(`\nRemoved: ${files.remove.length} file(s) deleted, ${patched.length} file(s) edited.`)
  const left = []
  const envKeys = (side) => Object.keys(variant.manifest.envDefaults?.[side] ?? {})
  for (const side of ['frontend', 'backend']) {
    if (chosen[side] && envKeys(side).length) left.push(`${rel(path.join(chosen[side], '.env'))} still has ${envKeys(side).join(', ')}; delete those lines if you do not need them.`)
  }
  const pkgs = variant.manifest.dependencies?.frontend ?? []
  if (chosen.frontend && pkgs.length) {
    const pm = detectPackageManager(chosen.frontend, CWD)
    left.push(`Packages are untouched. If nothing else uses them: ${pm === 'npm' ? 'npm uninstall' : `${pm} remove`} ${pkgs.join(' ')}`)
  }
  const backendPkgs = variant.manifest.dependencies?.backend ?? []
  if (chosen.backend && backendPkgs.length && fs.existsSync(path.join(chosen.backend, 'package.json'))) {
    const pm = detectPackageManager(chosen.backend, CWD)
    left.push(`Packages are untouched. If nothing else uses them: ${pm === 'npm' ? 'npm uninstall' : `${pm} remove`} ${backendPkgs.join(' ')}   (in ${rel(chosen.backend)})`)
  }
  if (patched.length) left.push(`Originals from before the install are still in ${rel(path.join(CWD, '.devcommons', 'backup'))}.`)
  if (files.edited.length + files.yours.length) left.push('Files marked "keep" above were left in place.')
  if (left.length) {
    console.log('\nLeft for you:')
    left.forEach((l) => console.log(`  - ${l}`))
  }
  console.log()
}

// ---------------------------------------------------------------- update

const clip = (text, max = 30) => {
  const lines = text.split('\n')
  return lines.length <= max ? text : `${lines.slice(0, max).join('\n')}\n  ${dim(`... ${lines.length - max} more lines`)}`
}

/**
 * Three-way plan for one installed feature, per file:
 *   recorded = hash when devcommons copied it, current = what is on disk, latest = the catalogue now.
 */
function planUpdate(variant, chosen, hashes, force) {
  const plan = { update: [], add: [], conflict: [], deleted: [], stale: [], adopt: [], unchanged: 0, yours: [] }
  const inCatalogue = new Set()
  for (const { from, dest } of targetsFor(variant, chosen)) {
    const isDir = fs.statSync(from).isDirectory()
    for (const sub of isDir ? walkFiles(from) : ['']) {
      const src = path.join(from, sub)
      const dst = path.join(dest, sub)
      const key = recordKey(dst)
      inCatalogue.add(key)
      const latest = hashFile(src)
      const recorded = hashes[key]
      const here = fs.existsSync(dst)
      const current = here ? hashFile(dst) : null
      const item = { src, dst, key, latest }
      if (recorded === undefined) {
        if (!here) plan.add.push(item)
        else if (current === latest) plan.adopt.push(item) // same as the catalogue: just start tracking it
        else plan.yours.push(item) // exists, never ours, differs: leave it
      } else if (recorded === latest) {
        plan.unchanged++
      } else if (!here) {
        plan.deleted.push(item) // you removed it on purpose; do not bring it back
      } else if (current === latest) {
        plan.adopt.push(item) // already has the new content
      } else if (current === recorded) {
        plan.update.push(item) // you never touched it
      } else {
        plan.conflict.push(item) // you edited it and the catalogue changed it too
        if (force) plan.update.push({ ...item, forced: true })
      }
    }
  }
  // Recorded files the catalogue no longer ships (every key in the record belongs to this feature).
  for (const key of Object.keys(hashes)) {
    if (inCatalogue.has(key)) continue
    const file = path.join(CWD, ...key.split('/'))
    if (!fs.existsSync(file)) continue
    plan.stale.push({ dst: file, key, edited: hashFile(file) !== hashes[key] })
  }
  return plan
}

async function cmdUpdate(positional, flags) {
  const { recordFile, record, entry } = await pickInstalled(positional, flags, 'update')
  let variant = loadVariants().find((v) => v.feature === entry.feature && v.stack === entry.stack)
  if (!variant) die(`${entry.feature} (${entry.stack}) is not in this devcommons any more, so there is nothing to update it from.`)
  if (!entry.hashes) {
    die(
      `${entry.feature} (${entry.stack}) was installed by devcommons 0.6.0 or older, which did not record what it copied, so I cannot tell your edits from mine.\n` +
        'Run "devcommons remove" and then "devcommons add" once; later updates will work.',
    )
  }
  if (variant.manifest.options?.length && !entry.options) die('This install predates the core/ui split; run "devcommons remove" and "devcommons add" once.')

  const chosen = recordedDirs(entry, variant.manifest)
  variant = adjustVariant(variant, chosen.options)
  const plan = planUpdate(variant, chosen, entry.hashes, Boolean(flags.force))
  const forced = plan.update.filter((i) => i.forced)
  const changes = plan.update.length + plan.add.length + plan.stale.filter((i) => !i.edited).length

  console.log(`\n${flags.dryRun ? 'Dry run: ' : ''}Updating ${bold(entry.feature)} (${entry.stack})  ${dim(`${entry.version ?? '?'} -> ${variant.manifest.version}`)}`)

  console.log(`\n${bold('Files')}`)
  for (const i of plan.update) {
    console.log(`  ${i.forced ? yellow('overwrite') : 'update   '} ${rel(i.dst)}${i.forced ? dim('  (your edits are saved in .devcommons/backup/update/)') : ''}`)
    console.log(clip(renderDiff(fs.readFileSync(i.dst, 'utf8'), fs.readFileSync(i.src, 'utf8'))))
  }
  plan.add.forEach((i) => console.log(`  add       ${rel(i.dst)}  ${dim('(new in this version)')}`))
  plan.stale.forEach((i) =>
    console.log(i.edited ? `  ${yellow('keep')}      ${rel(i.dst)}  ${dim('(no longer shipped, but you changed it)')}` : `  delete    ${rel(i.dst)}  ${dim('(no longer shipped)')}`),
  )
  plan.conflict
    .filter((i) => !i.forced)
    .forEach((i) => console.log(`  ${yellow('conflict')}  ${rel(i.dst)}  ${dim('(you edited it and the new version changed it; kept yours, --force overwrites)')}`))
  plan.deleted.forEach((i) => console.log(`  ${dim('skipped')}   ${rel(i.dst)}  ${dim('(you deleted it; not brought back)')}`))
  plan.yours.forEach((i) => console.log(`  ${yellow('keep')}      ${rel(i.dst)}  ${dim('(exists, not installed by devcommons)')}`))
  if (changes + plan.conflict.length + plan.deleted.length + plan.yours.length === 0) console.log(`  ${green('already up to date')}  ${dim(`(${plan.unchanged} files checked)`)}`)

  // new .env keys this version needs (only ever adds missing keys)
  for (const side of ['frontend', 'backend']) {
    if (chosen[side] && variant.manifest.envDefaults?.[side]) appendEnv(chosen[side], variant.manifest.envDefaults[side], `${entry.feature} (${side})`, Boolean(flags.dryRun))
  }

  if (flags.dryRun) return console.log(`\n${dim('Dry run: nothing was changed.')}\n`)
  if (changes > 0 && !flags.yes && !(await confirm('\nGo ahead?', true))) return console.log('Cancelled.')

  const hashes = { ...entry.hashes }
  for (const i of forced) {
    const backup = path.join(CWD, '.devcommons', 'backup', 'update', ...i.key.split('/'))
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    fs.copyFileSync(i.dst, backup)
  }
  for (const i of [...plan.update, ...plan.add]) {
    fs.mkdirSync(path.dirname(i.dst), { recursive: true })
    fs.copyFileSync(i.src, i.dst)
    hashes[i.key] = i.latest
  }
  for (const i of plan.adopt) hashes[i.key] = i.latest
  for (const i of plan.stale) {
    if (i.edited) continue
    fs.rmSync(i.dst, { force: true })
    delete hashes[i.key]
    pruneParents(path.dirname(i.dst), [chosen.frontend, chosen.backend])
  }
  for (const i of plan.deleted) delete hashes[i.key] // you dropped it; stop tracking it

  Object.assign(entry, { version: variant.manifest.version, updatedAt: new Date().toISOString(), hashes })
  fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`)

  const pending = plan.conflict.length - forced.length
  console.log(`\nUpdated: ${plan.update.length} file(s) replaced, ${plan.add.length} added, ${plan.stale.filter((i) => !i.edited).length} deleted.`)
  const notes = []
  if (pending) notes.push(`${pending} file(s) marked "conflict" keep your version. Compare them with features/${entry.feature}/${entry.stack}/ and merge by hand, or re-run with --force to take the new one.`)
  if (variant.manifest.patches) notes.push('Edits to your own files (the wrap, the proxy, ...) are not changed by update. If this version adds new ones, run "devcommons add" again; it skips what is already in place.')
  const pkgs = variant.manifest.dependencies?.frontend ?? []
  if (chosen.frontend && pkgs.length && changes) notes.push(`If the new version needs new packages: ${jsInstallCommand(detectPackageManager(chosen.frontend, CWD), pkgs)}   (in ${rel(chosen.frontend)})`)
  if (notes.length) {
    console.log('\nNotes:')
    notes.forEach((n) => console.log(`  - ${n}`))
  }
  console.log()
}

// ---------------------------------------------------------------- other commands

function cmdDetect() {
  const project = detectProject(CWD)
  printDetection(project)
  const variants = rankVariants(loadVariants(), project)
  if (variants.length) console.log(`\n${bold('Stacks that fit:')}`)
  for (const v of variants) {
    const status = v.score > 0 && v.mismatches === 0 ? green('fits') : v.mismatches ? yellow('mismatch') : dim('unknown')
    console.log(`  ${v.feature} ${v.stack}  ${status}`)
    fitNotes(v).forEach((n) => console.log(`      ${dim(n)}`))
  }
  console.log()
}

function cmdList() {
  const variants = loadVariants()
  if (variants.length === 0) console.log('No features found.')
  for (const { feature, stack, manifest } of variants) {
    console.log(`${feature}  ${stack}  v${manifest.version}\n    ${manifest.description}`)
  }
}

// ---------------------------------------------------------------- main

const [command, ...rest] = process.argv.slice(2)

try {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE)
  } else if (command === 'list') {
    cmdList()
  } else if (command === 'detect') {
    cmdDetect()
  } else if (command === 'add') {
    const { positional, flags } = parseArgs(rest)
    if (positional.length > 2) die(`"add" takes at most a feature and a stack.\n\n${USAGE}`)
    await cmdAdd(positional, flags)
  } else if (command === 'remove') {
    const { positional, flags } = parseArgs(rest)
    if (positional.length > 2) die(`"remove" takes at most a feature and a stack.\n\n${USAGE}`)
    await cmdRemove(positional, flags)
  } else if (command === 'update') {
    const { positional, flags } = parseArgs(rest)
    if (positional.length > 2) die(`"update" takes at most a feature and a stack.\n\n${USAGE}`)
    await cmdUpdate(positional, flags)
  } else {
    die(`Unknown command "${command}".\n\n${USAGE}`)
  }
} catch (err) {
  if (err instanceof InputEnded) {
    die('Input ended before all questions were answered. Run it in a terminal, or pass flags / --yes.')
  }
  throw err
} finally {
  closePrompts()
}
