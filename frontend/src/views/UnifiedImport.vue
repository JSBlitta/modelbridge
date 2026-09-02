<template>
  <div class="unified-import">
    <h2 class="page-title">{{ $t('unified.title') }}</h2>
    <p class="page-hint">{{ $t('unified.hint') }}</p>

    <!-- PROJECT SELECTION -->
    <Card class="mb-card">
      <template #title>{{ $t('unified.projectSection') }}</template>
      <template #content>
        <div class="flex-row gap-lg" style="margin-bottom:0.75rem;">
          <Select v-model="project" :options="allProjects" option-label="name" option-value="uuid"
            :placeholder="$t('unified.selectProject')" style="min-width:280px" @change="onProjectChange" />
          <Button icon="pi pi-refresh" text size="small" @click="refreshProjects" :loading="refreshing" v-tooltip.top="$t('trimble.reloadProjects')" />
          <Tag v-if="context" severity="info" :value="`${context.designs?.length||0} designs \u00b7 ${context.batches?.length||0} batches`" />
        </div>

        <Divider align="center"><span style="color:#9ca3af;font-size:0.8rem;">{{ $t('unified.orCreateFromCsv') }}</span></Divider>

        <Button :label="$t('unified.uploadSuperproject')" icon="pi pi-upload" severity="secondary" size="small"
          @click="triggerSuperCsv" />
        <input ref="superFileInput" type="file" accept=".csv" style="display:none" @change="onSuperCsvInput" />
        <span v-if="superParseError" style="color:#dc2626;font-size:0.85rem;display:block;margin-top:0.4rem;">{{ superParseError }}</span>
        <span v-if="superNoProjects" style="color:#b45309;font-size:0.85rem;display:block;margin-top:0.4rem;">
          {{ $t('unified.noProjectColumn') }}
        </span>

        <div v-if="phaseSuggestions.length" style="margin-top:1rem;">
          <PhaseTable v-model:rows="phaseSuggestions" />
          <div class="mt-sm flex-row gap-md">
            <Button :label="$t('unified.checkBtn')" icon="pi pi-search" @click="doCheck" :loading="checking" class="btn-preview" />
          </div>
          <div v-if="checkDone" class="mt-sm">
            <div v-for="row in phaseSuggestions" :key="row.project_key"
                 class="batch-preview-row gap-xs" style="font-size:0.82rem;flex-wrap:wrap;">
              <code style="font-weight:600;min-width:160px;">{{ row.project_key }}</code>
              <Tag v-if="row.superproject_found != null"
                   :severity="row.superproject_found ? 'success' : 'secondary'"
                   :value="row.superproject_found ? $t('unified.superprojectFound') : $t('unified.superprojectNew')" />
              <Tag :severity="row.status === 'found' ? 'success' : 'secondary'"
                   :value="row.status === 'found' ? $t('unified.projectFound') : $t('unified.projectNew')" />
              <Tag v-if="row.phase_exists != null"
                   :severity="row.phase_exists ? 'success' : 'secondary'"
                   :value="row.phase_exists ? $t('unified.phaseExists', { phase: row.suggested_phase }) : $t('unified.phaseNew', { phase: row.suggested_phase })" />
              <Tag v-if="row.batches_found !== undefined && row.batches_found.length"
                   severity="success"
                   :value="$t('unified.batchesFound', { found: row.batches_found.length })" />
              <Tag v-if="row.batches_missing && row.batches_missing.length"
                   severity="secondary"
                   :value="$t('unified.batchesNew', { count: row.batches_missing.length })" />
            </div>
          </div>
        </div>

        <div v-if="checkDone && newProjectCount > 0" style="margin-top:1rem;">
          <Message severity="warn" :closable="false" size="small">
            {{ $t('unified.newProjects', { count: newProjectCount }) }}
          </Message>
          <ConfirmationTable
            :rows="confirmProjectRows"
            :columns="[{field:'project_key',header:$t('unified.project')},{field:'superproject',header:$t('unified.superproject')},{field:'suggested_phase',header:$t('unified.phase')}]"
            status-field="status"
            :show-actions="false"
            class="mt-sm"
            />
          <ConfirmedButton
            :label="$t('unified.createProjectsBtn')"
            icon="pi pi-plus"
            :confirm-label="$t('unified.confirmCreateProjects', { count: newProjectCount })"
            btn-class="btn-create"
            :loading="creatingProjects"
            @action="createProjects"
            style="margin-top:0.5rem;" />
        </div>

        <div v-if="createProjectResults.length" class="mt-sm">
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

        <div v-if="checkDone && foundProjectCount > 0 && hasMissingItems" style="margin-top:1rem;">
          <Message severity="info" :closable="false" size="small">
            {{ $t('unified.foundProjectInfo', { count: foundProjectCount }) }}
          </Message>
          <ConfirmedButton
            :label="$t('unified.createPhaseBatchesBtn')"
            icon="pi pi-plus-circle"
            :confirm-label="$t('unified.confirmCreateItems', { items: createItemsLabel })"
            btn-class="btn-create"
            :loading="addingPhasesBatches"
            @action="addPhasesAndBatches"
            style="margin-top:0.5rem;" />
        </div>
      </template>
    </Card>

    <!-- ASSEMBLY IMPORT -->
    <Card v-if="project" class="mb-card">
      <template #title>{{ $t('unified.assemblySection') }}</template>
      <template #content>
        <Message severity="info" :closable="false" size="small" style="margin-bottom:0.75rem;">
          {{ $t('unified.csvInstructions') }}
        </Message>
        <div style="margin-bottom:0.75rem;">
          <label style="display:block;font-size:0.8rem;font-weight:600;color:#6b7280;margin-bottom:0.25rem;">{{ $t('unified.assemblyCsv') }}</label>
          <FileUpload mode="basic" accept=".csv" :auto="false" :choose-label="$t('unified.selectCsv')" @select="onAsmFileSelect" />
          <span v-if="parseResult" class="badge-info" style="margin-top:0.4rem;">
            {{ parseResult.rows.length }} rows \u00b7 {{ parseResult.headers.length }} columns
          </span>
        </div>

        <div v-if="parseResult" style="margin-bottom:0.75rem;">
          <label style="display:block;font-size:0.8rem;font-weight:600;color:#6b7280;margin-bottom:0.25rem;">{{ $t('unified.columnMapping') }}</label>
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

        <div v-if="parseResult" class="flex-row gap-md" style="margin-bottom:0.75rem;">
          <InputText v-model="presetName" :placeholder="$t('unified.presetName')" style="width:180px;" size="small" />
          <Button :label="$t('unified.savePreset')" icon="pi pi-bookmark" size="small" text @click="savePreset" />
          <Select v-if="presets.length" v-model="selectedPreset" :options="presets" option-label="name"
            :placeholder="$t('unified.loadPreset')" style="min-width:160px;" size="small" @change="loadPreset" />
        </div>

        <div v-if="hasRequiredMapping">
          <Button :label="$t('unified.previewBtn')" icon="pi pi-search" @click="doPreview" :loading="previewing" class="btn-preview" />
        </div>

        <div v-if="previewData" class="mt-sm">
          <!-- UUID mode: flat row preview -->
          <template v-if="previewData.uuid_mode">
            <div class="flex-row gap-md mb-sm">
              <span class="text-changed">{{ totalChanged }} {{ $t('unified.changed') }}</span>
              <span class="text-identical">{{ totalIdentical }} {{ $t('unified.identical') }}</span>
              <span v-if="totalBlocked" class="text-blocked">{{ totalBlocked }} {{ $t('unified.errors') }}</span>
            </div>

            <Message v-if="previewData.has_errors" severity="error" :closable="false" size="small">
              {{ $t('unified.validationErrors') }}
            </Message>
            <Message v-if="previewData.warnings?.length" severity="warn" :closable="false" size="small">
              {{ previewData.warnings.join(' \u00b7 ') }}
            </Message>

            <div style="max-height:300px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:6px;">
              <DataTable :value="previewData.row_previews" size="small">
                <Column field="uuid" header="UUID">
                  <template #body="{ data }">
                    <code style="font-size:0.75rem;">{{ data.uuid?.substring(0,8) }}\u2026</code>
                  </template>
                </Column>
                <Column field="design_name" :header="$t('unified.design')" />
                <Column field="client_order_id" :header="$t('unified.orderPrefix')" />
                <Column field="status" :header="$t('unified.status')">
                  <template #body="{ data }">
                    <Tag :severity="data.status==='error'?'danger':data.status==='changed'?'warn':'secondary'" :value="data.status" />
                  </template>
                </Column>
                <Column field="changed_fields" header="Changed">
                  <template #body="{ data }">
                    <span v-if="data.changed_fields?.length">{{ data.changed_fields.join(', ') }}</span>
                    <span v-else style="color:#9ca3af;">\u2014</span>
                  </template>
                </Column>
                <Column field="reason" :header="$t('unified.reason')">
                  <template #body="{ data }">
                    <span v-if="data.reason" style="color:#dc2626;font-size:0.8rem;">{{ data.reason }}</span>
                  </template>
                </Column>
              </DataTable>
            </div>
          </template>

          <!-- Standard mode: batch-grouped preview -->
          <template v-else>
            <div class="flex-row gap-md mb-sm">
              <span class="chip-new">{{ $t('compactFlow.newChip', { count: totalNew }) }}</span>
              <span class="chip-changed">{{ $t('compactFlow.changedChip', { count: totalChanged }) }}</span>
              <span class="chip-identical">{{ $t('compactFlow.identicalChip', { count: totalIdentical }) }}</span>
              <span v-if="totalBlocked" class="chip-blocked">{{ $t('compactFlow.blockedChip', { count: totalBlocked }) }}</span>
            </div>

            <Message v-if="previewData.no_client_order_id" severity="warn" :closable="false" size="small">
              {{ $t('unified.noClientOrderId') }}
            </Message>
            <Message v-if="previewData.warnings?.length" severity="warn" :closable="false" size="small">
              {{ previewData.warnings.join(' \u00b7 ') }}
            </Message>
            <Message v-if="previewData.unresolved_batches?.length" severity="error" :closable="false" size="small">
              {{ $t('unified.batchesNotFound', { batches: previewData.unresolved_batches.join(', ') }) }}
            </Message>
            <Message v-if="previewData.unresolved_designs?.length" severity="error" :closable="false" size="small">
              {{ $t('unified.designsNotFound', { designs: previewData.unresolved_designs.slice(0,5).join(', ') + (previewData.unresolved_designs.length>5?'\u2026':'') }) }}
            </Message>

            <div v-for="bp in previewData.batch_previews" :key="bp.batch_uuid" class="batch-preview-row">
              <Tag :severity="bp.blocked?'danger':'secondary'" :value="bp.batch_name" />
              <span style="color:#15803d;">{{ $t('unified.batchNewChip', { count: bp.summary.new }) }}</span>
              <span style="color:#b45309;">{{ $t('unified.batchChangedChip', { count: bp.summary.changed }) }}</span>
              <span class="text-identical">{{ $t('unified.batchIdenticalChip', { count: bp.summary.identical }) }}</span>
              <Tag v-if="bp.blocked" severity="danger" :value="$t('compactFlow.definitiveBlocked')" />
            </div>

            <div style="max-height:320px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:6px;margin-top:0.75rem;">
              <DataTable :value="previewRows" size="small" striped-rows>
                <Column field="design_name" :header="$t('unified.design')" />
                <Column field="client_order_id" :header="$t('unified.orderPrefix')" />
                <Column field="batch_name" :header="$t('unified.batch')" />
                <Column :header="$t('unified.status')" style="width:110px;">
                  <template #body="{ data }">
                    <Tag :severity="data.status==='new'?'success':data.status==='changed'?'warn':data.status==='identical'?'secondary':'danger'"
                      :value="statusLabel(data.status)" />
                  </template>
                </Column>
                <Column :header="$t('unified.countLabel')" style="width:150px;">
                  <template #body="{ data }">
                    <span v-if="data.count_requested > 1">
                      {{ $t('unified.countRequested', { count: data.count_requested }) }}
                      <span v-if="data.count_to_create" class="text-new"> ({{ data.count_to_create }} {{ $t('unified.toCreate') }})</span>
                    </span>
                    <span v-else style="color:#9ca3af;">—</span>
                  </template>
                </Column>
                <Column field="changed_fields" :header="$t('unified.changedFields')">
                  <template #body="{ data }">
                    <span v-if="data.changed_fields?.length">{{ data.changed_fields.join(', ') }}</span>
                    <span v-else style="color:#9ca3af;">—</span>
                  </template>
                </Column>
              </DataTable>
            </div>
          </template>

          <div v-if="canExecute" class="mt-sm">
            <ConfirmedButton
              :label="$t('unified.executeBtn')"
              icon="pi pi-bolt"
              :confirm-label="$t('unified.confirmImport', { totalNew, totalChanged })"
              btn-class="btn-create"
              :loading="importing"
              @action="doImport" />
          </div>
        </div>

        <div v-if="importResults.length" class="mt-sm">
          <div style="display:flex;gap:1rem;flex-wrap:wrap;">
            <span v-if="!isUuidMode" class="text-new">{{ importResults.filter(r=>r.status==='created').length }} {{ $t('unified.created') }}</span>
            <span class="text-changed">{{ importResults.filter(r=>r.status==='updated').length }} {{ $t('unified.updated') }}</span>
            <span class="text-identical">{{ importResults.filter(r=>r.status==='skipped').length }} {{ $t('unified.skipped') }}</span>
            <span class="text-blocked">{{ importResults.filter(r=>r.status==='error'||r.status==='blocked').length }} {{ $t('unified.errors') }}</span>
          </div>
          <DataTable v-if="importResults.some(r=>r.status==='error'||r.status==='blocked')"
            :value="importResults.filter(r=>r.status==='error'||r.status==='blocked')" size="small" style="margin-top:0.5rem;">
            <Column field="uuid" header="UUID" v-if="isUuidMode">
              <template #body="{ data }">
                <code style="font-size:0.75rem;">{{ data.uuid?.substring(0,8) }}\u2026</code>
              </template>
            </Column>
            <Column field="design_name" :header="$t('unified.design')" v-if="!isUuidMode" />
            <Column field="batch" :header="$t('unified.batch')" v-if="!isUuidMode" />
            <Column field="reason" :header="$t('unified.reason')" />
          </DataTable>
          <Button :label="$t('unified.downloadCsv')" icon="pi pi-download" text size="small" style="margin-top:0.5rem;" @click="downloadCsv" />
        </div>
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
import { useProjectChecker } from '../composables/useProjectChecker.js'
import { useNotifications } from '../composables/useNotifications.js'

