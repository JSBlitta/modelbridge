// ── Lightweight fetch wrapper replacing axios ──
// Provides: api.get(url), api.post(url, body), api.patch(url, body)
// Response shape: { data, status, ok }  (mirrors axios res.data / res.status)

let _onUnauthorized = null

/** Register a callback invoked when a 401 SESSION_EXPIRED response is received. */
export function onUnauthorized(fn) {
  _onUnauthorized = fn
}

async function request(method, url, body) {
  const opts = { method }
  if (body !== undefined && method !== 'GET') {
    if (body instanceof FormData) {
      opts.body = body // browser sets Content-Type with boundary automatically
    } else {
      opts.headers = { 'Content-Type': 'application/json' }
      opts.body = JSON.stringify(body)
    }
  }

  // Support query params for GET requests (axios-style: api.get(url, { params: {...} }))
  if (method === 'GET' && body?.params) {
    const params = new URLSearchParams(body.params)
    url = url + (url.includes('?') ? '&' : '?') + params.toString()
  }

  let res
  try {
    res = await fetch(url, opts)
  } catch (e) {
    // network error — throw a normalized error
    const err = new Error(e.message || 'Network error')
    err.response = { status: 0, data: { error: 'Network error' } }
    throw err
  }

  // Try to parse JSON body
  let data = null
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try { data = await res.json() } catch { /* not valid JSON */ }
  }

  if (!res.ok) {
    // Check for session expiry (mirrors the old axios interceptor)
    if (res.status === 401 && data?.code === 'SESSION_EXPIRED' && _onUnauthorized) {
      _onUnauthorized()
    }
    const err = new Error(data?.error || data?.detail || `HTTP ${res.status}`)
    err.response = { status: res.status, data }
    throw err
  }

  return { data, status: res.status, ok: true }
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body),
  patch: (url, body) => request('PATCH', url, body),
}
