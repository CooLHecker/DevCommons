#!/usr/bin/env node
// Contract checks for an auth backend (see README.md in this folder).
//   node conformance.mjs <baseUrl> [--prefix /api] [--token <firebase id token>]
// Without a token it checks everything that needs no credentials (the 401 behaviour).
// With one it also checks the 200 responses and the user shape.

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? '').replace(/\/$/, '')
const prefix = flag('--prefix') ?? '/api'
const token = flag('--token')
if (!base) {
  console.error('usage: node conformance.mjs <baseUrl> [--prefix /api] [--token <idToken>]')
  process.exit(2)
}

const USER_KEYS = ['uid', 'email', 'email_verified', 'name', 'picture', 'provider']
let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ok    ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL  ${name}\n        ${err.message}`)
  }
}
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}
const call = (method, route, headers = {}) => fetch(`${base}${prefix}${route}`, { method, headers })

async function expect401(res, detail) {
  eq(res.status, 401, 'status')
  eq(res.headers.get('www-authenticate'), 'Bearer', 'WWW-Authenticate')
  const body = await res.json()
  eq(typeof body.detail, 'string', 'detail is a string')
  if (detail) eq(body.detail, detail, 'detail')
  return body
}

console.log(`auth contract against ${base}${prefix}`)
for (const [method, route] of [['GET', '/auth/me'], ['POST', '/auth/register']]) {
  await check(`${method} ${route} without a token -> 401 "Missing bearer token"`, async () => expect401(await call(method, route), 'Missing bearer token'))
  await check(`${method} ${route} with a non-Bearer scheme -> 401 "Missing bearer token"`, async () => expect401(await call(method, route, { Authorization: 'Basic dXNlcjpwYXNz' }), 'Missing bearer token'))
  await check(`${method} ${route} with a garbage token -> 401`, async () => {
    const body = await expect401(await call(method, route, { Authorization: 'Bearer not-a-real-token' }))
    if (!body.detail.startsWith('Invalid token')) throw new Error(`detail should start with "Invalid token", got ${JSON.stringify(body.detail)}`)
  })
}

if (token) {
  for (const [method, route] of [['GET', '/auth/me'], ['POST', '/auth/register']]) {
    await check(`${method} ${route} with a valid token -> 200 and the user`, async () => {
      const res = await call(method, route, { Authorization: `Bearer ${token}` })
      eq(res.status, 200, 'status')
      const user = await res.json()
      eq(JSON.stringify(Object.keys(user).sort()), JSON.stringify([...USER_KEYS].sort()), 'user keys')
      eq(typeof user.uid, 'string', 'uid')
      eq(typeof user.email_verified, 'boolean', 'email_verified')
    })
  }
} else {
  console.log('  skip  200 checks (pass --token <idToken> to run them)')
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
