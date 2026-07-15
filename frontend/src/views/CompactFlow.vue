<template>
  <div class="compact-flow">
    <div class="compact-header">
      <h2>{{ $t('compactFlow.title') }}</h2>
      <span class="compact-hint">Upload → Map → Confirm → Done</span>
    </div>

    <!-- Row 1: Project + File side by side -->
    <div class="row-two">
      <div class="panel">
        <label class="panel-label">Project</label>
        <Select v-model="selectedProject" :options="projects" option-label="name" option-value="uuid"
          placeholder="Select project..." class="wide" @change="onProjectChange" />
        <Tag v-if="context && context.batches.length" severity="secondary" style="margin-top:0.4rem;"
          :value="`${context.designs.length} designs · ${context.batches.length} batches`" />
        <Message v-if="projectsLoaded && projects.length === 0" severity="info" :closable="false" size="small" style="margin-top:0.4rem;">
          No projects found. <RouterLink to="/">Create projects first</RouterLink>.
        </Message>
        <Message v-if="context && context.batches.length === 0" severity="warn" :closable="false" size="small" style="margin-top:0.4rem;">
          No batches in this project. <RouterLink to="/batches">Create batches first</RouterLink>.
        </Message>
      </div>
      <div class="panel">
        <label class="panel-label">CSV File</label>
        <FileUpload mode="basic" accept=".csv" :auto="false" choose-label="Select CSV" @select="onFileSelect" />
        <span v-if="parseResult" class="badge-info" style="margin-top:0.4rem;">
          {{ parseResult.rows.length }} rows · {{ parseResult.headers.length }} columns
        </span>
      </div>
    </div>

    <!-- Column mapping: compact table -->
    <div v-if="parseResult && selectedProject" class="panel mt-sm">
      <label class="panel-label">Column Mapping</label>
      <ColumnMapper
        :detected-columns="parseResult.headers"
        :auto-mapping="initialMapping"
        :unmapped-columns="parseResult.unmapped_columns"
        :preview-rows="parseResult.preview"
        @mapping-updated="onMappingUpdated"
      />
      <div v-if="mappingWarnings.length" style="margin-top:0.5rem;">
        <Message v-for="w in mappingWarnings" :key="w" severity="warn" :closable="false" size="small">{{ w }}</Message>
      </div>
    </div>

    <!-- One-click check + summary banner -->
    <div v-if="hasRequiredMapping" class="panel mt-sm">
      <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;">
        <Button label="Check & Preview" icon="pi pi-search" @click="doPreview" :loading="previewing" />
        <span v-if="previewData" class="summary-chips">
          <span class="chip-new">{{ totalNew }} new</span>
          <span class="chip-changed">{{ totalChanged }} changed</span>
          <span class="chip-identical">{{ totalIdentical }} identical</span>
          <span v-if="totalBlocked" class="chip-blocked">{{ totalBlocked }} blocked</span>
          <span v-if="previewData.unresolved_batches.length" class="chip-blocked">
            {{ previewData.unresolved_batches.length }} unresolved batches
          </span>
        </span>
      </div>

      <!-- Warnings / errors -->
      <div v-if="previewData" style="margin-top:0.5rem;">
        <Message v-if="previewData.warnings.length" severity="warn" :closable="false" size="small">
          {{ previewData.warnings.join(' · ') }}
        </Message>
        <Message v-if="previewData.unresolved_batches.length" severity="error" :closable="false" size="small">
          Batch numbers not in project: {{ previewData.unresolved_batches.join(', ') }}
        </Message>
        <Message v-if="previewData.unresolved_designs.length" severity="error" :closable="false" size="small">
          Designs not found: {{ previewData.unresolved_designs.slice(0, 5).join(', ') }}{{ previewData.unresolved_designs.length > 5 ? '…' : '' }}
        </Message>

        <!-- Batch state list: only those with issues or changes -->
        <div v-for="bp in previewData.batch_previews" :key="bp.batch_uuid" class="compact-batch-row">
          <Tag :severity="bp.blocked ? 'danger' : 'secondary'" :value="bp.batch_name" />
          <span class="chip-new">{{ bp.summary.new }}↑</span>
          <span class="chip-changed">{{ bp.summary.changed }}~</span>
          <span class="chip-identical">{{ bp.summary.identical }}=</span>
          <Tag v-if="bp.blocked" severity="danger" value="BLOCKED (definitive)" />
        </div>

        <!-- Execute -->
        <div v-if="canExecute" style="margin-top:0.75rem;">
          <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;">
            <Checkbox v-model="confirmImport" :binary="true" input-id="confirm-compact-import" />
            <label for="confirm-compact-import" style="cursor:pointer;font-size:0.85rem;">
              I confirm — import {{ totalNew }} new + {{ totalChanged }} changed assemblies
            </label>
          </div>
          <Button label="Execute Import" icon="pi pi-bolt" severity="success" @click="doImport" :loading="importing" :disabled="!confirmImport" />
        </div>
      </div>
    </div>

    <!-- Result bar -->
    <div v-if="importResults.length" class="panel mt-sm">
      <div class="summary-chips">
        <span class="chip-new">{{ importResults.filter(r=>r.status==='created').length }} created</span>
        <span class="chip-changed">{{ importResults.filter(r=>r.status==='updated').length }} updated</span>
        <span class="chip-identical">{{ importResults.filter(r=>r.status==='skipped').length }} skipped</span>
        <span v-if="importResults.some(r=>r.status==='error'||r.status==='blocked')" class="chip-blocked">
          {{ importResults.filter(r=>r.status==='error'||r.status==='blocked').length }} errors
        </span>
      </div>
      <DataTable v-if="importResults.some(r=>r.status==='error'||r.status==='blocked')"
        :value="importResults.filter(r=>r.status==='error'||r.status==='blocked')"
        size="small" style="margin-top:0.5rem;">
        <Column field="design_name" :header="$t('compactFlow.design')" />
        <Column field="batch" :header="$t('compactFlow.batch')" />
        <Column field="reason" :header="$t('compactFlow.reason')" />
      </DataTable>
      <Button label="Download CSV" icon="pi pi-download" text size="small" style="margin-top:0.5rem;" @click="downloadCsv" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { api } from '../api.js'
