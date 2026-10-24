# Devcommons

Reusable, drop-in features for the projects and websites you build. Each feature lives in its own folder, and each feature can have several **stack variants** (frontend + backend + service combinations), so you can pick whichever fits the project in front of you.

## Plug a feature into a project

```bash
# interactive: run it in your project's root, it detects your stack and asks only what it must
cd my-project
npx github:<your-username>/devcommons add

# from a clone of this repo
node /path/to/devcommons/scripts/cli.mjs add
```

It looks at the current folder (and two levels down) and recognises the frontend (React, Next.js, Vue, Vite, ...) and the backend (FastAPI, Flask, Django, Express, ...). Then it:

1. picks the feature and the stack variant that fits what it found (warns if none does),
2. confirms the frontend and backend folders (or lets you choose / skip one),
3. asks the few things only you know (backend URL, Firebase config; skippable),
4. shows a dry-run of everything it will do, including a **diff of every edit to your own files**, and asks before touching anything.

It copies the feature's folders in, writes your answers into the `.env` files, optionally runs `npm install`, and **wires the feature in for you**: it wraps your root component in `<AuthGate>`, adds the `/api` proxy to `vite.config`, and adds `setup_auth(app)` to your FastAPI app (or `setupAuth(app)` to your Express app). The edits are small and conservative: if a file does not look the way the patch expects (unusual entry file, several root components, ...) it leaves it alone and prints the lines to add by hand. Re-running is safe: edits that are already in place are detected and skipped. Originals of every edited file are saved in `.devcommons/backup/`, and `.devcommons.json` records what was installed. It never overwrites existing files unless you say so. `devcommons remove` reverses all of it (edits first, with a diff; then the copied files, keeping any you changed) and leaves `.env`, packages and the backups alone. `devcommons update` compares three versions of every copied file (as installed, as it is now, as the catalogue has it): files you never touched are replaced, files you edited are kept (a file you edited that the new version also changed is reported as a conflict; `--force` takes the new one and saves yours in `.devcommons/backup/update/`), files you deleted stay deleted, new files are added. It does not change the edits it made to your own files.

Skip the questions with flags:

```bash
devcommons add auth react-vite-fastapi-firebase --frontend ./web --backend ./api --install   # fully explicit
devcommons add --yes                  # use detected folders and the best-fitting stack (and apply the edits)
devcommons add --no-patch             # copy files only, print the edits to make by hand
devcommons add auth --option ui=headless   # hooks only, you build the forms
devcommons remove auth               # undo it: reverts the edits, deletes the copied files you did not change
devcommons remove auth --dry-run     # preview only
devcommons update                    # bring an installed feature up to this catalogue's version, keeping your edits
devcommons update --dry-run          # preview: shows a diff for every file it would replace
devcommons add auth <stack> --frontend ./web --backend ./api --patch   # explicit folders + apply edits
devcommons add --dry-run              # show the plan, change nothing
devcommons doctor                     # is what I installed still healthy? (files, env, packages, running backend, secrets)
devcommons detect                     # what devcommons sees here, and which stacks fit
devcommons list                       # everything available
```

### Check on it later: `doctor`

```bash
devcommons doctor                      # every installed feature, each problem with its fix
devcommons doctor --url http://localhost:4000   # backend somewhere else (default: the dev proxy target / detected port)
devcommons doctor --offline            # no network, no Python
devcommons doctor --fix                # add missing .env / key entries to .gitignore (nothing else)
devcommons doctor --json               # for CI; exit code 1 when a check fails
```

It checks that the installed files and the edits to your own files are still there, that the `.env` settings are filled in (it prints names, never values), that the service-account key is a real key for the same project as your frontend, that packages are installed, that the dev proxy points at the backend, and, if the backend is running, that `GET /api/auth/me` answers 401, a bad token is rejected, CORS allows your frontend and the dev server really forwards `/api`. It also fails if a key or `.env` is not ignored by git or is already committed. A backend that is not running is a warning, not a failure.

### Safety

- `add` puts `.env` and the key file in `.gitignore` (shown as a diff first, like every edit).
- `add` and `remove` stop if a file they would edit has uncommitted changes, so `git diff` always shows exactly what they did. Interactive mode offers cancel / stash / continue; `--allow-dirty` skips the check.
- devcommons never writes a private key or service-account JSON into a file, and never prints one.

Needs Node 18+ (works on Windows, macOS, Linux). No dependencies.

## Layout

```
devcommons/
├── features/
│   └── auth/                                  # feature
│       └── react-vite-fastapi-firebase/       # stack variant
│           ├── feature.json                   # manifest: what to copy, what it fits (detect), packages, env keys, next steps
│           ├── README.md                      # setup + integration guide
│           ├── frontend/                      # runnable demo app
│           │   └── src/auth/                  # <- the drop-in module
│           └── backend/                       # runnable demo app
│               └── auth_module/               # <- the drop-in module
└── scripts/
    ├── cli.mjs                                # the installer (reads feature.json)
    └── lib/                                   # detect.mjs (project detection), prompt.mjs (questions), patch.mjs (edits to your files, and their reverses)
└── test/                                      # node --test: patch handlers, detection, add/remove/update end-to-end CLI runs  (npm test); build-installed.mjs: slow real-build check (npm run test:build)
```

## Conventions (every feature follows these)

1. **One folder per stack variant**: `features/<feature>/<stack>/`. A variant may cover both halves (`react-vite-fastapi-firebase`) or just one (`express-firebase` is backend only). The installer matches each half of your project to the stack that fits it, so Express code is never mixed into a FastAPI module or the other way round; the halves talk through `contracts/<feature>/`.
2. **The drop-in module is self-contained**: one folder for the frontend (`src/<feature>/`) and one for the backend (`<feature>_module/`). Integration is one wrapper component on the frontend and one function call on the backend.
3. **A runnable demo wraps every module**, so you can try the feature in isolation before integrating it.
4. **`feature.json` is the contract the installer reads**: files to copy, the `detect` tags the variant fits (e.g. `react`, `vite`, `fastapi`), the `prompts` to ask, the `patches` to apply to the user's files, packages, env keys, and the "next steps" text. A new variant needs no installer changes.
5. **Every variant has a README** with setup, integration, customisation and troubleshooting.

## Features

| Feature | Variant | Status |
|---------|---------|--------|
| auth (login, register, Google, password reset, token-verifying backend) | `react-vite-fastapi-firebase` (React on Vite or CRA + FastAPI) | ready |
| auth, backend half for Express (Node) | `express-firebase` (contract: `contracts/auth`) | ready (real-Express check runs in CI) |

## Planned

- auth: more variants (Next.js + Node + Supabase, Flutter + FastAPI + Firebase, ...)
- Next candidates: file upload, payments, notifications, role-based access, invoice/PDF generation

See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the roadmap.
