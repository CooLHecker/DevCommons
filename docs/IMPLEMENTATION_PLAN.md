# devcommons: implementation plan

**Goal:** run one command in any existing project, answer a few questions, and have a feature (login/register first) working in minutes. Every feature exists in several tech stacks and lives in this one repo.

**Principles**
1. The manifest (`feature.json`) is the contract. New stacks and features should need zero CLI changes.
2. Never surprise the user: detect first, show a dry-run, ask before touching files, never overwrite silently.
3. The drop-in module is self-contained and every feature ships a runnable demo.
4. Zero runtime dependencies in the CLI (Node 18+).

---

## Status

| Phase | What | Status |
|-------|------|--------|
| 0 | Repo layout, manifest, copy-based installer, auth `react-vite-fastapi-firebase` | done |
| 1 | Interactive CLI + project detection | **done (v0.3.0)** |
| 2 | Auto-wiring (patches) + install record + `remove` | **done (v0.5.0)** |
| 3 | Headless core + themable UI (fit any existing frontend) | **mostly done (v0.6.0); TypeScript and Tailwind/shadcn UI variants left** |
| 4 | Framework compatibility (Next.js, CRA, env shim, TypeScript) | **CRA, env shim and package-manager detection done (v0.8.0); Next.js and TypeScript left** |
| 5 | More auth stacks + shared API contract | **contract, conformance script, per-half stack matching and `express-firebase` done (v0.9.0); more variants left** |
| 6 | Safety, `doctor`, secrets hygiene | planned |
| 7 | Tests, CI, releases, `update` | **tests, CI workflow (first GitHub run green), changelog, `update` (v0.7.0) done; npm release to do** |
| 8 | Feature generator + next features | planned |

---

## Phase 1: Interactive CLI + detection (done)

Delivered:
- `devcommons add` with no arguments: detects project, picks feature/stack, confirms folders, dry-run preview, confirm, install.
- `scripts/lib/detect.mjs`: scans cwd + 2 levels, recognises React/Next/CRA/Vue/Svelte/Angular/Vite and FastAPI/Flask/Django/Express/Fastify/Nest/Koa/Hono, TypeScript, Tailwind, Firebase, react-router.
- `feature.json` gains `detect: { frontend: [tags], backend: [tags] }`; variants are ranked by how well they fit.
- `--yes`, `--dry-run`, `devcommons detect`; the old explicit-flags usage still works unchanged.
- `scripts/lib/prompt.mjs`: zero-dependency numbered menus and y/n, works with piped input.

Known limits (handled in later phases): it does not edit your files, it does not fill in env values, and detection stops at two folder levels.

---

## Phase 2: Auto-wiring (patches) (done)

Delivered:
- `scripts/lib/patch.mjs` with three handlers: `wrap-root` (React entry file), `vite-proxy` (adds `/api` proxy, handles missing/one-line/existing `server` and `proxy` blocks and the function form of `defineConfig`), `py-setup-call` (finds the FastAPI app variable, adds import + call after it, skips `cors_origins` if CORS already configured).
- Idempotent (re-run reports "already in place"), conservative (falls back to printed manual steps), CRLF-safe.
- Diff preview before anything is written; originals saved to `.devcommons/backup/`; `.devcommons.json` install record (merged on re-run).
- `prompts` in `feature.json` (backend URL, frontend origin, optional Firebase config) fill `{{vars}}` in patches and the `.env` files; empty `.env` keys get filled.
- Modes: interactive and `--yes` apply edits; explicit-flag runs only copy unless `--patch`; `--no-patch` never edits.
- `devcommons remove [feature]` (v0.5.0): reads `.devcommons.json`, shows a diff for every edit it will undo, lists the files it will delete, asks (default No; `--yes` skips, `--dry-run` previews). Each patch type has a reverse handler that finds its `devcommons:<feature>` marker (wrap-root has none, so it unwraps `<AuthGate>` and removes its sole-specifier import); anything edited since falls back to "by hand". Copied files are deleted only if byte-identical to the catalog copy (`--force` also deletes edited ones); files you added inside the module folder stay; empty folders and `__pycache__` are cleaned up. `.env` values, packages and `.devcommons/backup/` are left alone and listed at the end. The record entry is dropped, and the file goes with the last feature. Round trip add -> remove restores the user's files byte for byte on the fixtures.
- 41 tests (`npm test`): handler unit tests (including apply -> revert round trips), end-to-end CLI runs, and `remove` scenarios.

