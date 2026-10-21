# auth · React (Vite or Create React App) + FastAPI + Firebase

Login, registration, Google sign-in, password reset, and server-side token verification. Integration is **one wrapper component** on the frontend and **one function call** on the backend.

**How it works:** Firebase handles sign-in in the browser and issues an ID token. The React app attaches that token to every API call (`authFetch`), and FastAPI verifies it with the Firebase Admin SDK (`get_current_user`). Your backend never sees passwords.

```
Browser ── email/Google ──▶ Firebase Auth
   │                            │ ID token
   └── Authorization: Bearer ──▶ FastAPI ── verify_id_token ──▶ AuthUser
```

## Plug it into your project

### 1. Copy it in

From the devcommons repo:

```bash
node scripts/cli.mjs add auth react-vite-fastapi-firebase \
    --frontend ../my-app --backend ../my-api --install
```

This copies `src/auth/` into your frontend and `auth_module/` (plus `dev_reset_link.py`) into your backend, adds the empty keys to each `.env`, and installs `firebase` with your package manager (npm, pnpm, yarn or bun, from the lockfile). Re-running it is safe; existing files are skipped. Either flag can be left out if you only need one side.

### 2. Frontend: wrap your app

Fill in the `VITE_FIREBASE_*` values the installer added to your `.env` (`REACT_APP_FIREBASE_*` on Create React App), then:

```jsx
// main.jsx
import { AuthGate } from './auth'

createRoot(document.getElementById('root')).render(
  <AuthGate>
    <App />
  </AuthGate>,
)
```

That is the whole integration. Signed out, visitors see login / register / forgot-password; signed in, they see `<App />`. No router is required or added, and it works with or without react-router in your project.

Inside your app:

```jsx
import { useAuth, SignOutButton, authFetch } from './auth'

const { user } = useAuth()                  // Firebase user: displayName, email, photoURL, uid...
<SignOutButton />                           // or: const { logout } = useAuth()
const items = await authFetch('/items')     // sends the Bearer token, parses JSON, throws on errors
```

Want some pages public (a landing page) and only part of the app private? Put the gate around just the private part, for example `<Route path="/dashboard" element={<AuthGate><Dashboard /></AuthGate>} />`. Nested gates share one login state.

Make sure `/api/*` reaches your backend: copy the `server.proxy` block from the demo's `vite.config.js`, or set `VITE_API_URL=https://your-backend/api` in `.env`. On Create React App the installer adds `"proxy"` to `package.json` instead (and `REACT_APP_API_URL` is the override).

### 3. Backend: one call

Put the Firebase service-account key where `.env` points (`GOOGLE_APPLICATION_CREDENTIALS`), then:

```python
from fastapi import Depends
from auth_module import setup_auth, get_current_user, AuthUser

setup_auth(app, cors_origins=["http://localhost:5173"])   # drop cors_origins if you already configure CORS

@app.get("/api/items")
def items(user: AuthUser = Depends(get_current_user)):    # 401 without a valid token
    return load_items_for(user.uid)
```

`setup_auth` loads the credentials (stopping with a clear error if they are missing), mounts `GET /api/auth/me` and `POST /api/auth/register`, and optionally adds CORS. Run `pip install fastapi "uvicorn[standard]" firebase-admin python-dotenv` in your Python environment if you do not have them.

To save new users in your own database: `setup_auth(app, on_register=save_user)` (sync or async; keep it idempotent, the client may retry).

## One-time Firebase setup (~3 min)

