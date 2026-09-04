// ── Lightweight fetch wrapper replacing axios ──
// Provides: api.get(url), api.post(url, body), api.patch(url, body)
// Response shape: { data, status, ok }  (mirrors axios res.data / res.status)

let _onUnauthorized = null
let _onError = null

/** Register a callback invoked when a 401 SESSION_EXPIRED response is received. */
export function onUnauthorized(fn) {
  _onUnauthorized = fn
}

/** Register a callback for all non-401 API errors. Receives { message, status, url }. */
export function onApiError(fn) {
  _onError = fn
}

async function request(method, url, body) {
  const opts = { method }
  if (body !== undefined && method !== 'GET') {
    if (body instanceof FormData) {
      opts.body = body
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
    const err = new Error(e.message || 'Network error')
    err.response = { status: 0, data: { error: 'Network error' } }
    if (_onError) _onError({ message: 'Network error', status: 0, url })
    throw err
  }

  // Try to parse JSON body
  let data = null
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try { data = await res.json() } catch { /* not valid JSON */ }
  }

  if (!res.ok) {
    // Check for session expiry
    if (res.status === 401 && data?.code === 'SESSION_EXPIRED' && _onUnauthorized) {
      _onUnauthorized()
    }
    if (_onError && res.status !== 401) {
      _onError({ message: data?.error || data?.detail || `HTTP ${res.status}`, status: res.status, url })
    }
    const err = new Error(data?.error || data?.detail || `HTTP ${res.status}`)
    err.response = { status: res.status, data }
    throw err
  }

  return { data, status: res.status, ok: true }
}

export const api = {
  get: (url, opts) => request('GET', url, opts),
  post: (url, body) => request('POST', url, body),
  patch: (url, body) => request('PATCH', url, body),
  put: (url, body) => request('PUT', url, body),
  delete: (url) => request('DELETE', url),
}
