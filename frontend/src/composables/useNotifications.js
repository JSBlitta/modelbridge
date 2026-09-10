import { ref, computed } from 'vue'

// Module-level state so all views share one notification history
const notifications = ref([])
let _toastHandler = null
let _seq = 0

export function useNotifications() {
  const unreadCount = computed(() => notifications.value.filter((n) => !n.read).length)

  function registerToaster(handler) {
    _toastHandler = handler
  }

  function notify({ severity = 'info', summary = '', detail = '', life = 6000 }) {
    const item = { id: ++_seq, severity, summary, detail, time: new Date().toISOString(), read: false }
    notifications.value.unshift(item)
    if (notifications.value.length > 100) notifications.value.pop()
    if (_toastHandler) _toastHandler({ severity, summary, detail, life })
  }

  function markAllRead() {
    notifications.value.forEach((n) => { n.read = true })
  }

  function clearAll() {
    notifications.value = []
  }

  // Merge the persistent server-side event log into the in-memory history.
  // Server events are shown as already-read so only live in-session actions toast.
  async function hydrateFromServer(api) {
    try {
      const res = await api.get('/api/history', { params: { limit: 100 } })
      const events = res.data?.events || []
      if (!events.length) return
      const known = new Set(notifications.value.map((n) => n.serverId).filter(Boolean))
      const items = events
        .filter((e) => !known.has(e.id))
        .map((e) => ({
          id: ++_seq,
          serverId: e.id,
          severity: e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'info',
          summary: `${e.category}: ${e.summary}`,
          detail: e.detail || '',
          time: e.ts,
          read: true,
        }))
      if (!items.length) return
      notifications.value.push(...items)
      notifications.value.sort((a, b) => new Date(b.time) - new Date(a.time))
      if (notifications.value.length > 200) notifications.value.length = 200
    } catch {
      // History endpoint unavailable — keep in-memory notifications only
    }
  }

  return { notifications, unreadCount, notify, registerToaster, markAllRead, clearAll, hydrateFromServer }
}
