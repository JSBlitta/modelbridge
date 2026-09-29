import { ref } from 'vue'
import { api } from '../api.js'

// Shared session state. App.vue and Login.vue both read this so that logging in
// updates the sidebar immediately, without a full page reload.
const username = ref('')
const isAdmin = ref(false)

async function refreshAuthStatus() {
  try {
    const res = await api.get('/api/auth/status')
    username.value = res.data.username ?? ''
    isAdmin.value = res.data.isAdmin ?? false
    return res.data
  } catch {
    username.value = ''
    isAdmin.value = false
    return null
  }
}

function clearAuth() {
  username.value = ''
  isAdmin.value = false
}

export function useAuth() {
  return { username, isAdmin, refreshAuthStatus, clearAuth }
}
