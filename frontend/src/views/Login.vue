<template>
  <div class="login-wrapper">
    <div class="login-card">
      <h1 class="login-title">{{ $t('login.title') }}</h1>
      <p class="login-sub">{{ $t('login.subtitle') }}</p>

      <form @submit.prevent="submit" class="login-form">
        <div class="field">
          <label for="username">{{ $t('login.username') }}</label>
          <input id="username" v-model="username" type="text"
            autocomplete="username" :placeholder="$t('login.usernamePlaceholder')" class="pi-input" />
        </div>
        <div class="field">
          <label for="password">{{ $t('login.password') }}</label>
          <input id="password" v-model="password" type="password"
            autocomplete="current-password" :placeholder="$t('login.passwordPlaceholder')" class="pi-input" />
        </div>
        <p v-if="error" class="login-error">{{ error }}</p>
        <Button type="submit" :label="$t('login.signIn')" icon="pi pi-sign-in"
          style="width:100%;margin-top:1rem;" :loading="loading" />
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { api } from '../api.js'
import { setAuthenticated } from '../router/index.js'

const router = useRouter()
const { t } = useI18n()
const username = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

async function submit() {
  error.value = ''
  loading.value = true
  try {
    await api.post('/api/auth/login', { username: username.value, password: password.value })
    setAuthenticated(true)
    router.push('/')
  } catch (e) {
    error.value = e.response?.data?.error ?? t('login.loginFailed')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-wrapper { min-height:100vh; display:flex; align-items:center; justify-content:center; background:#f5f5f5; }
.login-card { background:white; border:1px solid #e5e7eb; border-radius:12px; padding:2.5rem 2rem; width:100%; max-width:380px; box-shadow:0 4px 24px rgba(0,0,0,.07); }
.login-title { font-size:1.75rem; font-weight:700; color:#e40520; margin-bottom:.25rem; text-align:center; }
.login-sub { color:#6b7280; font-size:.875rem; text-align:center; margin-bottom:1.75rem; }
.login-form { display:flex; flex-direction:column; gap:.75rem; }
.field { display:flex; flex-direction:column; gap:.35rem; }
.field label { font-size:.8rem; font-weight:600; color:#374151; }
.pi-input { width:100%; padding:.5rem .75rem; border:1px solid #d1d5db; border-radius:6px; font-size:.9rem; font-family:inherit; box-sizing:border-box; outline:none; }
.pi-input:focus { border-color:#e40520; box-shadow:0 0 0 2px rgba(228,5,32,.2); }
.login-error { color:#dc2626; font-size:.85rem; margin:0; }
</style>
