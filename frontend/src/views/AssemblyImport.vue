<template>
  <div>
    <h2 class="page-title">Assembly Import</h2>

    <!-- Step 1: Project -->
    <Card class="mb-card">
      <template #title>1 � Select Project</template>
      <template #content>
        <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap;">
          <Select v-model="selectedProject" :options="projects" option-label="name" option-value="uuid"
            placeholder="Select project..." style="min-width:280px" @change="onProjectChange" />
          <Button icon="pi pi-refresh" text @click="loadProjects" :loading="projectsLoading" />
          <Tag v-if="context" severity="info" :value="`${context.designs.length} designs � ${context.batches.length} batches`" />
        </div>
        <Message v-if="!projectsLoading && projects.length === 0" severity="info" :closable="false" style="margin-top:0.75rem;">
          {{ $t('assemblyImport.noProjects') }}
        </Message>
        <Message v-if="context && context.batches.length === 0" severity="warn" :closable="false" style="margin-top:0.75rem;">
          This project has no batches yet. <RouterLink to="/batches">Go to Batch Manager</RouterLink> to create batches before importing.
        </Message>
      </template>
    </Card>

    <!-- Step 2: Upload CSV -->
    <Card class="mb-card">
      <template #title>2 � Upload Assembly CSV</template>
      <template #content>
        <FileUpload mode="basic" accept=".csv" :auto="false" choose-label="Select CSV" @select="onFileSelect" />
        <div v-if="parseResult" style="margin-top:0.75rem;">
          <span class="badge-info">{{ parseResult.rows.length }} rows � {{ parseResult.headers.length }} columns</span>
        </div>
      </template>
    </Card>

    <!-- Step 3: Column Mapping -->
    <Card v-if="parseResult && selectedProject" class="mb-card">
      <template #title>3 � Map Columns</template>
      <template #content>
        <ColumnMapper
          :detected-columns="parseResult.headers"
          :auto-mapping="initialMapping"
          :unmapped-columns="parseResult.unmapped_columns"
          @mapping-updated="onMappingUpdated"
        />
        <div v-if="mappingWarnings.length" style="margin-top:0.75rem;">
          <Message v-for="w in mappingWarnings" :key="w" severity="warn" :closable="false">{{ w }}</Message>
        </div>
        <div style="margin-top:1rem;display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;">
          <InputText v-model="presetName" placeholder="Preset name..." style="width:200px;" />
          <Button label="Save as Preset" icon="pi pi-bookmark" size="small" text @click="savePreset" />
          <Select v-if="presets.length" v-model="selectedPreset" :options="presets" option-label="name"
            placeholder="Load preset..." style="min-width:180px;" @change="loadPreset" />
        </div>
      </template>
    </Card>

    <!-- Step 4: Preview -->
    <Card v-if="parseResult && selectedProject && hasRequiredMapping" class="mb-card">
      <template #title>4 � Preview</template>
      <template #content>
        <Button :label="$t('assemblyImport.previewBtn')" icon="pi pi-search" @click="doPreview" :loading="previewing" class="btn-preview" />

        <div v-if="previewData" style="margin-top:1rem;">
          <!-- Global warnings -->
          <Message v-if="previewData.warnings.length" severity="warn" :closable="false" style="margin-bottom:0.75rem;">
            <ul style="margin:0;padding-left:1.25rem;">
              <li v-for="w in previewData.warnings" :key="w">{{ w }}</li>
            </ul>
          </Message>
          <Message v-if="previewData.unresolved_batches.length" severity="error" :closable="false" style="margin-bottom:0.75rem;">
            Batch numbers not found in project: <strong>{{ previewData.unresolved_batches.join(', ') }}</strong>.
            Create these batches in Batch Manager first.
          </Message>
          <Message v-if="previewData.unresolved_designs.length" severity="error" :closable="false" style="margin-bottom:0.75rem;">
            Designs not found in project: <strong>{{ previewData.unresolved_designs.join(', ') }}</strong>.
            These rows will be skipped.
          </Message>

          <!-- Per-batch summary -->
          <div v-for="bp in previewData.batch_previews" :key="bp.batch_uuid" class="batch-preview-block">
            <div class="batch-preview-header">
              <span class="batch-name">{{ bp.batch_name }}</span>
              <Tag :severity="bp.blocked ? 'danger' : 'secondary'" :value="bp.local_state" />
              <span class="batch-counts">
                <span class="count-new">{{ bp.summary.new }} new</span>
                <span class="count-changed">{{ bp.summary.changed }} changed</span>
                <span class="count-identical">{{ bp.summary.identical }} identical</span>
              </span>
              <Button icon="pi pi-chevron-down" text size="small"
                @click="toggleBatch(bp.batch_uuid)" :label="expandedBatches.has(bp.batch_uuid) ? 'Collapse' : 'Expand'" />
            </div>
            <Message v-if="bp.blocked" severity="error" :closable="false">
              This batch is <strong>definitive</strong>. Import is blocked. Revert to provisional in Batch Manager to proceed.
            </Message>
            <DataTable v-if="expandedBatches.has(bp.batch_uuid)" :value="bp.rows" size="small" style="margin-top:0.5rem;">
              <Column field="design_name" :header="$t('assemblyImport.design')" />
              <Column field="status" :header="$t('assemblyImport.status')">
                <template #body="{ data }">
                  <Tag :severity="statusSev(data.status)" :value="data.status" />
                </template>
              </Column>
              <Column field="changed_fields" :header="$t('assemblyImport.changedFields')">
                <template #body="{ data }">
                  <span v-if="data.changed_fields.length" class="changed-fields">{{ data.changed_fields.join(', ') }}</span>
                  <span v-else class="dim">—</span>
                </template>
              </Column>
            </DataTable>
          </div>

          <!-- Execute -->
          <div v-if="canExecute" style="margin-top:1.25rem;">
            <ConfirmedButton
              :label="$t('assemblyImport.executeBtn')"
              icon="pi pi-check"
              :confirm-label="`I confirm \u2014 import ${totalNew} new + ${totalChanged} changed assemblies`"
              btn-class="btn-create"
              :loading="importing"
              @action="doImport" />
          </div>
        </div>
      </template>
    </Card>

    <!-- Results -->
    <Card v-if="importResults.length" class="mb-card">
      <template #title>Results</template>
      <template #content>
        <div class="results-summary">
          <span class="count-new">{{ importResults.filter(r=>r.status==='created').length }} created</span>
          <span class="count-changed">{{ importResults.filter(r=>r.status==='updated').length }} updated</span>
          <span class="count-identical">{{ importResults.filter(r=>r.status==='skipped').length }} skipped</span>
          <span class="count-error">{{ importResults.filter(r=>r.status==='error'||r.status==='blocked').length }} errors/blocked</span>
        </div>
        <DataTable :value="importResults.filter(r=>r.status==='error'||r.status==='blocked')" v-if="importResults.some(r=>r.status==='error'||r.status==='blocked')" size="small" style="margin-top:0.75rem;">
          <Column field="design_name" :header="$t('assemblyImport.design')" />
          <Column field="batch" :header="$t('assemblyImport.batch')" />
          <Column field="status" :header="$t('assemblyImport.status')">
            <template #body="{ data }"><Tag :severity="'danger'" :value="data.status" /></template>
          </Column>
          <Column field="reason" :header="$t('assemblyImport.reason')" />
        </DataTable>
        <Button label="Download Full Results CSV" icon="pi pi-download" text style="margin-top:0.75rem;" @click="downloadCsv" />
      </template>
    </Card>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { api } from '../api.js'
