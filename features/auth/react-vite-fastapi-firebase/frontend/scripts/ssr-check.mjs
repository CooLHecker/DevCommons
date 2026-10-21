// Server-render checks of the screens' props (labels, classNames, layout, slots, renderForm, hooks).
// No browser and no Firebase project needed:  npm install && npm run check
for (const k of ['API_KEY', 'AUTH_DOMAIN', 'PROJECT_ID', 'APP_ID']) process.env[`VITE_FIREBASE_${k}`] ??= 'x'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import React from 'react'
import { renderToString } from 'react-dom/server'
const server = await createServer({ plugins: [react()], server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const core = await server.ssrLoadModule('/src/auth/core/AuthContext.jsx')
const a = await server.ssrLoadModule('/src/auth/index.js')
const h = React.createElement
const fake = { user: null, loading: false, signIn() {}, signUp() {}, signInWithGoogle() {}, resetPassword() {}, verifyResetCode: () => new Promise(() => {}), confirmReset() {}, logout() {} }
const wrap = (el, over = {}) => renderToString(h(core.AuthContext.Provider, { value: { ...fake, ...over } }, el))
let fails = 0
const ok = (name, cond) => { console.log(cond ? 'ok  ' : 'FAIL', name); if (!cond) fails++ }

let html = wrap(h(a.AuthGate, {}))
ok('default login title + Google button', html.includes('Welcome back') && html.includes('Continue with Google'))
ok('fullscreen uses <main class="auth-page auth-page--fullscreen">', /<main class="auth-page auth-page--fullscreen"/.test(html))

html = wrap(h(a.AuthGate, { layout: 'inline', labels: { login: { title: 'Hi gardener', submit: 'Let me in' } }, classNames: { card: 'my-card', primary: 'my-btn' }, logo: h('i', { id: 'logo' }) }))
ok('labels override', html.includes('Hi gardener') && html.includes('Let me in') && html.includes('Sign in to continue'))
ok('inline layout is a div, not main', /<div class="auth-page auth-page--inline"/.test(html) && !html.includes('<main'))
ok('classNames merged', html.includes('auth-card my-card') && html.includes('auth-btn auth-btn-primary my-btn'))
ok('logo slot', html.includes('<i id="logo">'))

html = wrap(h(a.AuthGate, { layout: 'modal', onClose() {} }))
ok('modal has dialog role', html.includes('role="dialog"') && html.includes('auth-page--modal'))

html = wrap(h(a.AuthGate, { showGoogle: false }))
ok('showGoogle=false', !html.includes('Continue with Google'))

html = wrap(h(a.AuthGate, { renderForm: { login: (f) => h('p', { id: 'mine' }, `${f.labels.login.submit}|${typeof f.submit}|${f.canSubmit}`) } }))
ok('renderForm replaces form, keeps card', html.includes('<p id="mine">Sign in|function|false</p>') && !html.includes('auth-form') && html.includes('Welcome back'))

html = wrap(h(a.AuthGate, { header: h('h1', { id: 'brand' }, 'BRAND') }))
ok('header slot replaces title block', html.includes('id="brand"') && !html.includes('Welcome back'))

html = wrap(h(a.AuthGate, { initial: 'register', labels: { register: { title: 'Join' }, common: { passwordHint: (n) => `min ${n}!` } } }))
ok('register labels + hint fn', html.includes('Join') && html.includes('min 8!'))

html = wrap(h(a.AuthGate, { initial: 'forgot' }))
ok('forgot screen', html.includes('Reset your password'))

html = wrap(h(a.AuthGate, {}), { loading: true })
ok('loading text', html.includes('Loading…'))
html = wrap(h(a.AuthGate, { layout: 'inline', labels: { common: { loading: 'Un instant…' } } }), { loading: true })
ok('loading inline + label', html.includes('auth-loading--inline') && html.includes('Un instant…'))
html = wrap(h(a.AuthGate, { loadingFallback: h('b', {}, 'spin') }), { loading: true })
ok('loadingFallback', html.includes('<b>spin</b>'))

html = wrap(h(a.AuthGate, {}, h('p', {}, 'SECRET')), { user: { uid: 1 } })
ok('signed in renders children', html.includes('SECRET'))

// hooks without any UI
const L = a.mergeLabels({ validation: { passwordMismatch: 'Nope' } })
ok('mergeLabels keeps other defaults', L.validation.passwordMismatch === 'Nope' && L.validation.passwordTooShort(8).includes('8') && L.login.title === 'Welcome back')
ok('friendlyError override', a.friendlyError({ code: 'auth/user-not-found' }, { 'auth/user-not-found': 'Custom' }) === 'Custom' && a.friendlyError({ code: 'auth/user-not-found' }) === 'Incorrect email or password.')
await server.close()
process.exit(fails ? 1 : 0)
