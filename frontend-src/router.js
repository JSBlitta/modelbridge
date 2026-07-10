// Updated router/index.js — replace the existing one in webapp/frontend/src/router/index.js
// Adds: /login route + auth guard on all other routes

import { createRouter, createWebHistory } from 'vue-router'
import Landing from '../views/Landing.vue'
import Login from '../views/Login.vue'
import UnifiedImport from '../views/UnifiedImport.vue'
import BatchManager from '../views/BatchManager.vue'
import AssemblyUpdate from '../views/AssemblyUpdate.vue'
import PdfUpload from '../views/PdfUpload.vue'
import TrimbleImport from '../views/TrimbleImport.vue'

const routes = [
  { path: '/login', component: Login, meta: { public: true } },
  { path: '/', component: Landing },
  { path: '/import', component: UnifiedImport },
  { path: '/trimble', component: TrimbleImport },
  { path: '/batches', component: BatchManager },
  { path: '/update', component: AssemblyUpdate },
  { path: '/pdf', component: PdfUpload },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// Auth guard — check session status before each protected route
let authChecked = false
let isAuthenticated = false

router.beforeEach(async (to) => {
  if (to.meta.public) return true

  if (!authChecked) {
    try {
      const res = await fetch('/api/auth/status')
      isAuthenticated = res.ok && (await res.json()).authenticated
    } catch {
      isAuthenticated = false
    }
    authChecked = true
  }

  if (!isAuthenticated) return '/login'
})

// Reset auth state on 401 (token expired mid-session)
import axios from 'axios'
axios.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401 && err.response?.data?.code === 'SESSION_EXPIRED') {
      authChecked = false
      isAuthenticated = false
      router.push('/login')
    }
    return Promise.reject(err)
  }
)

export default router
