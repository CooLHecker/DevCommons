# Changelog

CLI versions (`package.json`). Feature variants have their own version in `feature.json`; it is named where it changes.

## 0.10.0 (unreleased)
- **`devcommons doctor [feature] [stack]`**: checks every installed feature against `.devcommons.json` and prints what is wrong with the fix next to it. Exit code 1 when anything fails; `--json` for CI. Six groups of checks, all driven by the manifest so new stacks need no CLI change:
  - *Files*: every installed file is still there (edited ones are fine and counted); the record's version against the catalogue.
  - *Edits to your files*: re-runs the patch detection read-only: the wrap, the setup call. Wired by hand somewhere else is accepted. The fix printed is the exact `devcommons add ... --patch` command.
  - *Environment*: every `.env` setting has a value (names only, never values; `.env.local` and friends count for the frontend, the real environment counts for both); the service-account key exists and is a real service-account key (or `FIREBASE_CREDENTIALS_JSON` / platform credentials); the frontend's project id equals the key's project id (a mismatch rejects every token).
  - *Packages*: frontend and Node backend packages are declared and installed (walks up for hoisted `node_modules`; Yarn PnP is skipped); Python packages are declared in requirements/pyproject and importable by the project's virtualenv (a different Python on your PATH is only a warning).
  - *Connection*: the `/api` proxy (or the direct API URL) is set and points at the port the backend really listens on; with the backend running: `GET /api/auth/me` answers 401 `Missing bearer token`, a bad token gets 401 `Invalid token` (verification runs), CORS allows the frontend origin (a failure only when the browser calls the backend directly), and the dev server actually forwards `/api` (catches Vite answering with its index page). A backend that is not running is a warning. `--url`, `--origin`, `--prefix`, `--offline`.
  - *Safety*: `.env` files and the key file are ignored by git, none of them (nor any `*-firebase-adminsdk-*.json`) is committed; a private key in a frontend variable (which ships to the browser) fails. `doctor --fix` adds the missing `.gitignore` lines and changes nothing else.
- **`add` keeps secrets out of git**: after writing `.env` keys it checks the project's ignore rules (`git check-ignore` when git is there, a built-in `.gitignore` reader when not) and adds `.env` and the key file's path to `.gitignore` as one more previewed, backed-up edit (copy-only runs print the lines instead). `remove` leaves them. The "add .env to .gitignore" next step is gone.
- **No clobbering uncommitted work**: `add` and `remove` stop before writing anything when a file they would edit has uncommitted changes (modified, staged or not tracked yet), listing the files. Interactive: Cancel / Stash them first (`git stash push` for just those files) / Continue anyway. `--allow-dirty` (or `--force`) goes ahead; `--dry-run` only prints a note; outside a git repo nothing is checked. Files not being edited do not matter, and copy-only runs never edit so never stop.
- **Never log or write secrets**: a private key or service-account JSON pasted into a prompt is refused (not written, not echoed back), `appendEnv` refuses such values as a second line of defence, and doctor's messages are fixed text (a JSON parse error can quote the file) and run through a redactor.
- Manifest: `secrets.files` (the key file: env names, label, help, `projectIdPrompt`) and `doctor` (`probe`, `apiUrlEnv`) in both auth variants. `DEVCOMMONS_NO_GIT=1` behaves as if git is not installed.
- Internals: `scripts/lib/safety.mjs` (git helpers, `.gitignore` matcher and planner, secret guard), `scripts/lib/envfile.mjs`, `scripts/lib/doctor.mjs`. `applyPatches` no longer writes a backup for a file that did not exist.
- Tests: 45 new (192 total): `safety.test.mjs`, `safety-cli.test.mjs`, `doctor.test.mjs` (fake backends cover the live checks). Checked by hand against a real FastAPI + firebase-admin backend. Not run: Windows and macOS (path handling in the git helpers), the Express live check against real Express, a real Vite dev server for the proxy check.

## 0.9.0 (unreleased)
- Fix: `add` copied nothing when devcommons ran from `npx` (its own path contains `node_modules`, which the copy filter matched); the filter now checks the path inside the feature folder, and `add` stops before editing your files if a copied folder is missing or empty.
- New variant `auth/express-firebase` 0.1.0 (backend only): `auth_module/` for Express with `setupAuth(app)`, `requireAuth`, `optionalAuth`, `requireVerifiedEmail`, an `onRegister` hook and a built-in CORS option. It imports nothing from Express, works from CommonJS and ES-module projects (the folder carries its own `package.json` with `"type": "commonjs"`), and loads `firebase-admin` only when it verifies a real token.
- `contracts/auth/`: the HTTP contract (routes, user shape, 401/403 answers) and `conformance.mjs`, a dependency-free checker that any backend can be pointed at.
- Stacks no longer get mixed: a half of a stack that does not match what was detected is left out (the React half of `react-vite-fastapi-firebase` goes into `web/`, never its FastAPI half into an Express folder). After installing, devcommons finds the stack that fits the other half of your project and installs it too (asks first when interactive; with `--yes` and a named stack it prints the command instead).
- New patch type `js-setup-call` (Express): finds `const app = express()`, adds the require/import in the file's own style (CommonJS or ESM, quotes, semicolons) and `setupAuth(app, ...)`; uses `setupAuth(app)` when the `cors` package is already used; `remove` takes both lines back out.
- Detection: Node backends report their entry file and port; Python entries report a literal `port=`. The frontend proxy URL and the CORS origin now default from what was found (backend port, frontend bundler).
- Backend packages for a Node backend install with that folder's package manager (`--install` included); `remove` prints the matching uninstall command.
- Manifest: prompts can use `defaultByTag` and `defaultFromPort`.
- Tests: 46 new (146 total). New CI job `express-conformance` installs the variant into a fresh project on real Express and runs the contract checks; it has not been run yet.