Moved out of this phase: the clean-working-tree check before editing (Phase 6). Per-file hashes (v0.6.1): the record stores a SHA-256 of every copied file (line endings ignored), and `remove` compares against it, so it stays correct after a catalogue upgrade; files not in the record are kept. Records made before hashes existed (0.6.0 and older) keep the old comparison against the catalogue copy; they are not given a partial set on re-run, and only a fresh install (or remove + add) gets hashes.

Original plan for reference:

The "plugs in automatically" half. Today the CLI prints "wrap your app in `<AuthGate>`"; it should do it.

**Manifest addition** (`feature.json`):
```json
"patches": {
  "frontend": [
    { "type": "wrap-root", "file": ["src/main.jsx", "src/main.tsx", "src/index.js"],
      "import": "import { AuthGate } from './auth'", "wrap": "AuthGate" },
    { "type": "vite-proxy", "path": "/api", "target": "http://localhost:8000" }
  ],
  "backend": [
    { "type": "py-setup-call", "file": ["main.py", "app.py"],
      "import": "from auth_module import setup_auth",
      "call": "setup_auth(app, cors_origins=[\"http://localhost:5173\"])" }
  ]
}
```

**Tasks**
1. `scripts/lib/patch.mjs` with one handler per patch type (`wrap-root`, `vite-proxy`, `py-setup-call`, `append-line`, `json-merge`).
2. Each handler is idempotent: it checks for a marker (`// devcommons:auth`) and does nothing if already applied.
3. Before changing a file: show a unified diff, ask `Apply? [Y/n]`, write a `.devcommons-backup` copy.
4. If the target file does not match what the handler expects (custom entry point, unusual structure), fall back to printing the manual snippet. Never guess.
5. Prompt for the Firebase values (project id, API key, ...) and write them into `.env`; empty if skipped.
6. Write `.devcommons.json` in the project root: `{ features: [{ name, stack, version, files, patches }] }`. This enables `remove` and `update` later.
7. Add `devcommons remove <feature>`: reverse patches (marker-based), delete copied files that are unchanged.

**Done when:** on a fresh Vite+FastAPI fixture, `devcommons add auth --yes` gives a project where signing up works after only filling in Firebase keys; running it twice changes nothing.

**Risk:** AST-free text patches are brittle. Mitigation: markers, conservative matching, always a manual fallback. Consider `jscodeshift`/`ts-morph` only if text patching proves too fragile.

---

## Phase 3: Headless core + themable UI (mostly done, v0.6.0)

The "attach to the existing frontend of another app" half.

Delivered:
- Two layers: `src/auth/core/` (AuthProvider, useAuth, authFetch, errors, firebase, labels, form hooks; no markup, no CSS) and `src/auth/ui/` (screens, `auth.css`). `index.js` exports both; `index.headless.js` (installed as `index.js` for the headless option) exports core only.
- `options` in the manifest (`ui: default | headless`) and `when` conditions on `copy`, `patches` and `postInstall` items. `--option ui=headless`, or asked interactively; the choice is stored in `.devcommons.json`. Headless wraps the root with `<AuthProvider>` instead of `<AuthGate>`. `remove` understands both.
- `useLoginForm`, `useRegisterForm`, `useForgotPasswordForm`, `useResetPasswordForm`: all the form logic; the screens are built on them.
- Every screen and `<AuthGate>` accept `labels` (every string; nested per screen, functions for templates), `classNames` (extra classes per element), `logo` / `header` slots, `layout` (`fullscreen` | `inline` | `modal` with `onClose`), `loadingFallback`, and `renderForm` (per screen on the gate: `{ login, register, forgot, reset }`).
- Theming: `--auth-*` variables as before; dark mode now follows `[data-theme="dark"]` / `.dark` on any ancestor, `[data-theme="light"]` / `.light` forces light, otherwise the OS setting.
- SSR safe: no `window` access during render (needed for Next.js in Phase 4).
- Demo: `/?demo=headless` (own components + hooks) and `/?demo=inline` (screens inside an existing header, with labels, classNames, logo, custom login form).

Verified: demo builds with vite; headless build has no `ui/` and emits no CSS; installer output for both options builds in a fresh Vite project; 18 server-render checks of the props above (kept as a script, not yet in CI). Not verified: real browser behaviour (modal focus handling, visual result of inline/dark themes) and a real Tailwind/MUI/shadcn host project.