const { notify } = useNotifications()
import PhaseTable from '../components/PhaseTable.vue'
import ConfirmationTable from '../components/ConfirmationTable.vue'
import ConfirmedButton from '../components/ConfirmedButton.vue'
import ColumnMapper from '../components/ColumnMapper.vue'

// Project
const { projects: allProjects, loading: refreshing, error: projectsError, fetchProjects } = useProduuzitProjects()
const project = ref(null)
const context = ref(null)

// Superproject CSV
const phaseSuggestions = ref([])
const superParseError = ref('')
const superNoProjects = ref(false)
const { checking, checkDone, checkProjects } = useProjectChecker()
const confirmCreateProjects = ref(false)
const creatingProjects = ref(false)
const createProjectResults = ref([])
const addingPhasesBatches = ref(false)

// Assembly CSV
const parseResult = ref(null)
const columnMapping = ref({})
const presetName = ref('')
const presets = ref([])
const selectedPreset = ref(null)
const previewing = ref(false)
const previewData = ref(null)
const importing = ref(false)
const importResults = ref([])

const newProjectCount = computed(() => phaseSuggestions.value.filter(r => r.status === 'new').length)
const foundProjectCount = computed(() => phaseSuggestions.value.filter(r => r.status === 'found').length)
const confirmProjectRows = computed(() => phaseSuggestions.value.filter(r => r.status === 'new'))

