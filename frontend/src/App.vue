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

const router = useRouter()
const toast = useToast()
const username = ref('')
const { t, locale } = useI18n()

function switchLang(lang) {
  locale.value = lang
  localStorage.setItem('lang', lang)
}

// Register global error toasts — fires on any non-401 API error
onApiError(({ message }) => {
  toast.add({ severity: 'error', summary: 'Error', detail: message, life: 5000 })
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
</style>
