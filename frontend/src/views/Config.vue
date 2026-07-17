<template>
  <div>
    <h2 class="page-title">Configuration</h2>

    <Card class="mb-card" v-if="config">
      <template #title>{{ $t('config.apiSettings') }}</template>
      <template #content>
        <div class="form-grid">
          <label>{{ $t('config.baseUrl') }}</label>
          <InputText v-model="config.api.base_url" style="width:100%;" />

          <label>{{ $t('config.refreshToken') }}</label>
          <div style="display:flex;gap:0.5rem;">
            <InputText
              v-model="newRefreshToken"
              :type="showToken ? 'text' : 'password'"
              :placeholder="config.api.refresh_token_masked || '(t('config.unchanged'))'"
              style="flex:1;"
            />
            <Button :icon="showToken ? 'pi pi-eye-slash' : 'pi pi-eye'" text @click="showToken = !showToken" />
          </div>

          <label>{{ $t('config.clientName') }}</label>
          <InputText v-model="config.defaults.client_name" style="width:100%;" />
        </div>
      </template>
    </Card>

    <Card class="mb-card" v-if="config">
      <template #title>{{ $t('config.synonyms') }}</template>
      <template #content>
        <DataTable :value="synonymRows" edit-mode="cell" @cell-edit-complete="onSynEdit" size="small">
          <Column field="field" :header="$t('config.field')" style="width:140px" />
          <Column field="synonyms_str" :header="$t('config.synonymsLabel')">
            <template #editor="{ data, field }">
              <InputText v-model="data[field]" style="width:100%;" />
            </template>
          </Column>
        </DataTable>
      </template>
    </Card>

    <Card class="mb-card" v-if="config">
      <template #title>{{ $t('config.descSuffixMap') }}</template>
      <template #content>
        <DataTable :value="suffixRows" edit-mode="cell" @cell-edit-complete="onSuffixEdit" size="small">
          <Column field="description" :header="$t('config.description')">
            <template #editor="{ data, field }">
              <InputText v-model="data[field]" />
            </template>
          </Column>
          <Column field="suffix" :header="$t('config.suffix')" style="width:100px">
            <template #editor="{ data, field }">
              <InputText v-model="data[field]" style="width:60px;" />
            </template>
          </Column>
        </DataTable>
        <Button :label="$t('config.addRow')" icon="pi pi-plus" text size="small" style="margin-top:0.5rem;" @click="addSuffixRow" />
      </template>
    </Card>

    <div style="display:flex;gap:0.75rem;margin-bottom:1.5rem;">
      <Button :label="$t('config.saveConfig')" icon="pi pi-save" severity="success" @click="saveConfig" :loading="saving" />
    </div>

    <Card class="mb-card">
      <template #title>{{ $t('config.batchOverview') }}</template>
      <template #content>
        <DataTable :value="dbBatches" size="small" striped-rows>
          <Column field="name" :header="$t('config.name')" />
          <Column field="phase" :header="$t('config.phase')" />
          <Column field="state" :header="$t('config.state')">
            <template #body="{ data }">
              <Tag :severity="data.state === 'definitive' ? 'success' : 'warn'" :value="data.state" />
            </template>
          </Column>
          <Column field="updated_at" :header="$t('config.updated')" />
        </DataTable>
        <Button :label="$t('config.exportCsv')" icon="pi pi-download" text style="margin-top:0.5rem;" @click="exportBatchCsv" />
      </template>
    </Card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { api } from '../api.js'

const config = ref(null)
const newRefreshToken = ref('')
const showToken = ref(false)
const saving = ref(false)
const dbBatches = ref([])
const suffixRows = ref([])

const synonymRows = computed(() => {
  if (!config.value?.synonyms) return []
  return Object.entries(config.value.synonyms).map(([field, syns]) => ({
    field,
    synonyms_str: Array.isArray(syns) ? syns.join(', ') : syns,
  }))
})

onMounted(async () => {
  const [cfgRes, dbRes] = await Promise.all([
    api.get('/api/config'),
    api.get('/api/batches/db'),
  ])
  config.value = cfgRes.data
  dbBatches.value = dbRes.data || []
  if (config.value?.description_to_suffix) {
    suffixRows.value = Object.entries(config.value.description_to_suffix).map(([description, suffix]) => ({ description, suffix }))
  }
})

function onSynEdit(e) {
  const { data, newValue, field } = e
  data[field] = newValue
  if (config.value?.synonyms && data.field) {
    config.value.synonyms[data.field] = newValue.split(',').map(s => s.trim()).filter(Boolean)
  }
}

function onSuffixEdit(e) {
  const { data, newValue, field } = e
  data[field] = newValue
}

function addSuffixRow() {
  suffixRows.value.push({ description: '', suffix: '' })
}

async function saveConfig() {
  saving.value = true
  try {
    const newDesc = {}
    for (const row of suffixRows.value) {
      if (row.description) newDesc[row.description] = row.suffix
    }
    const payload = {
      ...config.value,
      description_to_suffix: newDesc,
    }
    if (newRefreshToken.value) {
      payload.api = { ...payload.api, refresh_token: newRefreshToken.value }
    } else {
      delete payload.api.refresh_token_masked
    }
    await api.post('/api/config', payload)
    alert(t('config.configSaved'))
  } finally {
    saving.value = false
  }
}

function exportBatchCsv() {
  const headers = ['uuid', 'name', 'phase', 'state', 'updated_at']
  const rows = dbBatches.value.map(b => headers.map(h => b[h] || ''))
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'batches.csv'
  a.click()
}
</script>

<style scoped>
.page-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 1.5rem; }
.mb-card { margin-bottom: 1.25rem; }
.form-grid { display: grid; grid-template-columns: 160px 1fr; gap: 0.75rem 1rem; align-items: center; }
</style>