const missingPhaseCount = computed(() =>
  phaseSuggestions.value.filter(r => r.status === 'found' && r.phase_exists === false).length
)
const missingBatchCount = computed(() =>
  phaseSuggestions.value.reduce((sum, r) => r.status === 'found' ? sum + (r.batches_missing?.length || 0) : sum, 0)
)
const hasMissingItems = computed(() => missingPhaseCount.value > 0 || missingBatchCount.value > 0)

const createItemsLabel = computed(() => {
  const parts = []
  if (missingPhaseCount.value) parts.push(t('unified.phaseCreateCount', { count: missingPhaseCount.value }))
  if (missingBatchCount.value) parts.push(t('unified.batchCreateCount', { count: missingBatchCount.value }))
  return parts.join(' + ')
})

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
  const targets = Object.values(columnMapping.value).flatMap(v => Array.isArray(v) ? v : [v])
  const w = []
  if (!targets.includes('design_name')) w.push(t('unified.noDesignName'))
  if (!targets.includes('batch_number')) w.push(t('unified.noBatchNumber'))
  return w
})

const hasRequiredMapping = computed(() => {
  const targets = Object.values(columnMapping.value).flatMap(v => Array.isArray(v) ? v : [v])
  return parseResult.value && project.value &&
    targets.includes('design_name') &&
    targets.includes('batch_number')
})

