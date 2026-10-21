import { auth } from './firebase'
import { API_URL } from '../config'

/**
 * fetch() wrapper that attaches the current user's Firebase ID token.
 * Firebase refreshes the token automatically when it is close to expiring.
 *
 *   const data = await authFetch('/things', { method: 'POST', body: JSON.stringify(x) })
 */
export async function authFetch(path, options = {}) {
  const user = auth.currentUser
  if (!user) throw new Error('Not signed in')

  const token = await user.getIdToken()
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers })
  if (!res.ok) {
    let detail = res.statusText
    try {
      detail = (await res.json()).detail || detail
    } catch {
      /* response had no JSON body */
    }
    const err = new Error(detail)
    err.status = res.status
    throw err
  }
  return res.status === 204 ? null : res.json()
}