import { useProduuzitProjects } from '../composables/useProduuzitProjects.js'
import ColumnMapper from '../components/ColumnMapper.vue'
import ConfirmedButton from '../components/ConfirmedButton.vue'

const { projects, loading: projectsLoading, error: projectsError, fetchProjects } = useProduuzitProjects()
const selectedProject = ref(null)
const context = ref(null)
const parseResult = ref(null)
const columnMapping = ref({})
const previewData = ref(null)
const previewing = ref(false)
const importing = ref(false)
const importResults = ref([])
const confirmImport = ref(false)
const expandedBatches = ref(new Set())
const presetName = ref('')
const presets = ref([])
const selectedPreset = ref(null)

const initialMapping = computed(() => {
  if (!parseResult.value) return {}
  const m = {}
  // Merge auto-detected field cols and meta suggestions
  const col_map = parseResult.value.col_map || {}
  const meta = parseResult.value.meta_suggestions || {}
  for (const [canonical, csvCol] of Object.entries(col_map)) {
    m[csvCol] = canonical === 'design' ? 'design_name' : canonical === 'batch' ? 'batch_number' : canonical
  }
  for (const [csvCol, target] of Object.entries(meta)) {
    m[csvCol] = target
  }
  return m
})

const mappingWarnings = computed(() => {
  const warns = []
  const targets = Object.values(columnMapping.value)
  if (!targets.includes('design_name')) warns.push('No column mapped to Design Name — cannot resolve assemblies.')
  if (!targets.includes('batch_number')) warns.push('No column mapped to Batch Number — all rows will be unassigned.')
  return warns
})