const isUuidMode = computed(() => previewData.value?.uuid_mode)
const previewRows = computed(() => {
  const rows = []
  for (const bp of previewData.value?.batch_previews || []) {
    for (const r of bp.rows || []) {
      rows.push({ ...r, batch_name: bp.batch_name })
    }
  }
  return rows
})
const totalNew = computed(() => previewData.value?.batch_previews?.reduce((a, b) => a + b.summary.new, 0) ?? 0)
const totalChanged = computed(() => isUuidMode.value
  ? (previewData.value?.row_previews?.filter(r => r.status === 'changed').length ?? 0)
  : (previewData.value?.batch_previews?.reduce((a, b) => a + b.summary.changed, 0) ?? 0))
const totalIdentical = computed(() => isUuidMode.value
  ? (previewData.value?.row_previews?.filter(r => r.status === 'identical').length ?? 0)
  : (previewData.value?.batch_previews?.reduce((a, b) => a + b.summary.identical, 0) ?? 0))
const totalBlocked = computed(() => isUuidMode.value
  ? (previewData.value?.row_previews?.filter(r => r.status === 'error').length ?? 0)
  : (previewData.value?.batch_previews?.filter(b => b.blocked).reduce((a, b) => a + b.rows.length, 0) ?? 0))

const canExecute = computed(() => isUuidMode.value
  ? (previewData.value && !previewData.value.has_errors && totalChanged.value > 0)
  : (previewData.value?.batch_previews?.some(bp => !bp.blocked && (bp.summary.new > 0 || bp.summary.changed > 0))))

