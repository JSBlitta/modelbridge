import { createRouter, createWebHistory } from 'vue-router'
import { onUnauthorized } from '../api.js'
import Landing from '../views/Landing.vue'
import Login from '../views/Login.vue'
import UnifiedImport from '../views/UnifiedImport.vue'
import BatchManager from '../views/BatchManager.vue'
import AssemblyUpdate from '../views/AssemblyUpdate.vue'
import PdfUpload from '../views/PdfUpload.vue'
import TrimbleImport from '../views/TrimbleImport.vue'
import Admin from '../views/Admin.vue'

const routes = [
  { path: '/login', component: Login, meta: { public: true } },
  { path: '/', component: Landing },
  { path: '/import', component: UnifiedImport },
  { path: '/trimble', component: TrimbleImport },
  { path: '/batches', component: BatchManager },
  { path: '/update', component: AssemblyUpdate },
  { path: '/pdf', component: PdfUpload },
  { path: '/admin', component: Admin },
]

const router = createRouter({ history: createWebHistory(), routes })

let authChecked = false
let isAuthenticated = false

export function setAuthenticated(value) {
  isAuthenticated = value
  authChecked = true
}

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

onUnauthorized(() => {
  authChecked = false
  isAuthenticated = false
  router.push('/login')
})

export default router
