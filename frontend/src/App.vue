<template>
  <div v-if="$route.path === '/login'" class="login-layout">
    <RouterView />
  </div>
  <div v-else class="app-layout">
    <aside class="sidebar">
      <div class="sidebar-header">
        <h2>{{ $t('app.title') }}</h2>
        <span class="sidebar-user">{{ username }}</span>
      </div>
      <nav class="sidebar-nav">
        <RouterLink to="/trimble" class="nav-link" active-class="active">
          <i class="pi pi-cloud"></i> {{ $t('nav.trimble') }}
        </RouterLink>
        <div class="nav-separator"></div>
        <RouterLink to="/import" class="nav-link" active-class="active">
          <i class="pi pi-upload"></i> {{ $t('nav.import') }}
        </RouterLink>
        <RouterLink to="/batches" class="nav-link" active-class="active">
          <i class="pi pi-cog"></i> {{ $t('nav.batches') }}
        </RouterLink>
        <RouterLink to="/update" class="nav-link" active-class="active">
          <i class="pi pi-pencil"></i> {{ $t('nav.update') }}
        </RouterLink>
        <RouterLink to="/pdf" class="nav-link" active-class="active">
          <i class="pi pi-file-pdf"></i> {{ $t('nav.pdf') }}
        </RouterLink>
      </nav>
      <div class="sidebar-footer">
        <div class="lang-switcher">
          <button :class="['lang-btn', { active: locale === 'en' }]" @click="switchLang('en')">EN</button>
          <button :class="['lang-btn', { active: locale === 'nl' }]" @click="switchLang('nl')">NL</button>
        </div>
        <a v-if="$route.path !== '/'" href="https://produuz.it" target="_blank" rel="noopener noreferrer" class="platform-link">
          <i class="pi pi-external-link"></i> {{ $t('app.openPlatform') }}
        </a>
        <button class="logout-btn" @click="logout">
          <i class="pi pi-sign-out"></i> {{ $t('app.signOut') }}
        </button>
      </div>
    </aside>
    <main class="main-content">
      <RouterView />
    </main>
    <div class="notif-bell-wrap">
      <button class="notif-bell" @click="toggleNotifications">
        <i class="pi pi-bell"></i>
        <span v-if="unreadCount" class="notif-badge">{{ unreadCount }}</span>
      </button>
      <div v-if="showNotifications" class="notif-panel">
        <div class="notif-header">
          <span>{{ $t('notifications.title') }}</span>
          <div style="display:flex;gap:0.4rem;">
            <Button :label="$t('notifications.clearAll')" size="small" text @click="clearAll" />
          </div>
        </div>
        <div v-if="!notifications.length" class="notif-empty">{{ $t('notifications.empty') }}</div>
        <div v-for="n in notifications" :key="n.id" class="notif-item" :class="'sev-' + n.severity">
          <div class="notif-item-head">
            <span class="notif-summary">{{ n.summary }}</span>
            <span class="notif-time">{{ formatTime(n.time) }}</span>
          </div>
          <div v-if="n.detail" class="notif-detail">{{ n.detail }}</div>
        </div>
      </div>
    </div>
    <Toast position="bottom-right" />
    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from 'primevue/usetoast'
import { api, onApiError, onUnauthorized } from './api.js'
import ConfirmDialog from 'primevue/confirmdialog'
import { useNotifications } from './composables/useNotifications.js'

const router = useRouter()
const toast = useToast()
const username = ref('')
const { t, locale } = useI18n()

const { notifications, unreadCount, notify, registerToaster, clearAll } = useNotifications()
const showNotifications = ref(false)

// Wire notification history into the PrimeVue toast
registerToaster(({ severity, summary, detail, life }) => {
  toast.add({ severity, summary, detail, life })
})

function toggleNotifications() {
  showNotifications.value = !showNotifications.value
  if (showNotifications.value) {
    // mark all read when opening the panel
    notifications.value.forEach((n) => { n.read = true })
  }
}

function formatTime(iso) {
  const d = new Date(iso)
  return d.toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function switchLang(lang) {
  locale.value = lang
  localStorage.setItem('lang', lang)
}

// Register global error toasts — fires on any non-401 API error
onApiError(({ message }) => {
  notify({ severity: 'error', summary: t('app.error'), detail: message, life: 5000 })
})

// Register 401 handler — redirect to login on session expiry
onUnauthorized(() => {
  router.push('/login')
})

onMounted(async () => {
  try {
    const res = await api.get('/api/auth/status')
    username.value = res.data.username ?? ''
  } catch { /* router guard handles redirect */ }
})

async function logout() {
  await api.post('/api/auth/logout').catch(() => {})
  username.value = ''
  router.push('/login')
}
</script>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--p-font-family, sans-serif); background: #f5f5f5; }
.login-layout { min-height: 100vh; }

