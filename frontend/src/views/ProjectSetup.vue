<template>
  <div>
    <h2 class="page-title">{{ $t('projectSetup.title') }}</h2>

    <Card class="mb-card">
      <template #title>{{ $t('projectSetup.uploadCsv') }}</template>
      <template #content>
        <p style="color:#6b7280;font-size:0.85rem;margin-bottom:0.75rem;">
          {{ $t('projectSetup.infoText') }}
        </p>
        <FileUpload
          mode="basic"
          accept=".csv"
          :auto="false"
          :choose-label="$t('projectSetup.selectCsv')"
          @select="onFileSelect"
        />
      </template>
    </Card>

    <Card v-if="parseError || noProjectsFound" class="mb-card">
      <template #content>
        <Message v-if="parseError" severity="error" :closable="false">{{ parseError }}</Message>
        <Message v-if="noProjectsFound" severity="warn" :closable="false">
          {{ $t('projectSetup.noProjects') }}
        </Message>
      </template>
    </Card>

    <Card v-if="phaseSuggestions.length" class="mb-card">
      <template #title>{{ $t('projectSetup.projectGroups') }} ({{ phaseSuggestions.length }} found)</template>
      <template #content>
        <PhaseTable v-model:rows="phaseSuggestions" />
        <div style="margin-top:1rem; display:flex; gap:0.75rem; align-items:center;">
          <Button :label="$t('projectSetup.checkBtn')" icon="pi pi-search" @click="checkProjects" :loading="checking" class="btn-preview" />
          <span v-if="checkDone" class="info-text">
            {{ $t('projectSetup.newFound', { newCount, foundCount }) }}
          </span>
        </div>
      </template>
    </Card>

    <Card v-if="checkDone && newCount > 0" class="mb-card">
      <template #title>{{ $t('projectSetup.confirmBtn') }}</template>
      <template #content>
        <Message severity="warn">
          {{ $t('projectSetup.newProjects', { count: newCount }) }}
        </Message>
        <ConfirmationTable
          :rows="confirmRows"
          :columns="[{field:'project_key',header:$t('projectSetup.project')},{field:'superproject',header:$t('projectSetup.superproject')},{field:'suggested_phase',header:$t('projectSetup.phase')}]"
          status-field="status"
          @confirm="createProjects"
          @cancel="checkDone = false"
          style="margin-top:1rem"
        />
      </template>
    </Card>

    <Card v-if="checkDone && newCount === 0" class="mb-card">
      <template #content>
        <Message severity="success" :closable="false">
          {{ $t('projectSetup.alreadyExist', { count: foundCount }) }}
        </Message>
      </template>
    </Card>

    <Card v-if="createResults.length" class="mb-card">
      <template #title>{{ $t('projectSetup.creationResults') }}</template>
      <template #content>
        <DataTable :value="createResults" size="small">
          <Column field="project_key" :header="$t('projectSetup.project')" />
          <Column field="status" :header="$t('projectSetup.status')">
            <template #body="{ data }">
              <Tag :severity="data.status === 'created' ? 'success' : data.status === 'error' ? 'danger' : 'secondary'" :value="data.status" />
            </template>
          </Column>
          <Column field="error" :header="$t('projectSetup.error')" />
        </DataTable>
      </template>
    </Card>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { api } from '../api.js'
import PhaseTable from '../components/PhaseTable.vue'
import ConfirmationTable from '../components/ConfirmationTable.vue'

const phaseSuggestions = ref([])
const parseError = ref('')
const noProjectsFound = ref(false)
const checking = ref(false)
const checkDone = ref(false)
const createResults = ref([])

const newCount = computed(() => phaseSuggestions.value.filter(r => r.status === 'new').length)
const foundCount = computed(() => phaseSuggestions.value.filter(r => r.status === 'found').length)
const confirmRows = computed(() => phaseSuggestions.value.filter(r => r.status === 'new'))

async function onFileSelect(e) {
  parseError.value = ''
  noProjectsFound.value = false
  const file = e.files?.[0]
  if (!file) return
  const form = new FormData()
  form.append('file', file)
  try {
    const res = await api.post('/api/csv/parse', form)
    phaseSuggestions.value = res.data.phase_suggestions || []
    noProjectsFound.value = phaseSuggestions.value.length === 0
    checkDone.value = false
    createResults.value = []
  } catch (err) {
    parseError.value = err.response?.data?.detail || err.message
  }
}

async function checkProjects() {
  checking.value = true
  try {
    const payload = phaseSuggestions.value.map(p => ({
      project_key: p.project_key,
      superproject: p.superproject,
      letter: p.letter,
      description: p.description,
      suggested_suffix: p.suggested_suffix,
      phase: p.suggested_phase || '',
    }))
    const res = await api.post('/api/projects/find-or-create', payload)
    const statusMap = {}
    for (const r of res.data) {
      statusMap[r.project_key] = r.status
    }
    phaseSuggestions.value = phaseSuggestions.value.map(p => ({
      ...p,
      status: statusMap[p.project_key] || p.status,
    }))
    checkDone.value = true
  } catch (err) {
    parseError.value = err.response?.data?.detail || err.message
  } finally {
    checking.value = false
  }
}

async function createProjects() {
  const newOnes = phaseSuggestions.value.filter(r => r.status === 'new')
  const payload = newOnes.map(p => ({
    project_key: p.project_key,
    superproject: p.superproject,
    letter: p.letter,
    description: p.description,
    suggested_suffix: p.suggested_suffix,
    phase: p.suggested_phase || '',
  }))
  try {
    const res = await api.post('/api/projects/create', payload)
    createResults.value = res.data
    const statusMap = {}
    for (const r of res.data) {
      statusMap[r.project_key] = r.status === 'created' ? 'found' : r.status
    }
    phaseSuggestions.value = phaseSuggestions.value.map(p => ({
      ...p,
      status: statusMap[p.project_key] || p.status,
    }))
  } catch (err) {
    parseError.value = err.response?.data?.detail || err.message
  }
}
</script>

<style scoped>
.page-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 1.5rem; }
.mb-card { margin-bottom: 1.25rem; }
.error-msg { color: #dc2626; margin-top: 0.5rem; }
.info-text { color: #374151; }

.btn-preview { background: #6366f1; border-color: #6366f1; }
.btn-preview:hover { background: #4f46e5; border-color: #4f46e5; }
</style>
