<template>
  <div class="login-wrapper">
    <div class="login-card">
      <h1 class="login-title">Produuzit</h1>
      <p class="login-sub">Sign in with your Produuzit account</p>

      <form @submit.prevent="submit" class="login-form">
        <div class="field">
          <label for="username">Username</label>
          <InputText id="username" v-model="username" autocomplete="username" placeholder="your.name" class="wide" />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <Password id="password" v-model="password" :feedback="false" toggleMask autocomplete="current-password" placeholder="••••••••" class="wide" />
        </div>
        <Message v-if="error" severity="error" :closable="false" style="margin-top:0.5rem;">{{ error }}</Message>
        <Button type="submit" label="Sign in" icon="pi pi-sign-in" class="wide" style="margin-top:1rem;" :loading="loading" />
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import axios from 'axios'

const router = useRouter()
const username = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

async function submit() {
  error.value = ''
  loading.value = true
  try {
    await axios.post('/api/auth/login', { username: username.value, password: password.value })
    router.push('/')
  } catch (e) {
    error.value = e.response?.data?.error ?? 'Login failed'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-wrapper { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f5f5f5; }
.login-card { background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 2.5rem 2rem; width: 100%; max-width: 380px; box-shadow: 0 4px 24px rgba(0,0,0,0.07); }
.login-title { font-size: 1.75rem; font-weight: 700; color: #e40520; margin-bottom: 0.25rem; text-align: center; }
.login-sub { color: #6b7280; font-size: 0.875rem; text-align: center; margin-bottom: 1.75rem; }
.login-form { display: flex; flex-direction: column; gap: 0.75rem; }
.field { display: flex; flex-direction: column; gap: 0.35rem; }
.field label { font-size: 0.8rem; font-weight: 600; color: #374151; }
.wide { width: 100%; }
</style>