1. [Firebase console](https://console.firebase.google.com) → create/select a project.
2. **Build → Authentication** (click **Get started** if shown) **→ Sign-in method**: enable **Email/Password** and **Google**.
3. **Project settings → General → Your apps → Web app**: register one and copy `apiKey`, `authDomain`, `projectId`, `appId` into the frontend `.env`.
4. **Project settings → Service accounts → Generate new private key**: save it as `serviceAccountKey.json` in your backend folder (git-ignore it; never commit it).
5. **Authentication → Settings → Authorized domains**: add your production domain (`localhost` is already there).
6. **Production only:** **Authentication → Templates → Password reset → pencil icon → Customize action URL** → `https://your-domain.com`. Reset emails then open your own app, where `<AuthGate>` shows its reset-password screen and explains exactly why a link fails. The console often rejects `http://localhost` here ("An error occurred updating action URL"), so in development skip this and use `python dev_reset_link.py you@example.com` from the backend folder: it prints a link straight to your local app, no email involved.

## Try the demo first

```bash
# backend
cd backend
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env            # point GOOGLE_APPLICATION_CREDENTIALS at your key (loaded automatically)
uvicorn main:app --reload       # http://localhost:8000/docs

# frontend (second terminal)
cd frontend
npm install
cp .env.example .env            # fill in the VITE_FIREBASE_* values
npm run dev                     # http://localhost:5173
```

Register an account; the dashboard shows your profile as returned by the backend.

## Reference

| Piece | Where | Notes |
|-------|-------|-------|
| `<AuthGate>` | `src/auth/ui/AuthGate.jsx` | Props: `showGoogle`, `askName`, `syncBackend`, `verifyEmailOnSignUp`, plus the look-and-wording props below |
| `useAuth()` | `core/AuthContext.jsx` | `user, loading, signIn, signUp, signInWithGoogle, resetPassword, logout` |
| `useLoginForm()`, `useRegisterForm()`, `useForgotPasswordForm()`, `useResetPasswordForm()` | `core/forms.js` | All the form state and submit logic, no markup (see Headless) |
| `<SignOutButton>` | `ui/SignOutButton.jsx` | Passes extra props (className...) to the `<button>` |
| `authFetch(path, options)` | `core/api.js` | Adds `Authorization`, parses JSON, throws with the backend's `detail` |
| `<LoginPage>`, `<RegisterPage>`, `<ForgotPasswordPage>`, `<ResetPasswordPage>` | `src/auth/ui/` | Used by the gate; export them to build your own layout (`onNavigate`, `onSuccess` props) |
| `defaultLabels`, `mergeLabels` | `core/labels.js` | Every string on the screens |
| `setup_auth(app, prefix, cors_origins, on_register)` | `setup.py` | The one-call backend setup |
| `get_current_user` | `deps.py` | 401 on missing/invalid/expired token |
| `get_optional_user` | `deps.py` | `None` when logged out; for mixed public/private routes |
| `require_verified_email` | `deps.py` | 403 until the email is verified |

The frontend is two layers: `core/` (state, Firebase, API, form hooks; no markup and no CSS) and `ui/` (the ready-made screens and `auth.css`). Install the default and you get both; install **headless** (`devcommons add auth --option ui=headless`, or pick it when asked) and you get `core/` only.

## Customising

- **Colours**: override the `--auth-*` CSS variables (accent, background, radius...). Dark mode follows your own switch (`[data-theme="dark"]` or `.dark` on `<html>`, `<body>` or any wrapper; `[data-theme="light"]` / `.light` forces light) and otherwise the OS setting.
- **Wording**: `<AuthGate labels={{ login: { title: 'Hi again' }, register: { submit: 'Join' } }}>`. Every string is in `core/labels.js`; pass only what you change. Firebase error texts: `labels={{ errors: { 'auth/user-not-found': '...' } }}`.
- **Your CSS classes**: `classNames={{ card: 'shadow-xl', primary: 'btn btn-dark', input: 'form-control' }}` adds classes to the built-in elements (keys: `page card header title subtitle form field input error success footer link primary secondary divider`).
- **Logo / header**: `logo={<Logo />}` shows above the title; `header={<MyHeader />}` (or a function receiving `{ title, subtitle }`) replaces the title block.
- **Layout**: `layout="fullscreen"` (default), `layout="inline"` (renders inside your own container: no fixed positioning, your page's background and font) or `layout="modal"` (dialog over a backdrop; pass `onClose` for Escape / click-outside).
- **Your own form, their logic**: `<AuthGate renderForm={{ login: (f) => <MyLoginForm {...f} /> }}>`. `f` is the form hook's state (`email`, `setEmail`, `password`, `submit`, `error`, `busy`, `canSubmit`, `signInWithGoogle`, ...) plus `labels` and `navigate`. Keys: `login`, `register`, `forgot`, `reset`; the card, title and links stay.
- **No Google button**: `<AuthGate showGoogle={false}>`.
- **Skip backend sync / verification email**: `<AuthGate syncBackend={false} verifyEmailOnSignUp={false}>`.
- **Revoked-token checks**: `AUTH_CHECK_REVOKED=true` (one extra Firebase call per request).
- **Roles / admin**: set custom claims with the Admin SDK, then read them in `deps.py` (extend `AuthUser`).
- **Which bundler?** The installer picks the `env` option from what it finds (`vite` or `react-scripts`; override with `--option env=cra`). It copies the matching `src/auth/config.js`, the only file that reads environment variables, and names the `.env` keys to match (`VITE_*` or `REACT_APP_*`). The dev-server origin used for CORS defaults to `:3000` on Create React App. Next.js is not covered yet (it needs `NEXT_PUBLIC_*`, `'use client'` and middleware; planned).

## Headless: build the forms yourself

For a project that already has its own design system (MUI, shadcn, Tailwind components), install the headless variant. You wrap the app once with `<AuthProvider>` and write the screens:

```jsx
import { useAuth, useLoginForm } from './auth'

function LoginForm() {
  const f = useLoginForm()                       // { email, setEmail, password, setPassword, submit, canSubmit, busy, error, signInWithGoogle }
  return (
    <form onSubmit={f.submit}>
      <MyInput value={f.email} onChange={(e) => f.setEmail(e.target.value)} />
      <MyInput type="password" value={f.password} onChange={(e) => f.setPassword(e.target.value)} />
      {f.error && <MyAlert>{f.error}</MyAlert>}
      <MyButton disabled={!f.canSubmit}>Sign in</MyButton>
    </form>
  )
}

function Screen() {
  const { user, loading, logout } = useAuth()
  if (loading) return <Spinner />
  return user ? <Dashboard onLogout={logout} /> : <LoginForm />
}
```

`useRegisterForm`, `useForgotPasswordForm` and `useResetPasswordForm` work the same way. The demo shows both styles: `npm run dev`, then open `/?demo=headless` (own components) or `/?demo=inline` (ready-made screens inside an existing header and layout, with labels, classNames, a logo and a custom login form).

## Troubleshooting

- `auth/operation-not-allowed`: the sign-in method is switched off. Firebase console → **Authentication → Sign-in method** → enable **Email/Password** (and **Google** for the Google button).
- `auth/unauthorized-domain`: add the domain under Authentication → Settings → Authorized domains.
- Backend prints `No Firebase credentials found`, or `initialised for project: None`: the service-account key was not picked up. Check `.env` has `GOOGLE_APPLICATION_CREDENTIALS` pointing at the real key file, and start uvicorn from the backend folder (or use an absolute path).
- Backend `401` after a successful login: the project id the backend prints at startup (`Firebase Admin initialised for project: <id>`) must equal `VITE_FIREBASE_PROJECT_ID`. If they match, set `AUTH_DEBUG=true` and read the `detail` in the response (or the uvicorn log): `incorrect 'aud'` means a project mismatch, `Token used too early` means the system clock is behind.
- Reset-password link says expired/invalid: links are single-use and last 1 hour. Request a fresh one and open only the newest email. Some mail scanners (corporate Outlook, antivirus link checkers) open links before you do and use them up; copy the link address from the email instead of clicking. To find out which case you are in, run `python dev_reset_link.py you@example.com` (backend folder) and open the link it prints. If that works, Firebase is fine and the emailed link is being used up first; if it fails, the screen shows Firebase's exact reason.
- Google pop-up blocked: it must be triggered directly by a click (the included button does this).