const hasRequiredMapping = computed(() => {
  const targets = Object.values(columnMapping.value)
  return targets.includes('design_name') && targets.includes('batch_number')
})

const canExecute = computed(() => {
  if (!previewData.value) return false
  return previewData.value.batch_previews.some(bp => !bp.blocked && (bp.summary.new > 0 || bp.summary.changed > 0))
})

const totalNew = computed(() => previewData.value?.batch_previews.reduce((a, b) => a + (b.summary.new || 0), 0) ?? 0)
const totalChanged = computed(() => previewData.value?.batch_previews.reduce((a, b) => a + (b.summary.changed || 0), 0) ?? 0)

function loadProjects() { fetchProjects(true) }

async function onProjectChange() {
  context.value = null
  parseResult.value = null
  previewData.value = null
  importResults.value = []
  confirmImport.value = false
  if (!selectedProject.value) return
  const res = await api.get(`/api/assemblies/context?project_uuid=${selectedProject.value}`)
  context.value = res.data
  loadPresets()
}

async function loadPresets() {
  try {
    const res = await api.get('/api/config/presets')
    presets.value = res.data || []
  } catch {}
}

async function onFileSelect(e) {
  const file = e.files?.[0]
  if (!file) return
  const form = new FormData()
  form.append('file', file)
  const res = await api.post('/api/assemblies/parse-csv', form)
  parseResult.value = res.data
  previewData.value = null
  importResults.value = []
  confirmImport.value = false
}

function onMappingUpdated(m) {
  columnMapping.value = m
  previewData.value = null
  confirmImport.value = false
}

function toggleBatch(uuid) {
  const s = new Set(expandedBatches.value)
  s.has(uuid) ? s.delete(uuid) : s.add(uuid)
  expandedBatches.value = s
}

async function doPreview() {
  previewing.value = true
  previewData.value = null
  confirmImport.value = false
  try {
    const res = await api.post('/api/assemblies/preview-import', {
      project_uuid: selectedProject.value,
      column_mapping: columnMapping.value,
      rows: parseResult.value.rows,
    })
    previewData.value = res.data
    // Auto-expand batches with changes
    const s = new Set()
    for (const bp of res.data.batch_previews) {
      if (bp.summary.new > 0 || bp.summary.changed > 0 || bp.blocked) s.add(bp.batch_uuid)
    }
    expandedBatches.value = s
  } finally { previewing.value = false }
}

async function doImport() {
  importing.value = true
  try {
    const res = await api.post('/api/assemblies/import', {
      project_uuid: selectedProject.value,
      column_mapping: columnMapping.value,
      rows: parseResult.value.rows,
    })
    importResults.value = res.data
    previewData.value = null
  } finally { importing.value = false }
}

async function savePreset() {
  if (!presetName.value) return
  await api.post('/api/config/presets', { name: presetName.value, mapping: columnMapping.value })
  presetName.value = ''
  await loadPresets()
}

function loadPreset() {
  if (!selectedPreset.value) return
  const preset = presets.value.find(p => p.name === selectedPreset.value)
  if (preset) columnMapping.value = preset.mapping
}

function statusSev(s) {
  if (s === 'new') return 'success'
  if (s === 'changed') return 'warn'
  if (s === 'identical') return 'secondary'
  if (s === 'error') return 'danger'
  return 'info'
}

function downloadCsv() {
  const headers = ['design_name', 'batch', 'status', 'changed_fields', 'reason']
  const rows = importResults.value.map(r => [
    r.design_name || '', r.batch || '', r.status,
    (r.changed_fields || []).join(';'), r.reason || ''
  ])
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = 'import_results.csv'; a.click()
}
</script>

<style scoped>
.page-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 1.5rem; }
.mb-card { margin-bottom: 1.25rem; }
.badge-info { background: #e0f2fe; color: #0369a1; padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.8rem; }
.batch-preview-block { border: 1px solid #e5e7eb; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 0.75rem; }
.batch-preview-header { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.batch-name { font-weight: 600; font-size: 0.95rem; min-width: 100px; }
.batch-counts { display: flex; gap: 0.5rem; margin-left: auto; }
.count-new { color: #15803d; font-weight: 500; }
.count-changed { color: #b45309; font-weight: 500; }
.count-identical { color: #6b7280; }
.count-error { color: #dc2626; font-weight: 500; }
.changed-fields { font-size: 0.8rem; color: #b45309; font-family: monospace; }
.dim { color: #d1d5db; }
.results-summary { display: flex; gap: 1.5rem; padding: 0.5rem 0; }

</style>