function refreshProjects() { fetchProjects(true) }

async function onProjectChange() {
  context.value = null
  if (!project.value) return
  const res = await api.get(`/api/assemblies/context?project_uuid=${project.value}`)
  context.value = res.data
}

async function onSuperCsvSelect(e) {
  superParseError.value = ''
  superNoProjects.value = false
  const file = e.files?.[0]; if (!file) return
  await parseSuperCsvFile(file)
}

const superFileInput = ref(null)
function triggerSuperCsv() { superFileInput.value?.click() }
function onSuperCsvInput(e) {
  const file = e.target.files?.[0]
  if (file) onSuperCsvSelect({ files: [file] })
  e.target.value = ''
}

async function parseSuperCsvFile(file) {
  superParseError.value = ''
  superNoProjects.value = false
  const form = new FormData(); form.append('file', file)
  try {
    const res = await api.post('/api/csv/parse', form)
    phaseSuggestions.value = res.data.phase_suggestions || []
    superNoProjects.value = phaseSuggestions.value.length === 0
    checkDone.value = false; createProjectResults.value = []
  } catch (err) {
    superParseError.value = err.response?.data?.detail || err.message
  }
}

const doCheck = () => { superParseError.value = ''; checkProjects(phaseSuggestions) }

async function createProjects() {
  creatingProjects.value = true
  const newOnes = phaseSuggestions.value.filter(r => r.status === 'new')
  try {
    const res = await api.post('/api/projects/create', newOnes.map(p => ({
      project_key: p.project_key,
      superproject: p.superproject,
      letter: p.letter,
      description: p.description,
      suggested_suffix: p.suggested_suffix,
      phase: p.suggested_phase || '',
    })))
    createProjectResults.value = res.data
    const byKey = {}
    for (const r of res.data) {
      byKey[r.project_key] = r.status === 'created' ? 'found' : r.status
    }
    phaseSuggestions.value = phaseSuggestions.value.map(p => ({
      ...p,
      status: byKey[p.project_key] || p.status,
    }))
  } catch (err) {
    superParseError.value = err.response?.data?.detail || err.message
  } finally {
    creatingProjects.value = false
  }
}

