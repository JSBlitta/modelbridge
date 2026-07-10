<template>
  <div class="unified-import">
    <h2 class="page-title">Import</h2>
    <p class="page-hint">{{ $t('unified.hint') }}</p>

    <!-- ════════════════════════════════════════════
         PROJECT SELECTION
         ════════════════════════════════════════════ -->
    <Card class="mb-card">
      <template #title>Project</template>
      <template #content>
        <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem;">
          <Select v-model="project" :options="allProjects" option-label="name" option-value="uuid"
            :placeholder="$t('unified.selectProject')" style="min-width:280px" @change="onProjectChange" />
          <Button icon="pi pi-refresh" text size="small" @click="refreshProjects" :loading="refreshing" v-tooltip.top="'Refresh'" />
          <Tag v-if="context" severity="info" :value="`${context.designs?.length||0} designs · ${context.batches?.length||0} batches`" />
        </div>

        <Divider align="center"><span style="color:#9ca3af;font-size:0.8rem;">or create from CSV</span></Divider>

        <FileUpload mode="basic" accept=".csv" :auto="false" choose-label="Upload Superproject CSV" @select="onSuperCsvSelect" />
        <span v-if="superParseError" style="color:#dc2626;font-size:0.85rem;display:block;margin-top:0.4rem;">{{ superParseError }}</span>
        <span v-if="superNoProjects" style="color:#b45309;font-size:0.85rem;display:block;margin-top:0.4rem;">
          No <code>project</code> column detected. This CSV may not be a superproject file.
        </span>

        <div v-if="phaseSuggestions.length" style="margin-top:1rem;">
          <PhaseTable v-model:rows="phaseSuggestions" />
          <div style="margin-top:0.75rem;display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;">
            <Button label="Check in Produuzit" icon="pi pi-search" @click="checkProjects" :loading="checking" />
            <span v-if="checkDone" style="color:#374151;">{{ newProjectCount }} new, {{ foundProjectCount }} found</span>
          </div>
        </div>

        <div v-if="checkDone && newProjectCount > 0" style="margin-top:1rem;">
          <Message severity="warn" :closable="false" size="small">
            {{ newProjectCount }} new project(s) will be created in Produuzit.
          </Message>
          <ConfirmationTable
            :rows="confirmProjectRows"
            :columns="[{field:'project_key',header:'Project'},{field:'superproject',header:'Superproject'},{field:'suggested_phase',header:'Phase'}]"
            status-field="status"
            style="margin-top:0.75rem;"
          />
          <div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.75rem;">
            <Checkbox v-model="confirmCreateProjects" :binary="true" input-id="confirm-projects" />
            <label for="confirm-projects" style="cursor:pointer;font-size:0.85rem;">
              I confirm — create {{ newProjectCount }} project(s) in Produuzit
            </label>
          </div>
          <Button label="Create Projects" icon="pi pi-plus" severity="success"
            @click="createProjects" :loading="creatingProjects" :disabled="!confirmCreateProjects"
            style="margin-top:0.5rem;" />
        </div>

        <div v-if="createProjectResults.length" style="margin-top:0.75rem;">
          <DataTable :value="createProjectResults" size="small">
            <Column field="project_key" :header="$t('unified.project')" />
            <Column field="status" :header="$t('unified.status')">
              <template #body="{ data }">
                <Tag :severity="data.status==='created'?'success':data.status==='error'?'danger':'secondary'" :value="data.status" />
              </template>
            </Column>
            <Column field="error" :header="$t('unified.error')" />
          </DataTable>
        </div>

        <div v-if="checkDone && foundProjectCount > 0" style="margin-top:1rem;">
          <Message severity="info" :closable="false" size="small">
            {{ foundProjectCount }} project(s) already exist. Add phase &amp; create batches?
          </Message>
          <Button label="Add Phase &amp; Batches" icon="pi pi-plus-circle" severity="help"
            @click="addPhasesAndBatches" :loading="addingPhasesBatches"
            style="margin-top:0.5rem;" />
        </div>
      </template>
    </Card>

    <!-- ════════════════════════════════════════════
         ASSEMBLY IMPORT
         ════════════════════════════════════════════ -->
    <Card v-if="project" class="mb-card">
      <template #title>Assembly Import</template>
      <template #content>
        <div style="margin-bottom:0.75rem;">
          <label style="display:block;font-size:0.8rem;font-weight:600;color:#6b7280;margin-bottom:0.25rem;">Assembly CSV</label>
          <FileUpload mode="basic" accept=".csv" :auto="false" choose-label="Select CSV" @select="onAsmFileSelect" />
          <span v-if="parseResult" style="background:#e0f2fe;color:#0369a1;padding:0.2rem 0.5rem;border-radius:999px;font-size:0.78rem;display:inline-block;margin-top:0.4rem;">
            {{ parseResult.rows.length }} rows · {{ parseResult.headers.length }} columns
          </span>
        </div>

        <div v-if="parseResult" style="margin-bottom:0.75rem;">
          <label style="display:block;font-size:0.8rem;font-weight:600;color:#6b7280;margin-bottom:0.25rem;">Column Mapping</label>
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

        <div v-if="parseResult" style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem;">
          <InputText v-model="presetName" placeholder="Preset name..." style="width:180px;" size="small" />
          <Button label="Save Preset" icon="pi pi-bookmark" size="small" text @click="savePreset" />
          <Select v-if="presets.length" v-model="selectedPreset" :options="presets" option-label="name"
            placeholder="Load preset..." style="min-width:160px;" size="small" @change="loadPreset" />
        </div>

        <div v-if="hasRequiredMapping">
          <Button label="Check &amp; Preview" icon="pi pi-search" @click="doPreview" :loading="previewing" />
        </div>

        <div v-if="previewData" style="margin-top:0.75rem;">
          <!-- ══ UUID mode: flat row preview ══ -->
          <template v-if="previewData.uuid_mode">
            <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:0.5rem;">
              <span style="color:#15803d;font-weight:600;">{{ totalChanged }} changed</span>
              <span style="color:#6b7280;">{{ totalIdentical }} identical</span>
              <span v-if="totalBlocked" style="color:#dc2626;font-weight:600;">{{ totalBlocked }} errors</span>
            </div>

            <Message v-if="previewData.has_errors" severity="error" :closable="false" size="small">
              Validation errors detected — project/superproject mismatch or UUIDs not found. Cannot execute import.
            </Message>
            <Message v-if="previewData.warnings?.length" severity="warn" :closable="false" size="small">
              {{ previewData.warnings.join(' · ') }}
            </Message>

            <div style="max-height:300px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:6px;">
              <DataTable :value="previewData.row_previews" size="small">
                <Column field="uuid" header="UUID">
                  <template #body="{ data }">
                    <code style="font-size:0.75rem;">{{ data.uuid?.substring(0,8) }}…</code>
                  </template>
                </Column>
                <Column field="design_name" header="Design" />
                <Column field="client_order_id" header="Order ID" />
                <Column field="status" header="Status">
                  <template #body="{ data }">
                    <Tag :severity="data.status==='error'?'danger':data.status==='changed'?'warn':'secondary'" :value="data.status" />
                  </template>
                </Column>
                <Column field="changed_fields" header="Changed">
                  <template #body="{ data }">
                    <span v-if="data.changed_fields?.length">{{ data.changed_fields.join(', ') }}</span>
                    <span v-else style="color:#9ca3af;">—</span>
                  </template>
                </Column>
                <Column field="reason" header="Reason">
                  <template #body="{ data }">
                    <span v-if="data.reason" style="color:#dc2626;font-size:0.8rem;">{{ data.reason }}</span>
                  </template>
                </Column>
              </DataTable>
            </div>
          </template>

          <!-- ══ Standard mode: batch-grouped preview ══ -->
          <template v-else>
            <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:0.5rem;">
              <span style="color:#15803d;font-weight:600;">{{ totalNew }} new</span>
              <span style="color:#b45309;font-weight:600;">{{ totalChanged }} changed</span>
              <span style="color:#6b7280;">{{ totalIdentical }} identical</span>
              <span v-if="totalBlocked" style="color:#dc2626;font-weight:600;">{{ totalBlocked }} blocked</span>
            </div>

            <Message v-if="previewData.warnings?.length" severity="warn" :closable="false" size="small">
              {{ previewData.warnings.join(' · ') }}
            </Message>
            <Message v-if="previewData.unresolved_batches?.length" severity="error" :closable="false" size="small">
              Batch numbers not in project: {{ previewData.unresolved_batches.join(', ') }}
            </Message>
            <Message v-if="previewData.unresolved_designs?.length" severity="error" :closable="false" size="small">
              Designs not found: {{ previewData.unresolved_designs.slice(0,5).join(', ') }}{{ previewData.unresolved_designs.length>5?'…':'' }}
            </Message>

            <div v-for="bp in previewData.batch_previews" :key="bp.batch_uuid" style="display:flex;gap:0.5rem;align-items:center;padding:0.25rem 0;border-bottom:1px solid #f3f4f6;">
              <Tag :severity="bp.blocked?'danger':'secondary'" :value="bp.batch_name" />
              <span style="color:#15803d;">{{ bp.summary.new }}↑</span>
              <span style="color:#b45309;">{{ bp.summary.changed }}~</span>
              <span style="color:#6b7280;">{{ bp.summary.identical }}=</span>
              <Tag v-if="bp.blocked" severity="danger" value="BLOCKED" />
            </div>
          </template>

          <div v-if="canExecute" style="margin-top:0.75rem;">
            <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;">
              <Checkbox v-model="confirmImport" :binary="true" input-id="confirm-import" />
              <label for="confirm-import" style="cursor:pointer;font-size:0.85rem;">
                I confirm — {{ isUuidMode ? `update ${totalChanged} assemblies` : `import ${totalNew} new + ${totalChanged} changed assemblies` }}
              </label>
            </div>
            <Button label="Execute Import" icon="pi pi-bolt" severity="success"
              @click="doImport" :loading="importing" :disabled="!confirmImport" />
          </div>
        </div>

        <div v-if="importResults.length" style="margin-top:0.75rem;">
          <div style="display:flex;gap:1rem;flex-wrap:wrap;">
            <span v-if="!isUuidMode" style="color:#15803d;font-weight:600;">{{ importResults.filter(r=>r.status==='created').length }} created</span>
            <span style="color:#b45309;font-weight:600;">{{ importResults.filter(r=>r.status==='updated').length }} updated</span>
            <span style="color:#6b7280;">{{ importResults.filter(r=>r.status==='skipped').length }} skipped</span>
            <span style="color:#dc2626;font-weight:600;">{{ importResults.filter(r=>r.status==='error'||r.status==='blocked').length }} errors</span>
          </div>
          <DataTable v-if="importResults.some(r=>r.status==='error'||r.status==='blocked')"
            :value="importResults.filter(r=>r.status==='error'||r.status==='blocked')" size="small" style="margin-top:0.5rem;">
            <Column field="uuid" header="UUID" v-if="isUuidMode">
              <template #body="{ data }">
                <code style="font-size:0.75rem;">{{ data.uuid?.substring(0,8) }}…</code>
              </template>
            </Column>
            <Column field="design_name" :header="$t('unified.design')" v-if="!isUuidMode" />
            <Column field="batch" :header="$t('unified.batch')" v-if="!isUuidMode" />
            <Column field="reason" :header="$t('unified.reason')" />
          </DataTable>
          <Button label="Download CSV" icon="pi pi-download" text size="small" style="margin-top:0.5rem;" @click="downloadCsv" />
        </div>
      </template>
    </Card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { api } from '../api.js'
