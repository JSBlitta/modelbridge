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

  return { notifications, unreadCount, notify, registerToaster, markAllRead, clearAll }
}
