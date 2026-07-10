<!-- Updated App.vue — replace webapp/frontend/src/App.vue -->
<!-- Sidebar only shown when logged in (not on /login route) -->
<template>
  <div v-if="$route.path === '/login'" class="login-layout">
    <RouterView />
  </div>
  <div v-else class="app-layout">
    <aside class="sidebar">
      <div class="sidebar-header">
        <h2>Produuzit</h2>
        <span class="sidebar-user">{{ username }}</span>
      </div>
      <nav class="sidebar-nav">
        <RouterLink to="/compact" class="nav-link" active-class="active">
          <i class="pi pi-upload"></i> Import
        </RouterLink>
        <RouterLink to="/trimble" class="nav-link" active-class="active">
          <i class="pi pi-cloud"></i> Trimble
        </RouterLink>
        <RouterLink to="/batches" class="nav-link" active-class="active">
          <i class="pi pi-cog"></i> Generate
        </RouterLink>
      </nav>
      <div class="sidebar-footer">
        <a href="https://produuz.it" target="_blank" rel="noopener noreferrer" class="platform-link">
          <i class="pi pi-external-link"></i> Open Produuzit
        </a>
        <button class="logout-btn" @click="logout">
          <i class="pi pi-sign-out"></i> Sign out
        </button>
      </div>
    </aside>
    <main class="main-content">
      <RouterView />
    </main>
    <Toast />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { RouterLink, RouterView, useRouter } from 'vue-router'
import axios from 'axios'

const router = useRouter()
const username = ref('')

onMounted(async () => {
  try {
    const res = await axios.get('/api/auth/status')
    username.value = res.data.username ?? ''
  } catch { /* handled by router guard */ }
})

async function logout() {
  await axios.post('/api/auth/logout').catch(() => {})
  username.value = ''
  router.push('/login')
}
</script>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--p-font-family, sans-serif); background: #f5f5f5; }
.login-layout { min-height: 100vh; }
.app-layout { display: flex; min-height: 100vh; }
.sidebar { width: 220px; background: #1e293b; color: white; display: flex; flex-direction: column; flex-shrink: 0; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
.sidebar-header { padding: 1.25rem 1rem 1rem; border-bottom: 1px solid #334155; }
.sidebar-header h2 { font-size: 1.25rem; font-weight: 700; color: #e40520; }
.sidebar-user { font-size: 0.7rem; color: #94a3b8; display: block; margin-top: 0.2rem; }
.sidebar-nav { display: flex; flex-direction: column; padding: 1rem 0; gap: 0.25rem; flex: 1; }
.nav-link { display: flex; align-items: center; gap: 0.6rem; padding: 0.65rem 1.25rem; color: #cbd5e1; text-decoration: none; border-radius: 0.25rem; margin: 0 0.5rem; transition: background 0.15s; }
.nav-link:hover { background: #334155; color: white; }
.nav-link.active { background: #e40520; color: white; }
.nav-link.nav-highlight { color: #e40520; font-weight: 600; }
.nav-link.nav-highlight.active { background: #c0392b; color: white; }
.nav-section-label { font-size: 0.65rem; letter-spacing: 0.1em; color: #64748b; padding: 0.5rem 1.25rem 0.1rem; text-transform: uppercase; }
.sidebar-footer { padding: 0.75rem; border-top: 1px solid #334155; }
.logout-btn { width: 100%; display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 1rem; color: #94a3b8; background: none; border: none; cursor: pointer; border-radius: 0.25rem; font-size: 0.85rem; }
.logout-btn:hover { background: #334155; color: #e2e8f0; }
.main-content { flex: 1; padding: 2rem; overflow-y: auto; }
</style>