## 0.8.0 (unreleased)
- Create React App support. auth `react-vite-fastapi-firebase` 0.5.0 gains an `env` option (`vite` | `cra`) that is decided by detection (`react-scripts` -> `cra`; `--option env=cra` overrides). The one file that reads environment variables is now `src/auth/config.js` (Vite: `import.meta.env.VITE_*`; CRA: `process.env.REACT_APP_*`); `core/api.js` and `core/firebase.js` import from it. The installer names the `.env` keys (`VITE_` -> `REACT_APP_`) and the postInstall text to match, defaults the CORS origin to `http://localhost:3000` on CRA, and a new `cra-proxy` patch adds `"proxy"` to `package.json` (it refuses if a `proxy` or `src/setupProxy.js` is already there; `remove` only touches a `package.json` the install record lists). The stack name is unchanged so existing records keep working.
- Manifest: `detect` accepts any-of groups (`["react", ["vite", "cra"]]`), options can carry `fromTags` (decided by detection instead of a question), `envPrefix` renames env keys by option, prompts can carry `defaultBy`.
- Package managers: the frontend install line (and `--install`) uses `pnpm add` / `yarn add` / `bun add` / `npm install` according to the lockfile or `packageManager` field (looked for from the frontend folder up to where you ran the command); the backend line uses `poetry add` / `uv add` / `pipenv install` / `pip install`. `remove` and `update` print the matching commands.
- Records from 0.7.0 have no `env` option; `remove` and `update` fill it with `vite`, so they keep working. After `update`, `src/auth/config.js` is added and `core/api.js` / `core/firebase.js` are replaced (if you did not edit them).
- 15 tests in `test/cra.test.mjs`. Not run in CI yet: a real Create React App build of the installed output (`test:build` only covers Vite).

## 0.7.0 (unreleased)
- `devcommons update [feature]` (`--dry-run`, `--yes`, `--force`): three-way, per file, using the install-time hashes. Untouched files are replaced (with a diff first), your edits are kept, a file you edited that upstream also changed is a conflict (kept; `--force` overwrites after saving yours in `.devcommons/backup/update/`), files you deleted are not brought back, new files are added, files the catalogue dropped are deleted unless you edited them, a file you already changed to match upstream is adopted. Missing `.env` keys are added. The record's version, `updatedAt` and hashes follow, so `remove` keeps working. Records without hashes (0.6.0 and older) are refused with "remove, then add". Edits to your own files (patches) are not re-applied; the output says to re-run `add`.
- `remove` and `update` share one record-reading/picking helper.
- 14 tests in `test/update.test.mjs`.

## 0.6.1 (unreleased)
- CI workflow (test matrix on Ubuntu/Windows/macOS x Node 18/20/22, installed-build check for both UI options, demo build + server-render checks + backend import).
- `npm run test:build`: installs into a fresh Vite project with the real CLI and builds it.
- `.gitattributes` (LF), Windows-safe path in the test helper.
- `test/detect.test.mjs`: 29 detection tests on fixture folders (empty, monorepo, two frontends, depth limit, every framework tag, `fitSide`).
- `.devcommons.json` now records a SHA-256 per copied file (`hashes`, line endings ignored). `remove` judges "did you edit it?" against that instead of the current catalogue copy, so it stays correct after a catalogue upgrade; files not in the record are kept as "not part of devcommons". Records without `hashes` (0.6.0 and older) keep the old comparison and are not given a partial set on re-run. 9 tests in `test/hashes.test.mjs`.
- Fix: a Python folder with no known framework is labelled "Python" instead of "Python (Python)".

## 0.6.0
- Manifest `options` (`--option ui=headless`, or asked interactively) and `when` conditions on `copy`, `patches` and `postInstall`.
- auth `react-vite-fastapi-firebase` 0.4.0: split into `core/` (state, hooks, no markup) and `ui/`; `labels`, `classNames`, `logo`/`header` slots, `layout` (fullscreen | inline | modal), `renderForm`, `loadingFallback`; dark mode follows `[data-theme]` / `.dark`; no `window` access during render; headless variant (`AuthProvider` + form hooks); demo pages `?demo=headless` and `?demo=inline`.
- Installs made with 0.4/0.5 have the old flat layout: `remove` reverts the edits but lists the files to delete by hand.

## 0.5.0
- `devcommons remove [feature]`: reverts the edits (with a diff), deletes copied files you did not change, keeps `.env`, packages and backups. `--dry-run`, `--yes`, `--force`.
- Markers are per feature (`devcommons:<feature>`).

## 0.4.0
- Auto-wiring: `wrap-root`, `vite-proxy`, `py-setup-call` patches; diff preview, backups in `.devcommons/backup/`, `.devcommons.json` install record, Firebase/backend prompts written to `.env`.

## 0.3.0
- Interactive `devcommons add` with project detection; `devcommons detect`; `--yes`, `--dry-run`.
