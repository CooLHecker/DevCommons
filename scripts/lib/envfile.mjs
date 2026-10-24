// Reading .env files. Values are returned to the caller only; nothing here prints them.

import fs from 'node:fs'
import path from 'node:path'

/** KEY=value lines -> Map. Handles `export KEY=...`, quotes, and trailing " # comment" on unquoted values. */
export function parseEnv(text) {
  const out = new Map()
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=(.*)$/)
    if (!m) continue
    let value = m[2].trim()
    const q = value[0]
    if ((q === '"' || q === "'") && value.indexOf(q, 1) > 0) value = value.slice(1, value.indexOf(q, 1))
    else value = value.replace(/\s+#.*$/, '')
    out.set(m[1], value)
  }
  return out
}

/** Files a dev server reads, lowest priority first. */
export const ENV_FILES = {
  frontend: ['.env', '.env.development', '.env.local', '.env.development.local'],
  backend: ['.env'],
}

/** The env files that exist in `dir` for this side, with their parsed values. */
export function readEnvFiles(dir, side) {
  const out = []
  for (const name of ENV_FILES[side] ?? ['.env']) {
    const file = path.join(dir, name)
    try {
      if (fs.statSync(file).isFile()) out.push({ name, file, values: parseEnv(fs.readFileSync(file, 'utf8')) })
    } catch {
      /* not there */
    }
  }
  return out
}

/** Value of `key` for a side: the highest-priority file that defines it, then the real environment. null = not defined anywhere. */
export function envLookup(files, key, env = process.env) {
  for (const f of [...files].reverse()) if (f.values.has(key)) return { value: f.values.get(key), from: f.name }
  if (env[key] !== undefined) return { value: env[key], from: 'environment' }
  return null
}