import ColumnMapper from '../components/ColumnMapper.vue'

const projects = ref([])
const selectedProject = ref(null)
const context = ref(null)
const projectsLoaded = ref(false)
const parseResult = ref(null)
const columnMapping = ref({})
const previewData = ref(null)
const previewing = ref(false)
const importing = ref(false)
const importResults = ref([])
const confirmImport = ref(false)

const initialMapping = computed(() => {
  if (!parseResult.value) return {}
  const m = {}
  for (const [canonical, csvCol] of Object.entries(parseResult.value.col_map || {})) {
    m[csvCol] = canonical === 'design' ? 'design_name' : canonical === 'batch' ? 'batch_number' : canonical
  }
  for (const [csvCol, target] of Object.entries(parseResult.value.meta_suggestions || {})) {
    m[csvCol] = target
  }
  return m
})

const mappingWarnings = computed(() => {
  const targets = Object.values(columnMapping.value)
  const w = []
  if (!targets.includes('design_name')) w.push('No Design Name column mapped.')
  if (!targets.includes('batch_number')) w.push('No Batch Number column mapped.')
  return w
})

const hasRequiredMapping = computed(() =>
  parseResult.value && selectedProject.value &&
  Object.values(columnMapping.value).includes('design_name') &&
  Object.values(columnMapping.value).includes('batch_number')
)

const totalNew = computed(() => previewData.value?.batch_previews.reduce((a, b) => a + b.summary.new, 0) ?? 0)
const totalChanged = computed(() => previewData.value?.batch_previews.reduce((a, b) => a + b.summary.changed, 0) ?? 0)
const totalIdentical = computed(() => previewData.value?.batch_previews.reduce((a, b) => a + b.summary.identical, 0) ?? 0)
const totalBlocked = computed(() => previewData.value?.batch_previews.filter(b => b.blocked).reduce((a, b) => a + b.rows.length, 0) ?? 0)

const canExecute = computed(() => previewData.value?.batch_previews.some(bp => !bp.blocked && (bp.summary.new > 0 || bp.summary.changed > 0)))

onMounted(async () => {
  const res = await api.get('/api/projects?limit=100')
  projects.value = res.data.results || []
  projectsLoaded.value = true
})

async function onProjectChange() {
  context.value = null; parseResult.value = null; previewData.value = null; importResults.value = []; confirmImport.value = false
  if (!selectedProject.value) return
  const res = await api.get(`/api/assemblies/context?project_uuid=${selectedProject.value}`)
  context.value = res.data
}

async function onFileSelect(e) {
  const file = e.files?.[0]; if (!file) return
  const form = new FormData(); form.append('file', file)
  const res = await api.post('/api/assemblies/parse-csv', form)
  parseResult.value = res.data; previewData.value = null; importResults.value = []; confirmImport.value = false
}

function onMappingUpdated(m) { columnMapping.value = m; previewData.value = null; confirmImport.value = false }

async function doPreview() {
  previewing.value = true; previewData.value = null; confirmImport.value = false
  try {
    const res = await api.post('/api/assemblies/preview-import', {
      project_uuid: selectedProject.value,
      column_mapping: columnMapping.value,
      rows: parseResult.value.rows,
    })
    previewData.value = res.data
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
    importResults.value = res.data; previewData.value = null
  } finally { importing.value = false }
}

function downloadCsv() {
  const headers = ['design_name', 'batch', 'status', 'reason']
  const rows = importResults.value.map(r => [r.design_name||'', r.batch||'', r.status, r.reason||''])
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = 'import_results.csv'; a.click()
}
</script>

<style scoped>
.compact-flow { max-width: 1100px; }
.compact-header { display: flex; align-items: baseline; gap: 1rem; margin-bottom: 1rem; }
.compact-header h2 { font-size: 1.4rem; font-weight: 700; }
.compact-hint { color: #9ca3af; font-size: 0.85rem; }
.row-two { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.panel { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem; }
.panel-label { display: block; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 0.5rem; }
.wide { width: 100%; }
.mt-sm { margin-top: 0.75rem; }
.badge-info { background: #e0f2fe; color: #0369a1; padding: 0.2rem 0.5rem; border-radius: 999px; font-size: 0.78rem; display: inline-block; }
.summary-chips { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
.chip-new { color: #15803d; font-weight: 600; font-size: 0.9rem; }
.chip-changed { color: #b45309; font-weight: 600; font-size: 0.9rem; }
.chip-identical { color: #6b7280; font-size: 0.9rem; }
.chip-blocked { color: #dc2626; font-weight: 600; font-size: 0.9rem; }
.compact-batch-row { display: flex; gap: 0.5rem; align-items: center; padding: 0.3rem 0; border-bottom: 1px solid #f3f4f6; }
</style>