/* Red accent bars — top bar sidebar-width only, bottom bar full-width */
.app-layout {
  display: flex; min-height: 100vh;
  border-bottom: 10px solid #e40520;
}

/* Sidebar — fixed position, independently scrollable. Top red bar lives here. */
.sidebar { width: 220px; background: #1c1c1e; color: white; display: flex; flex-direction: column; flex-shrink: 0; position: fixed; top: 0; bottom: 10px; left: 0; overflow-y: auto; z-index: 10; border-top: 10px solid #e40520; }
.sidebar-header { padding: 1.25rem 1rem 1rem; border-bottom: 1px solid #2d2d30; }
.sidebar-header h2 { font-size: 1.25rem; font-weight: 700; color: #e40520; }
.sidebar-user { font-size: .7rem; color: #8e8e93; display: block; margin-top: .2rem; }
.sidebar-nav { display: flex; flex-direction: column; padding: 1rem 0; gap: .25rem; flex: 1; }
.nav-link { display: flex; align-items: center; gap: .6rem; padding: .65rem 1.25rem; color: #b0b0b5; text-decoration: none; border-radius: .25rem; margin: 0 .5rem; transition: background .15s; }
.nav-link:hover { background: #2d2d30; color: white; }
.nav-link.active { background: #e40520; color: white; }
.nav-separator { height: 1px; background: #2d2d30; margin: 0.35rem 0.75rem; }
.nav-link.nav-highlight { color: #e40520; font-weight: 600; }
.nav-link.nav-highlight.active { background: #c0392b; color: white; }
.nav-section-label { font-size: .65rem; letter-spacing: .1em; color: #6e6e73; padding: .5rem 1.25rem .1rem; text-transform: uppercase; }
.sidebar-footer { padding: .75rem; border-top: 1px solid #2d2d30; }
.lang-switcher { display: flex; gap: .35rem; margin-bottom: .5rem; }
.lang-btn { padding: .3rem .6rem; font-size: .7rem; font-weight: 600; background: #2d2d30; color: #8e8e93; border: 1px solid transparent; border-radius: 4px; cursor: pointer; transition: all .15s; }
.lang-btn:hover { color: #e5e5ea; }
.lang-btn.active { background: #e40520; color: white; border-color: #e40520; }
.platform-link { display: flex; align-items: center; gap: .5rem; padding: .6rem 1rem; color: #e40520; text-decoration: none; border-radius: .25rem; font-size: .85rem; margin-bottom: .25rem; }
.platform-link:hover { background: #2d2d30; color: #ff6b7a; }
.logout-btn { width: 100%; display: flex; align-items: center; gap: .5rem; padding: .6rem 1rem; color: #8e8e93; background: none; border: none; cursor: pointer; border-radius: .25rem; font-size: .85rem; }
.logout-btn:hover { background: #2d2d30; color: #e5e5ea; }
.main-content { margin-left: 220px; flex: 1; padding: 2rem; overflow-y: auto; min-height: calc(100vh - 10px); }

/* Notification bell — fixed top right */
.notif-bell-wrap { position: fixed; top: 1.25rem; right: 1.5rem; z-index: 50; }
.notif-bell { position: relative; background: #fff; border: 1px solid #d1d5db; border-radius: 50%; width: 2.5rem; height: 2.5rem; cursor: pointer; color: #374151; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
.notif-bell:hover { background: #f3f4f6; }
.notif-badge { position: absolute; top: -0.35rem; right: -0.35rem; background: #e40520; color: #fff; font-size: 0.65rem; font-weight: 700; border-radius: 999px; padding: 0.15rem 0.4rem; line-height: 1; }
.notif-panel { position: absolute; top: 3rem; right: 0; width: 340px; max-height: 420px; overflow-y: auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.14); }
.notif-header { display: flex; align-items: center; justify-content: space-between; padding: 0.6rem 0.9rem; border-bottom: 1px solid #f3f4f6; font-weight: 600; color: #374151; }
.notif-empty { padding: 1.25rem; text-align: center; color: #9ca3af; font-size: 0.85rem; }
.notif-item { padding: 0.6rem 0.9rem; border-bottom: 1px solid #f3f4f6; border-left: 3px solid transparent; }
.notif-item.sev-success { border-left-color: #16a34a; }
.notif-item.sev-warn { border-left-color: #d97706; }
.notif-item.sev-error { border-left-color: #dc2626; }
.notif-item.sev-info { border-left-color: #2563eb; }
.notif-item-head { display: flex; justify-content: space-between; gap: 0.5rem; }
.notif-summary { font-size: 0.82rem; font-weight: 600; color: #1f2937; }
.notif-time { font-size: 0.68rem; color: #9ca3af; white-space: nowrap; }
.notif-detail { font-size: 0.76rem; color: #6b7280; margin-top: 0.15rem; word-break: break-word; }
</style>
