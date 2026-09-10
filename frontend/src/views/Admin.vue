<template>
  <div class="admin-page">
    <div class="page-header">
      <h2 class="page-title">{{ $t('admin.title') }}</h2>
      <p class="page-subtitle">{{ $t('admin.subtitle') }}</p>
    </div>

    <Message v-if="forbidden" severity="warn" :closable="false">
      {{ $t('admin.notAuthorized') }}
    </Message>

    <template v-else>
      <Card class="mb-card">
        <template #title>{{ $t('admin.settings') }}</template>
        <template #content>
          <div class="field">
            <label class="field-label">{{ $t('admin.admins') }}</label>
            <Textarea v-model="adminsText" rows="3" class="wide" :placeholder="$t('admin.adminsHint')" />
          </div>

          <h3 class="section-title">{{ $t('admin.reporting') }}</h3>
          <div class="field">
            <div class="checkbox-row">
              <Checkbox v-model="form.reporting_enabled" :binary="true" input-id="rep-enabled" />
              <label for="rep-enabled">{{ $t('admin.reportingEnabled') }}</label>
            </div>
          </div>
          <div class="form-grid">
            <div class="field">
              <label class="field-label">{{ $t('admin.reportingTime') }}</label>
              <InputText v-model="form.reporting_time" class="wide" />
            </div>
            <div class="field">
              <label class="field-label">{{ $t('admin.reportingTimezone') }}</label>
              <InputText v-model="form.reporting_timezone" class="wide" />
            </div>
            <div class="field">
              <label class="field-label">{{ $t('admin.reportingPageSize') }}</label>
              <InputNumber v-model="form.reporting_page_size" class="wide" />
            </div>
            <div class="field">
              <label class="field-label">{{ $t('admin.reportingMaxPages') }}</label>
              <InputNumber v-model="form.reporting_max_pages" class="wide" />
            </div>
            <div class="field">
              <label class="field-label">{{ $t('admin.reportingOutputDir') }}</label>
              <InputText v-model="form.reporting_output_dir" class="wide" />
            </div>
            <div class="field">
              <label class="field-label">{{ $t('admin.reportingBaseUrl') }}</label>
              <InputText v-model="form.reporting_base_url" class="wide" />
            </div>
            <div class="field">
              <label class="field-label">{{ $t('admin.reportingRefreshToken') }}</label>
              <InputText v-model="form.reporting_refresh_token" type="password" class="wide" />
            </div>
          </div>

          <div class="actions-row">
            <Button :label="$t('admin.save')" @click="saveSettings" />
          </div>
        </template>
      </Card>

      <Card>
        <template #title>{{ $t('admin.schedule') }}</template>
        <template #content>
          <table class="schedule-table">
            <thead>
              <tr>
                <th>{{ $t('admin.endpoint') }}</th>
                <th>{{ $t('admin.active') }}</th>
                <th>{{ $t('admin.frequency') }}</th>
                <th>{{ $t('admin.weekdays') }}</th>
                <th>{{ $t('admin.dayOfMonth') }}</th>
                <th>{{ $t('admin.storagePath') }}</th>
                <th>{{ $t('admin.overwrite') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.key">
                <td><InputText v-model="row.endpoint" class="wide" /></td>
                <td><Checkbox v-model="row.active" :binary="true" /></td>
                <td>
                  <Dropdown v-model="row.frequency" :options="frequencies" option-label="label" option-value="value" class="freq-dropdown" />
                </td>
                <td><InputText v-model="row.weekdays" class="wide" /></td>
                <td><InputNumber v-model="row.day_of_month" class="num-input" /></td>
                <td><InputText v-model="row.storage_path" class="wide" /></td>
                <td><Checkbox v-model="row.overwrite" :binary="true" /></td>
                <td><Button :label="$t('admin.delete')" size="small" severity="danger" text @click="deleteRow(row)" /></td>
              </tr>
            </tbody>
          </table>
          <div class="actions-row">
            <Button :label="$t('admin.addEndpoint')" size="small" text @click="addRow" />
            <Button :label="$t('admin.saveSchedule')" @click="saveSchedule" />
          </div>
        </template>
      </Card>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '../api.js'
import { useNotifications } from '../composables/useNotifications.js'

const { t } = useI18n()
const { notify } = useNotifications()

const forbidden = ref(false)
const adminsText = ref('')
const form = ref({
  reporting_enabled: false,
  reporting_time: '18:15',
  reporting_timezone: 'Europe/Amsterdam',
  reporting_page_size: 1000,
  reporting_max_pages: 60,
  reporting_output_dir: 'data/reporting',
  reporting_base_url: '',
  reporting_refresh_token: '',
})

const frequencies = [
  { label: t('admin.daily'), value: 'Dagelijks' },
  { label: t('admin.weekly'), value: 'Wekelijks' },
  { label: t('admin.monthly'), value: 'Maandelijks' },
]

const rows = ref([])
let _seq = 0

onMounted(async () => {
  try {
    const [settingsRes, scheduleRes] = await Promise.all([
      api.get('/api/admin/settings'),
      api.get('/api/admin/schedule'),
    ])
    applySettings(settingsRes.data)
    rows.value = scheduleRes.data.map((r) => ({
      key: ++_seq,
      id: r.id,
      endpoint: r.endpoint,
      active: !!r.active,
      frequency: r.frequency,
      weekdays: (JSON.parse(r.weekdays || '[]')).join(', '),
      day_of_month: r.day_of_month,
      conditions: r.conditions,
      storage_path: r.storage_path,
      overwrite: !!r.overwrite,
    }))
  } catch (e) {
    if (e?.response?.status === 403) forbidden.value = true
  }
})

function applySettings(s) {
  adminsText.value = (Array.isArray(s.admin_usernames) ? s.admin_usernames : []).join('\n')
  form.value = {
    reporting_enabled: !!s.reporting_enabled,
    reporting_time: s.reporting_time ?? '18:15',
    reporting_timezone: s.reporting_timezone ?? 'Europe/Amsterdam',
    reporting_page_size: s.reporting_page_size ?? 1000,
    reporting_max_pages: s.reporting_max_pages ?? 60,
    reporting_output_dir: s.reporting_output_dir ?? 'data/reporting',
    reporting_base_url: s.reporting_base_url ?? '',
    reporting_refresh_token: s.reporting_refresh_token ?? '',
  }
}

async function saveSettings() {
  await api.put('/api/admin/settings', {
    admin_usernames: adminsText.value.split('\n').map((s) => s.trim()).filter(Boolean),
    reporting_enabled: form.value.reporting_enabled,
    reporting_time: form.value.reporting_time,
    reporting_timezone: form.value.reporting_timezone,
    reporting_page_size: form.value.reporting_page_size,
    reporting_max_pages: form.value.reporting_max_pages,
    reporting_output_dir: form.value.reporting_output_dir,
    reporting_base_url: form.value.reporting_base_url,
    reporting_refresh_token: form.value.reporting_refresh_token,
  })
  notify({ severity: 'success', summary: t('admin.saved') })
}

function addRow() {
  rows.value.push({
    key: ++_seq,
    id: null,
    endpoint: '',
    active: true,
    frequency: 'Dagelijks',
    weekdays: 'Maandag, Dinsdag, Woensdag, Donderdag, Vrijdag',
    day_of_month: null,
    conditions: '',
    storage_path: '',
    overwrite: false,
  })
}

async function deleteRow(row) {
  if (row.id) await api.delete(`/api/admin/schedule/${row.id}`).catch(() => {})
  rows.value = rows.value.filter((r) => r.key !== row.key)
}

async function saveSchedule() {
  for (const row of rows.value) {
    const payload = {
      endpoint: row.endpoint,
      active: row.active,
      frequency: row.frequency,
      weekdays: row.weekdays.split(',').map((s) => s.trim()).filter(Boolean),
      day_of_month: row.day_of_month ?? null,
      conditions: row.conditions,
      storage_path: row.storage_path,
      overwrite: row.overwrite,
    }
    if (row.id) {
      await api.patch(`/api/admin/schedule/${row.id}`, payload)
    } else {
      const res = await api.post('/api/admin/schedule', payload)
      row.id = res.data.id
    }
  }
  notify({ severity: 'success', summary: t('admin.saved') })
}
</script>

<style scoped>
.admin-page { max-width: 1440px; margin: 0 auto; }
.page-header { margin-bottom: 1.25rem; }
.page-title { margin: 0; }
.page-subtitle { color: #6b7280; font-size: 0.9rem; margin-top: 0.25rem; }
.mb-card { margin-bottom: 1rem; }
.section-title { font-size: 0.9rem; font-weight: 600; color: #4b5563; margin: 1rem 0 0.5rem; }
.field { margin-bottom: 0.75rem; }
.field-label { display: block; font-size: 0.8rem; font-weight: 600; color: #4b5563; margin-bottom: 0.25rem; }
.wide { width: 100%; }
.num-input { width: 100px; }
.freq-dropdown { min-width: 140px; }
.checkbox-row { display: flex; align-items: center; gap: 0.5rem; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 0.75rem; }
.actions-row { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
.schedule-table { width: 100%; border-collapse: collapse; }
.schedule-table th, .schedule-table td { padding: 0.4rem 0.5rem; border-bottom: 1px solid #e5e7eb; text-align: left; vertical-align: middle; }
.schedule-table th { font-size: 0.75rem; font-weight: 600; color: #4b5563; }
</style>
