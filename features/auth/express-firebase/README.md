# auth · Express (Node) + Firebase (backend only)

The backend half of auth for an Express API. It verifies Firebase ID tokens and serves the
[auth contract](../../../contracts/auth/README.md), so it works with any frontend that follows the
contract, for example the React one in `react-vite-fastapi-firebase` (frontend side only).

## Add it to your project

```
cd my-project
npx devcommons add auth                  # detects Express and asks what it needs
# or, no questions:
devcommons add auth express-firebase --backend ./api --patch
```

This copies `auth_module/` into your backend, adds `GOOGLE_APPLICATION_CREDENTIALS` to its `.env`,
installs `firebase-admin` and `dotenv` with your package manager, and adds two lines to the file that
creates your app (the import and `setupAuth(app, ...)`). Re-running it is safe.

By hand, right after `const app = express()`:

```js
const { setupAuth, requireAuth } = require('./auth_module')   // or: import { setupAuth, requireAuth } from './auth_module/index.js'
setupAuth(app, { corsOrigins: ['http://localhost:5173'] })    // drop corsOrigins if you already use the cors package

app.get('/api/things', requireAuth, (req, res) => res.json({ uid: req.user.uid }))
```

CommonJS and ES-module projects both work: `auth_module/package.json` pins that folder to CommonJS, so
the same files load either way. TypeScript projects need `allowJs` (or a `declare module`) to import it.

## What you get

| | |
|---|---|
| `setupAuth(app, opts)` | loads the credentials (throws at startup with a clear message if they are missing), mounts `GET {prefix}/auth/me` and `POST {prefix}/auth/register`, optional CORS |
| `requireAuth` | middleware: 401 without a valid token, otherwise sets `req.user` |
| `optionalAuth` | sets `req.user` when a valid token is present, carries on anonymous otherwise |
| `requireVerifiedEmail` | use after `requireAuth`: 403 unless the email is verified |

`req.user` is `{ uid, email, email_verified, name, picture, provider }`, the same shape as the FastAPI variant.

Options of `setupAuth`: `prefix` (default `/api`), `corsOrigins`, `onRegister(user)` (sync or async, make it
idempotent: it runs on every `POST /auth/register`), `verifyToken(token) -> claims` (replaces Firebase
verification: tests, another identity provider).

## Credentials

One of, in this order: `FIREBASE_CREDENTIALS_JSON` (the key as a string), `GOOGLE_APPLICATION_CREDENTIALS` (path
to the key file), or `FIREBASE_PROJECT_ID` with Application Default Credentials. A `.env` in the folder you
start node from is loaded. The project id printed at startup must equal the one in the frontend's Firebase config.

`AUTH_DEBUG=true` puts the real rejection reason in 401 responses (development only). `AUTH_CHECK_REVOKED=true`
also rejects revoked tokens (one extra network call per request).

## Check it

```
node server.js                                                     # the demo, in this folder (npm install first)
node ../../../contracts/auth/conformance.mjs http://localhost:8000
```

## Not covered yet

Fastify, Koa, Nest and Hono backends (a variant each, same contract). TypeScript sources.
