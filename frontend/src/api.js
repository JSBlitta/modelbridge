// ── Lightweight fetch wrapper replacing axios ──
// Provides: api.get(url), api.post(url, body), api.patch(url, body)
// Response shape: { data, status, ok }  (mirrors axios res.data / res.status)

const _unauthorizedHandlers = new Set()
const _errorHandlers = new Set()

/** Register a callback invoked when a 401 SESSION_EXPIRED response is received. */
export function onUnauthorized(fn) {
  _unauthorizedHandlers.add(fn)
  return () => _unauthorizedHandlers.delete(fn)
}

/** Register a callback for all non-401 API errors. Receives { message, status, url }. */
export function onApiError(fn) {
  _errorHandlers.add(fn)
  return () => _errorHandlers.delete(fn)
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
    for (const fn of _errorHandlers) fn({ message: 'Network error', status: 0, url })
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
    if (res.status === 401 && data?.code === 'SESSION_EXPIRED') {
      for (const fn of _unauthorizedHandlers) fn()
    }
    if (res.status !== 401) {
      for (const fn of _errorHandlers) fn({ message: data?.error || data?.detail || `HTTP ${res.status}`, status: res.status, url })
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

/** Best-effort human message from a thrown API/network error. */
export function apiErrorMessage(e, fallback = '') {
  return (
    e?.response?.data?.detail ||
    e?.response?.data?.error ||
    e?.data?.error ||
    e?.message ||
    fallback ||
    String(e)
  )
}