async function addPhasesAndBatches() {
  addingPhasesBatches.value = true
  const existing = phaseSuggestions.value.filter(r => r.status === 'found')
  const batchDefs = []
  for (const p of existing) {
    const missing = new Set(p.batches_missing?.map(String) || [])
    for (const b of p.batches || []) {
      if (missing.has(String(b.number))) {
        batchDefs.push({ project_key: p.project_key, batch_number: b.number, phase: b.phase || p.suggested_phase || '', stdlibs: b.stdlibs || [] })
      }
    }
  }
  if (!batchDefs.length && !missingPhaseCount.value) {
    addingPhasesBatches.value = false
    return
  }
  try {
    const res = await api.post('/api/batches/add-for-projects', { phase: existing[0]?.suggested_phase || '', batch_defs: batchDefs })
    const results = res.data || []
    const created = results.filter(r => r.status === 'created').length
    const existed = results.filter(r => r.status === 'already_exists').length
    const errors = results.filter(r => r.status === 'error').length
    if (created) notify({ severity: 'success', summary: t('unified.created'), detail: t('unified.createdDetail', { created, existed }), life: 5000 })
    if (errors) notify({ severity: 'error', summary: t('unified.error'), detail: t('unified.errorsDetail', { errors }), life: 8000 })
    // Re-check so the UI updates to show phases/batches as existing
    await checkProjects()
  } catch (err) {
    superParseError.value = err.response?.data?.detail || err.message
  } finally {
    addingPhasesBatches.value = false
  }
}

async function onAsmFileSelect(e) {
  const file = e.files?.[0]; if (!file) return
  const form = new FormData(); form.append('file', file)
  try {
    const res = await api.post('/api/assemblies/parse-csv', form)
    parseResult.value = res.data; previewData.value = null; importResults.value = []
  } catch (err) {
    /* noop */
  }
}

function onMappingUpdated(m) { columnMapping.value = m; previewData.value = null }

function statusLabel(status) {
  if (status === 'new') return t('unified.statusNew')
  if (status === 'changed') return t('unified.statusChanged')
  if (status === 'identical') return t('unified.statusIdentical')
  return status
}

async function doPreview() {
  previewing.value = true; previewData.value = null
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
  if (!presetName.value.trim() || !parseResult.value) return
  await api.post('/api/config/save-preset', {
    name: presetName.value.trim(),
    mapping: columnMapping.value,
  })
  presets.value = (await api.get('/api/config/presets')).data.presets || []
}

async function loadPreset() {
  if (!selectedPreset.value) return
  const p = presets.value.find(x => x.name === selectedPreset.value)
  if (p?.mapping) columnMapping.value = p.mapping
}

function downloadCsv() {
  const headers = ['uuid', 'design_name', 'batch', 'status', 'reason']
  const rows = importResults.value.map(r => [r.uuid||'', r.design_name||'', r.batch||'', r.status, r.reason||''])
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = 'import_results.csv'; a.click()
}
</script>

<style scoped>
.unified-import { max-width: 1100px; }
.page-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem; }
.page-hint { color: #6b7280; font-size: 0.9rem; margin-bottom: 1.5rem; }
.mb-card { margin-bottom: 1rem; }

.chip-new { color: #15803d; font-weight: 600; font-size: 0.9rem; }
.chip-changed { color: #b45309; font-weight: 600; font-size: 0.9rem; }
.chip-identical { color: #6b7280; font-size: 0.9rem; }
.chip-blocked { color: #dc2626; font-weight: 600; font-size: 0.9rem; }

/* Button color definitions */
.btn-preview { background: #6366f1; border-color: #6366f1; color: #fff; }
.btn-preview:hover { background: #4f46e5; border-color: #4f46e5; }
.btn-create { background: #e40520; border-color: #e40520; color: #fff; }
.btn-create:hover { background: #c2041b; border-color: #c2041b; }
</style>