import PhaseTable from '../components/PhaseTable.vue'
import ConfirmationTable from '../components/ConfirmationTable.vue'
import ColumnMapper from '../components/ColumnMapper.vue'

// ── Project ──
const allProjects = ref([])
const project = ref(null)
const context = ref(null)
const refreshing = ref(false)

onMounted(async () => {
  try {
    const res = await api.get('/api/projects/?limit=100')
    allProjects.value = (res.data.results || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  } catch { /* ignore */ }
})

async function refreshProjects() {
  refreshing.value = true
  try {
    const res = await api.get('/api/projects/?limit=100')
    allProjects.value = (res.data.results || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  } finally { refreshing.value = false }
}

async function onProjectChange() {
  context.value = null; resetImport()
  if (!project.value) return
  try {
    const res = await api.get(`/api/assemblies/context?project_uuid=${project.value}`)
    context.value = res.data
    loadPresets()
  } catch { /* ignore */ }
}

// ── Superproject CSV → Create Projects ──
const phaseSuggestions = ref([])
const superParseError = ref('')
const superNoProjects = ref(false)
const checking = ref(false)
const checkDone = ref(false)
const createProjectResults = ref([])
const confirmCreateProjects = ref(false)
const creatingProjects = ref(false)

const newProjectCount = computed(() => phaseSuggestions.value.filter(r => r.status === 'new').length)
const foundProjectCount = computed(() => phaseSuggestions.value.filter(r => r.status === 'found').length)
const confirmProjectRows = computed(() => phaseSuggestions.value.filter(r => r.status === 'new'))

async function onSuperCsvSelect(e) {
  const file = e.files?.[0]; if (!file) return
  phaseSuggestions.value = []; superParseError.value = ''; superNoProjects.value = false
  checkDone.value = false; createProjectResults.value = []; confirmCreateProjects.value = false
  const form = new FormData(); form.append('file', file)
  try {
    const res = await api.post('/api/csv/parse', form)
    const suggestions = res.data.phase_suggestions || []
    if (!suggestions.length) { superNoProjects.value = true; return }
    phaseSuggestions.value = suggestions
  } catch (err) {
    superParseError.value = err.response?.data?.error || 'Failed to parse CSV.'
  }
}

function toProjectDefs(rows) {
  return rows.map(r => ({
    project_key: r.project_key,
    superproject: r.superproject || '',
    letter: r.letter || '',
    description: r.description || null,
    suggested_suffix: r.suggested_suffix || '',
    phase: r.suggested_phase || '',
  }))
}

async function checkProjects() {
  checking.value = true; checkDone.value = false; confirmCreateProjects.value = false
  try {
    const res = await api.post('/api/projects/find-or-create', toProjectDefs(phaseSuggestions.value))
    const results = res.data || []
    const foundMap = new Map(results.filter(r => r.status === 'found').map(r => [r.project_key, r.existing?.uuid]))
    for (const row of phaseSuggestions.value) {
      if (foundMap.has(row.project_key)) {
        row.status = 'found'
        row.project_uuid = foundMap.get(row.project_key)
      } else {
        row.status = 'new'
      }
    }
    checkDone.value = true
  } finally { checking.value = false }
}

async function createProjects() {
  creatingProjects.value = true
  try {
    const toCreate = phaseSuggestions.value.filter(r => r.status === 'new')
    const res = await api.post('/api/projects/create', toProjectDefs(toCreate))
    createProjectResults.value = res.data
    confirmCreateProjects.value = false
    await refreshProjects()
  } finally { creatingProjects.value = false }
}

// ── Add phase + batches for found projects ──
const addingPhasesBatches = ref(false)

async function addPhasesAndBatches() {
  addingPhasesBatches.value = true
  try {
    const foundProjects = phaseSuggestions.value.filter(r => r.status === 'found' && r.project_uuid)
    const phaseBatchesResults = []
    for (const p of foundProjects) {
      const phase = p.suggested_phase || ''
      try {
        await api.post(`/api/projects/${p.project_uuid}/phases`, { phase })
      } catch { /* phase may already exist — ignore */ }

      const batches = (p.batches || []).map(b => ({ name: String(b), phase }))
      if (batches.length) {
        try {
          const res = await api.post('/api/batches/create', { project_uuid: p.project_uuid, batches })
          phaseBatchesResults.push(...(res.data || []))
        } catch (e) {
          phaseBatchesResults.push({ project_key: p.project_key, status: 'error', error: String(e) })
        }
      }
    }
    createProjectResults.value = phaseBatchesResults
    await refreshProjects()
  } finally { addingPhasesBatches.value = false }
}

// ── Assembly Import ──
const parseResult = ref(null)
const columnMapping = ref({})
const previewData = ref(null)
const previewing = ref(false)
const importing = ref(false)
const importResults = ref([])
const confirmImport = ref(false)
const presetName = ref('')
const presets = ref([])
const selectedPreset = ref(null)

function resetImport() {
  parseResult.value = null; previewData.value = null; importResults.value = []; confirmImport.value = false
}

const initialMapping = computed(() => {
  if (!parseResult.value) return {}
  const m = {}
  for (const [canonical, csvCol] of Object.entries(parseResult.value.col_map || {})) {
    m[csvCol] = canonical === 'design' ? 'design_name' : canonical === 'batch' ? 'batch_number' : canonical
  }
  for (const [csvCol, target] of Object.entries(parseResult.value.meta_suggestions || {})) m[csvCol] = target
  return m
})

const isUuidMode = computed(() => Object.values(columnMapping.value).includes('uuid'))

const mappingWarnings = computed(() => {
  const w = []
  const targets = Object.values(columnMapping.value)
  if (isUuidMode.value) {
    if (!targets.includes('uuid')) w.push('No UUID column mapped.')
    return w
  }
  if (!targets.includes('design_name')) w.push('No Design Name column mapped.')
  if (!targets.includes('batch_number')) w.push('No Batch Number column mapped.')
  return w
})

const hasRequiredMapping = computed(() => {
  if (!project.value || !parseResult.value) return false
  if (isUuidMode.value) return Object.values(columnMapping.value).includes('uuid')
  return Object.values(columnMapping.value).includes('design_name') &&
    Object.values(columnMapping.value).includes('batch_number')
})

const totalNew = computed(() => {
  if (previewData.value?.uuid_mode) return 0
  return previewData.value?.batch_previews?.reduce((a,b) => a+(b.summary.new||0), 0) ?? 0
})
const totalChanged = computed(() => {
  if (previewData.value?.uuid_mode) return previewData.value?.summary?.changed ?? 0
  return previewData.value?.batch_previews?.reduce((a,b) => a+(b.summary.changed||0), 0) ?? 0
})
const totalIdentical = computed(() => {
  if (previewData.value?.uuid_mode) return previewData.value?.summary?.identical ?? 0
  return previewData.value?.batch_previews?.reduce((a,b) => a+(b.summary.identical||0), 0) ?? 0
})
const totalBlocked = computed(() => {
  if (previewData.value?.uuid_mode) return previewData.value?.summary?.errors ?? 0
  return previewData.value?.batch_previews?.filter(b=>b.blocked).reduce((a,b)=>a+(b.rows?.length||0), 0) ?? 0
})

const canExecute = computed(() => {
  if (previewData.value?.uuid_mode) {
    return !previewData.value.has_errors && (previewData.value.summary?.changed > 0)
  }
  return previewData.value?.batch_previews?.some(bp => !bp.blocked && (bp.summary.new > 0 || bp.summary.changed > 0))
})

async function loadPresets() {
  try { const res = await api.get('/api/config/presets'); presets.value = res.data || [] } catch {}
}

async function onAsmFileSelect(e) {
  const file = e.files?.[0]; if (!file) return
  const form = new FormData(); form.append('file', file)
  const res = await api.post('/api/assemblies/parse-csv', form)
  parseResult.value = res.data; resetImport()
}

function onMappingUpdated(m) { columnMapping.value = m; previewData.value = null; confirmImport.value = false }

async function doPreview() {
  previewing.value = true; previewData.value = null; confirmImport.value = false
  try {
    const res = await api.post('/api/assemblies/preview-import', {
      project_uuid: project.value,
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
      project_uuid: project.value,
      column_mapping: columnMapping.value,
      rows: parseResult.value.rows,
    })
    importResults.value = res.data; previewData.value = null
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

function downloadCsv() {
  const isUuid = isUuidMode.value
  const headers = isUuid ? ['uuid','status','fields','reason'] : ['design_name','batch','status','reason']
  const rows = importResults.value.map(r => {
    if (isUuid) return [r.uuid||'', r.status, (r.fields||[]).join(';'), r.reason||'']
    return [r.design_name||'', r.batch||'', r.status, r.reason||'']
  })
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = 'import_results.csv'; a.click()
}
</script>

<style scoped>
.unified-import { max-width: 1100px; }
.page-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; }
.page-hint { color: #9ca3af; font-size: 0.85rem; margin-bottom: 1.5rem; }
.mb-card { margin-bottom: 1.25rem; }
</style>