Left in this phase:
1. Optional UI variants per design system (`ui-tailwind`, `ui-shadcn`), chosen by detection (`tailwind` is already detected). The `ui` option is where they plug in.
2. TypeScript: ship `.tsx` when the host has `typescript`, `.jsx` otherwise (generate JS from TS at build time).
3. Modal accessibility (focus trap, return focus) if the modal layout stays.
4. Move the server-render checks into `npm test` or CI (needs the demo's dependencies installed).
5. `remove` for installs made before the split lists the files instead of deleting them (their record has no `options`).

**Done when:** the same auth core runs inside (a) the demo, (b) a Tailwind app with its own form components, (c) an app with an existing header where the login form renders inline. (a) and (c) are demonstrated; (b) is demonstrated with stand-in components, not an actual Tailwind project.

## Phase 4: Framework compatibility (CRA, env shim, package managers done; Next.js left)

Delivered (v0.8.0):
- `env` option (`vite` | `cra`), chosen by detection (`fromTags`), overridable with `--option env=...`. `src/auth/config.js` is the only file that reads env vars; the installer copies the Vite or the CRA version and renames the `.env` keys and the postInstall text (`envPrefix` in the manifest).
- `cra-proxy` patch (`"proxy"` in `package.json`; refuses when a proxy or `src/setupProxy.js` exists; revert only for a `package.json` listed in the install record). CORS origin default `http://localhost:3000` on CRA.
- `detect` any-of groups, so one variant covers Vite and CRA. The stack keeps its old name (`react-vite-fastapi-firebase`) so existing records keep working.
- Package managers: npm/pnpm/yarn/bun from the lockfile (searched up to the folder where the command runs) or `packageManager`; Python: poetry/uv/pipenv/pip. Used in the printed install lines, `--install`, and `remove`/`update` notes.
- Monorepo detection: `apps/*` and `packages/*` are found by the existing two-level scan (tests exist); the lockfile lookup now goes up to the repo root.
- 0.7.0 records (no `env` option) are read as `vite`.

Not verified: a real Create React App project (the tests use fixtures and check the files and edits, not `react-scripts build`), Windows/macOS for the new tests.

Left:
1. Next.js (App Router) variant: `NEXT_PUBLIC_*` config, `'use client'` components, middleware route protection, cookie/session option. Needs its own `feature.json` (the wrap-root patch does not apply: it wraps `app/layout.tsx`).
2. TypeScript hosts (see Phase 3).
3. Vue and Svelte stay out of scope until the React variants are solid.

## Phase 5: More stacks + a shared API contract

**Key decision:** define the auth HTTP contract once (`contracts/auth.openapi.yaml`): `GET /auth/me`, `POST /auth/register`, token in `Authorization: Bearer`. Any frontend variant can then talk to any backend variant that implements it, so the matrix is additive (N frontends + M backends) instead of multiplicative (N x M).

**Done (v0.9.0):** `contracts/auth/` (README + `conformance.mjs`), `express-firebase` (backend only), and per-half matching in the CLI: each half of the project gets the stack that fits it, so stacks stay in separate modules and talk only through the contract. Real-Express conformance is a CI job (`express-conformance`), not yet run.

**Variants, in order**
1. `react-vite-fastapi-firebase` (done) and `express-firebase` (done, backend)
2. `nextjs-node-supabase`
3. `react-vite-express-jwt-postgres` (self-hosted, no third-party auth)
4. `flutter-fastapi-firebase` (matches your Flutter projects)
5. `vue-vite-fastapi-firebase`

**Conformance test:** a script that starts a backend variant and runs the contract checks against it; every new backend must pass before it is listed as `ready`.

Folder layout: `features/<feature>/<stack>/`; a variant covers one half or both. The CLI picks a stack per half. Next backends (same contract): Fastify/Koa/Nest, then a self-hosted JWT one. Open: split the React half out of `react-vite-fastapi-firebase` into its own frontend-only variant (kept as one for now so existing records keep working) and rename it.

---

## Phase 6: Safety and `doctor`

**Tasks**
1. After adding env keys or service-account paths, check the project's `.gitignore` and offer to add `.env` and key files.
2. `devcommons doctor`: reads `.devcommons.json`, verifies files exist, env keys are filled, dependencies are installed, the proxy/CORS is set, and the backend answers `GET /api/auth/me` with 401 (alive and verifying tokens).
3. Refuse to run if the working tree has uncommitted changes in files it would patch, unless `--force` (so the user can always `git diff` the result). Offer `git stash` or continue.
4. Never log secrets; never write real keys to files.

---

## Phase 7: Tests, CI, releases (tests, CI, changelog and `update` done)

Delivered:
- `devcommons update [feature]` (v0.7.0): per file, compares the hash recorded at install, the file on disk and the catalogue copy. Untouched and changed upstream: replaced (diff shown first). Edited here, unchanged upstream: kept. Edited here and changed upstream: conflict, kept (`--force` overwrites after saving yours in `.devcommons/backup/update/`). Deleted by you: not brought back. New upstream: added. Dropped upstream: deleted unless you edited it. Same change as upstream: adopted. Missing `.env` keys are added; version, `updatedAt` and hashes are refreshed. Not done: re-applying new patches (the output says to re-run `add`), a real merge for conflicts (you get a diff and a backup, not conflict markers), and records from 0.6.0 or older (refused: remove, then add).
- `npm test` (`node:test`, no dependencies, no network): 100 tests. Patch handlers (apply, idempotent, fall back, revert round trips), end-to-end CLI runs against a Vite + FastAPI fixture (add, `--yes`, `--dry-run`, `--no-patch`, options, interactive questions via piped input, remove, legacy records). Includes 29 detection tests on fixture folders (empty, monorepo, two frontends, depth limit, each framework tag, `fitSide`). Also passes on Node 18 (checked locally with the CLI itself running under 18).
- `npm run test:build` (`test/build-installed.mjs`, needs network): installs the feature into a fresh Vite project with the real CLI (`--install` included) for each `ui` option, runs the real `vite build`, and asserts the bundle has CSS only for the default UI.
- `.github/workflows/ci.yml`: (1) `test` on ubuntu/windows/macos x Node 18/20/22; (2) `installed-build` for `ui=default` and `ui=headless`; (3) `demo`: demo frontend build, the server-render checks (`npm run check`), `pip install -r requirements.txt` and `import auth_module`.
- `.gitattributes` keeps LF line endings so Windows checkouts do not change the catalogue files; test helper uses `fileURLToPath` (the old `URL.pathname` breaks on Windows).
- `CHANGELOG.md`.

The workflow has run on GitHub and shows a green tick (reported by the owner, Oct 2026). Local runs were Linux, Node 18 and 22 only. Still missing from the original list: a backend contract/conformance test (Phase 5). Known detection limit pinned by a test: any folder with a Python manifest (even `docs/`) is a backend candidate; it ranks after a real backend but would be offered if it is the only one.

Still to do:
1. Release (needs the owner's GitHub and npm accounts): push to GitHub; check `npx github:<user>/devcommons add --dry-run` from another project; add a `LICENSE` and `license`/`repository` fields to `package.json` (not chosen yet); `npm publish --dry-run`, `npm publish` (the name `devcommons` was free on 2026-10-20), tag `v0.7.0`. `package.json` already has a `files` whitelist (scripts, features, README, CHANGELOG: 45 files, 51 kB), so tests, CI config and docs are not published.
2. Semver per feature variant in `feature.json` is in place (auth is 0.4.0); the changelog should name the variant version when it changes.

## Phase 8: Generator + next features

1. `devcommons new-feature <feature> <stack>`: scaffolds the folder, a `feature.json` template, README skeleton, and demo, so adding a variant takes minutes.
2. Feature backlog (reusable in most of your projects): file upload, role-based access, payments, notifications/email, invoice/PDF generation, rate limiting, audit log.
3. Each new feature follows the same checklist: module + demo + manifest (with `detect` and `patches`) + README + conformance/demo test.

---

## Manifest reference (target shape)

```json
{
  "feature": "auth",
  "stack": "react-vite-fastapi-firebase",
  "version": "0.3.0",
  "description": "...",
  "detect":      { "frontend": ["react", "vite"], "backend": ["fastapi"] },
  "options":     [ { "key": "ui", "ask": "...", "default": "default", "choices": [ { "value": "default", "label": "...", "hint": "..." } ] } ],
  "copy":        [ { "from": "...", "to": "<frontend>/src/auth/core", "when": { "ui": "default" } } ],
  "dependencies":{ "frontend": ["firebase"], "backend": ["fastapi"] },
  "envDefaults": { "frontend": { "VITE_...": "" }, "backend": { } },
  "prompts":     [ { "key": "firebaseProjectId", "ask": "Firebase project ID", "env": "VITE_FIREBASE_PROJECT_ID" } ],
  "patches":     { "frontend": [ ], "backend": [ ] },
  "postInstall": { "frontend": [ ], "backend": [ ] }
}
```
`detect`, `copy`, `dependencies`, `envDefaults`, `postInstall`, `prompts`, `patches`, `options` and `when` all exist today.

---

## Suggested order and effort

| Phase | Rough effort | Why this order |
|-------|--------------|----------------|
| 2 | 2-3 sessions | Biggest jump toward "plugs in automatically" |
| 3 | 3-4 sessions | Makes it usable in apps that are not yours |
| 7 (tests part) | 1 session, start alongside 2 | Patches are brittle; fixtures catch regressions |
| 4 | 2 sessions | Unlocks Next.js and CRA projects |
| 5 | 1-2 sessions per variant | Grows the library once the machinery is solid |
| 6, 8 | 1-2 sessions each | Polish and scale |
