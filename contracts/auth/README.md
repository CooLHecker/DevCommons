# auth contract

The HTTP surface every **auth backend** variant implements and every **auth frontend** relies on.
A frontend and a backend written in different stacks work together as long as both follow this page,
so adding a stack means adding one module, not one per combination.

Backends today: `react-vite-fastapi-firebase` (its `backend/`), `express-firebase`.
Frontends today: `react-vite-fastapi-firebase` (its `frontend/`).

## Requests

Prefix: `/api` (configurable on the backend). The token is a Firebase ID token.

| Method | Path | Auth | Success |
|--------|------|------|---------|
| GET | `{prefix}/auth/me` | `Authorization: Bearer <token>` | `200` + the user |
| POST | `{prefix}/auth/register` | `Authorization: Bearer <token>` | `200` + the user (runs the backend's `on_register` hook; must be safe to repeat) |

## The user

JSON object with exactly these keys (`null` when unknown):

```json
{ "uid": "string", "email": "string|null", "email_verified": false, "name": "string|null", "picture": "string|null", "provider": "string|null" }
```

`provider` is Firebase's `sign_in_provider` (`password`, `google.com`, ...).

## Errors

Always JSON `{ "detail": "<message>" }`; the frontend shows `detail`.

| Case | Status | `detail` | Header |
|------|--------|----------|--------|
| no header, wrong scheme, empty token | 401 | `Missing bearer token` | `WWW-Authenticate: Bearer` |
| token expired | 401 | `Token expired` | `WWW-Authenticate: Bearer` |
| token revoked (only when revocation checks are on) | 401 | `Token revoked` | `WWW-Authenticate: Bearer` |
| any other bad token | 401 | `Invalid token` (with the reason appended in debug mode) | `WWW-Authenticate: Bearer` |
| route needs a verified email and it is not | 403 | `Email not verified` | |

## Checking a backend

```
node contracts/auth/conformance.mjs http://localhost:8000                 # needs no credentials
node contracts/auth/conformance.mjs http://localhost:8000 --token <idToken>   # also checks a real login
```

A backend is listed as `ready` only when this passes. The script uses nothing but Node 18's `fetch`.
