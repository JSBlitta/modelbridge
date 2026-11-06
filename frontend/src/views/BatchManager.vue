<template>
  <div>
    <h2 class="page-title">Batch Manager</h2>

    <Card class="mb-card">
      <template #title>{{ $t('batchManager.selectProject') }}</template>
      <template #content>
        <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap;">
          <Select
            v-model="selectedProject"
            :options="projects"
            option-label="name"
            option-value="uuid"
            placeholder="Select project..."
            style="min-width:280px"
            @change="loadBatches"
          />
          <Button icon="pi pi-refresh" text @click="loadProjects" :loading="loadingProjects" />
        </div>
        <Message v-if="!loadingProjects && projects.length === 0" severity="info" :closable="false" style="margin-top:0.75rem;">
          {{ $t('batchManager.noProjects') }}
        </Message>
      </template>
    </Card>

    <Card v-if="selectedProject" class="mb-card">
      <template #title>Phase Management</template>
      <template #content>
        <div style="display:flex;gap:0.75rem;align-items:flex-end;flex-wrap:wrap;">
          <div>
            <label>Current Phases</label><br/>
            <div style="display:flex;gap:0.4rem;flex-wrap:wrap;min-height:2rem;align-items:center;">
              <Tag v-for="phase in projectPhases" :key="phase" :value="phase" severity="secondary" />
              <span v-if="!projectPhases.length" class="info-text">No phases yet for this project.</span>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:0.75rem;align-items:flex-end;flex-wrap:wrap;margin-top:0.75rem;">
          <div>
            <label>Add New Phase(s)</label><br/>
            <InputText v-model="newPhase" placeholder="e.g. vbw, xyz or vbw | xyz" style="width:280px" />
          </div>
          <Button :label="$t('batchManager.preview')" icon="pi pi-eye" @click="previewPhases" :disabled="!newPhase.trim()" />
        </div>
        <div v-if="phasePreviews.length" style="margin-top:0.75rem;">
          <div v-for="pp in phasePreviews" :key="pp.phase" style="margin-bottom:0.4rem;">
            <Message :severity="pp.exists ? 'info' : 'success'" :closable="false" size="small">
              {{ pp.exists ? `Phase "${pp.phase}" already exists.` : `Will create: "${pp.phase}"` }}
            </Message>
          </div>
          <div v-if="newPhaseCount > 0" style="display:flex;align-items:center;gap:0.5rem;margin-top:0.5rem;">
            <Checkbox v-model="confirmAddPhases" :binary="true" input-id="confirm-phases" />
            <label for="confirm-phases" style="cursor:pointer;font-size:0.85rem;">
              I confirm — add {{ newPhaseCount }} phase(s) to this project
            </label>
          </div>
          <Button v-if="confirmAddPhases && newPhaseCount > 0" :label="$t('batchManager.addPhasesBtn')" icon="pi pi-plus" severity="success"
            @click="addPhases" :loading="addingPhase" style="margin-top:0.5rem;" />
          <span v-if="phaseMsg" class="info-text" style="margin-left:0.5rem;">{{ phaseMsg }}</span>
        </div>
      </template>
    </Card>

    <Card v-if="selectedProject" class="mb-card">
      <template #title>Batches</template>
      <template #content>
        <!-- Plain DataTable: only the Trimble flow uses components/SortFilterTable.vue (sortable, filter per column). Switch to it if this view is ever rewritten. -->
        <DataTable :value="mergedBatches" size="small" striped-rows selection-mode="multiple" v-model:selection="selectedBatches">
          <Column selection-mode="multiple" style="width:3rem" />
          <Column field="name" :header="$t('batchManager.name')" />
          <Column field="phase" :header="$t('batchManager.phaseCol')" />
          <Column :header="$t('batchManager.stdLibs')">
            <template #body="{ data }">
              <span v-if="data.linked_stdlibs && data.linked_stdlibs.length">
                {{ data.linked_stdlibs.map(u => stdlibName(u)).filter(Boolean).join(', ') || data.linked_stdlibs.length + ' lib(s)' }}
              </span>
              <span v-else style="color:#9ca3af;">—</span>
            </template>
          </Column>
          <Column :header="$t('batchManager.apiStatus')">
            <template #body="{ data }">
              <Tag v-if="data.from_api" severity="info" value="In API" />
              <Tag v-else severity="secondary" value="Local only" />
            </template>
          </Column>
          <Column :header="$t('batchManager.localState')">
            <template #body="{ data }">
              <Tag v-if="data.state"
                :severity="data.state === 'definitive' ? 'success' : 'warn'"
                :value="data.state" />
              <Tag v-else-if="data.from_api" severity="secondary" :value="$t('batchManager.notTracked')" />
              <Tag v-else severity="warn" value="provisional" />
            </template>
          </Column>
        </DataTable>
        <div style="display:flex;gap:0.75rem;margin-top:0.75rem;" v-if="selectedBatches.length">
          <Button :label="$t('batchManager.setProvisional')" severity="warn" size="small" @click="confirmSetState('provisional')" />
          <Button :label="$t('batchManager.setDefinitive')" severity="danger" size="small" @click="confirmSetState('definitive')" />
        </div>
      </template>
    </Card>

    <Card v-if="selectedProject" class="mb-card">
      <template #title>Generate Batches</template>
      <template #content>
        <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:1rem;">
          <div>
            <label>From #</label><br/>
            <InputNumber v-model="batchFrom" :min="1" style="width:100px" />
          </div>
          <div>
            <label>To #</label><br/>
            <InputNumber v-model="batchTo" :min="1" style="width:100px" />
          </div>
          <div>
            <label>Phase</label><br/>
            <Select
              v-model="selectedBatchPhase"
              :options="projectPhases"
              placeholder="Select phase"
              style="width:180px"
            />
          </div>
          <Button :label="$t('batchManager.previewBatches')" icon="pi pi-eye" @click="previewBatches" :loading="previewing" :disabled="!selectedBatchPhase" />
        </div>
        <div v-if="projectStdlibs.length" style="margin-bottom:1rem;">
          <label style="font-weight:600;font-size:0.8rem;color:#4b5563;">Standard Libraries</label>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.25rem;">
            <div v-for="slib in projectStdlibs" :key="slib.uuid" style="display:flex;align-items:center;gap:0.3rem;">
              <Checkbox v-model="selectedStdlibs" :value="slib" :input-id="'slib_' + slib.uuid" />
              <label :for="'slib_' + slib.uuid" style="font-size:0.82rem;cursor:pointer;">{{ slib.name }}</label>
            </div>
          </div>
          <span v-if="!projectStdlibs.length" style="color:#9ca3af;font-size:0.8rem;">No standard libraries linked to this project.</span>
        </div>
        <div v-if="previewRows.length">
          <!-- Plain DataTable: only the Trimble flow uses components/SortFilterTable.vue (sortable, filter per column). Switch to it if this view is ever rewritten. -->
          <DataTable :value="previewRows" size="small">
            <Column field="name" :header="$t('batchManager.name')" />
            <Column field="phase" :header="$t('batchManager.phaseCol')" />
            <Column :header="$t('batchManager.stdLibs')">
              <template #body="{ data }">
                <span v-if="data.linked_stdlibs && data.linked_stdlibs.length">
                  {{ data.linked_stdlibs.map(u => stdlibName(u)).filter(Boolean).join(', ') || data.linked_stdlibs.length + ' lib(s)' }}
                </span>
                <span v-else style="color:#9ca3af;">—</span>
              </template>
            </Column>
            <Column field="status" :header="$t('batchManager.status')">
              <template #body="{ data }">
                <Tag :severity="data.status === 'new' ? 'success' : 'secondary'" :value="data.status" />
              </template>
            </Column>
          </DataTable>
          <div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.75rem;">
            <Checkbox v-model="confirmCreateBatches" :binary="true" input-id="confirm-create" />
            <label for="confirm-create" style="cursor:pointer;font-size:0.85rem;">
              I confirm — create {{ previewRows.filter(r => r.status === 'new').length }} new batch(es)
            </label>
          </div>
          <div style="margin-top:0.5rem;">
            <Button :label="$t('batchManager.createBatches')" icon="pi pi-plus" severity="success"
              @click="createBatches" :loading="creating" :disabled="!confirmCreateBatches" />
          </div>
        </div>
        <div v-if="createMsg" class="info-text" style="margin-top:0.5rem;">{{ createMsg }}</div>
      </template>
    </Card>

    <!-- ════════════════════════════════════════════
         COUNT IMPORT
         ════════════════════════════════════════════ -->
    <Card v-if="selectedProject" class="mb-card">
      <template #title>Count Import</template>
      <template #content>
        <p style="color:#6b7280;font-size:0.82rem;margin-bottom:0.75rem;">
          Upload a count CSV to update quantities on assemblies in this project's batches.
        </p>
        <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem;">
          <FileUpload mode="basic" accept=".csv" :auto="false" choose-label="Select Count CSV" @select="onCountFileSelect" />
          <span v-if="countParseResult" style="background:#e0f2fe;color:#0369a1;padding:0.2rem 0.5rem;border-radius:999px;font-size:0.78rem;">
            {{ countParseResult.rows.length }} rows · {{ countParseResult.headers.length }} columns
          </span>
        </div>

        <div v-if="countParseResult" style="margin-bottom:0.75rem;">
          <label style="display:block;font-size:0.8rem;font-weight:600;color:#6b7280;margin-bottom:0.25rem;">Column Mapping</label>
          <ColumnMapper
            :detected-columns="countParseResult.headers"
            :auto-mapping="countInitialMapping"
            :preview-rows="countParseResult.preview"
            @mapping-updated="onCountMappingUpdated"
          />
        </div>

        <PushGate
          v-if="countParseResult"
          :gate="countGate"
          :check-label="$t('unified.previewBtn')"
          :check-disabled="!countHasRequiredMapping"
          :show-push="!countBlockers.length"
          :confirm-label="`I confirm: write ${countSummary.new} new production count(s)`"
          :push-label="$t('batchManager.executeImport')"
          push-icon="pi pi-bolt" />

        <div v-if="countGate.checked && countPreviewData" style="margin-top:0.75rem;display:flex;gap:0.75rem;flex-wrap:wrap;">
          <span style="color:#15803d;font-weight:600;">{{ countSummary.new }} new</span>
          <span style="color:#b45309;">{{ countSummary.kept }} kept</span>
          <span style="color:#6b7280;">{{ countSummary.identical }} identical</span>
          <span v-if="countSummary.blocked" style="color:#dc2626;font-weight:600;">{{ countSummary.blocked }} blocked</span>
          <span v-if="countPreviewData.unresolved_batches?.length" style="color:#dc2626;">
            {{ $t('unified.batchesNotFound', { batches: countPreviewData.unresolved_batches.join(', ') }) }}
          </span>
        </div>

        <Message v-if="countParseResult && countBlockers.length && !countImportResults.length" severity="secondary" :closable="false" size="small" style="margin-top:0.75rem;">
          <strong>{{ $t('pushBlock.title') }}</strong>
          <ul style="margin:0.25rem 0 0 1.1rem;padding:0;"><li v-for="b in countBlockers" :key="b">{{ b }}</li></ul>
        </Message>

        <div v-if="countImportResults.length" style="margin-top:0.75rem;">
          <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:0.5rem;">
            <span style="color:#15803d;font-weight:600;">{{ countImportResults.filter(r=>r.status==='created').length }} written · {{ countImportResults.filter(r=>r.status==='skipped').length }} skipped</span>
            <span style="color:#dc2626;font-weight:600;">{{ countImportResults.filter(r=>r.status==='error').length }} errors</span>
          </div>
          <!-- Plain DataTable: only the Trimble flow uses components/SortFilterTable.vue (sortable, filter per column). Switch to it if this view is ever rewritten. -->
          <DataTable v-if="countImportResults.some(r=>r.status==='error')"
            :value="countImportResults.filter(r=>r.status==='error')" size="small">
            <Column field="design_name" :header="$t('batchManager.design')" />
            <Column field="batch" :header="$t('batchManager.batch')" />
            <Column field="reason" :header="$t('batchManager.reason')" />
          </DataTable>
        </div>
      </template>
    </Card>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { api } from '../api.js'
import { useProduuzitProjects } from '../composables/useProduuzitProjects.js'
import ColumnMapper from '../components/ColumnMapper.vue'
import PushGate from '../components/PushGate.vue'
import { usePushGate } from '../composables/usePushGate.js'
import { importBlockers } from '../composables/useImportPreview.js'
import { useI18n } from 'vue-i18n'
import { useConfirm } from 'primevue/useconfirm'

const { t } = useI18n()

const confirm = useConfirm()

const { projects, loading: loadingProjects, fetchProjects } = useProduuzitProjects()
const selectedProject = ref(null)
const apiBatches = ref([])
const dbBatches = ref([])
const selectedBatches = ref([])
const batchFrom = ref(101)
const batchTo = ref(110)
const projectPhases = ref([])
const selectedBatchPhase = ref('')
const previewRows = ref([])
const previewing = ref(false)
const creating = ref(false)
const createMsg = ref('')
const newPhase = ref('')
const addingPhase = ref(false)
const phaseMsg = ref('')
const phasePreviews = ref([])
const confirmAddPhases = ref(false)
const confirmCreateBatches = ref(false)
const projectStdlibs = ref([])
const selectedStdlibs = ref([])

// ── Count Import ──
const countParseResult = ref(null)
const countColumnMapping = ref({})
const countPreviewData = ref(null)
const countImportResults = ref([])

function buildBatchName(n) {
  return String(n)
}

const mergedBatches = computed(() => {
  const apiMap = {}
  for (const b of apiBatches.value) {
    apiMap[b.name] = { ...b, from_api: true }
  }
  const dbMap = {}
  for (const b of dbBatches.value) {
    dbMap[b.name] = b
  }
  const allNames = new Set([...Object.keys(apiMap), ...Object.keys(dbMap)])
  return [...allNames].map(name => ({
    ...(apiMap[name] || {}),
    ...(dbMap[name] || {}),
    from_api: !!apiMap[name],
  }))
})

function loadProjects() { fetchProjects(true) }

async function loadBatches() {
  if (!selectedProject.value) return
  confirmAddPhases.value = false
  phasePreviews.value = []
  phaseMsg.value = ''
  confirmCreateBatches.value = false
  previewRows.value = []
  createMsg.value = ''
  const [apiRes, dbRes, projectRes, stdlibRes] = await Promise.all([
    api.get(`/api/batches?project_uuid=${selectedProject.value}&limit=200`),
    api.get(`/api/batches/db?project_uuid=${selectedProject.value}`),
    api.get(`/api/projects/${selectedProject.value}`),
    api.get(`/api/projects/${selectedProject.value}/stdlibs`),
  ])
  apiBatches.value = apiRes.data.results || []
  dbBatches.value = dbRes.data || []
  projectPhases.value = projectRes.data.phases || []
  projectStdlibs.value = stdlibRes.data.stdlibs || []
  selectedStdlibs.value = []
  if (projectPhases.value.length && !projectPhases.value.includes(selectedBatchPhase.value)) {
    selectedBatchPhase.value = projectPhases.value[0]
  }
}

async function previewBatches() {
  const phase = selectedBatchPhase.value
  if (!phase) {
    createMsg.value = 'Select a phase first.'
    return
  }
  previewing.value = true
  createMsg.value = ''
  confirmCreateBatches.value = false
  const stdlibUUIDs = selectedStdlibs.value.map(s => s.uuid)
  const batches = []
  for (let n = batchFrom.value; n <= batchTo.value; n++) {
    batches.push({ name: buildBatchName(n), phase, linked_stdlibs: stdlibUUIDs })
  }
  try {
    const res = await api.post('/api/batches/preview', {
      project_uuid: selectedProject.value,
      batches,
    })
    previewRows.value = res.data.map(r => ({
      name: r.item.name,
      phase: r.item.phase,
      linked_stdlibs: r.item.linked_stdlibs,
      status: r.status,
    }))
  } finally {
    previewing.value = false
  }
}

const newPhaseCount = computed(() => phasePreviews.value.filter(p => !p.exists).length)

function previewPhases() {
  phaseMsg.value = ''
  const raw = (newPhase.value || '').trim()
  if (!selectedProject.value || !raw) {
    phaseMsg.value = 'Enter at least one phase name.'
    return
  }
  // Split on comma or pipe
  const parts = raw.split(/[,|]+/).map(s => s.trim()).filter(Boolean)
  phasePreviews.value = parts.map(phase => ({
    phase,
    exists: projectPhases.value.includes(phase),
  }))
}

async function addPhases() {
  phaseMsg.value = ''
  const toAdd = phasePreviews.value.filter(p => !p.exists)
  if (!selectedProject.value || !toAdd.length || !confirmAddPhases.value) return

  addingPhase.value = true
  const added = []
  try {
    for (const p of toAdd) {
      const res = await api.post(`/api/projects/${selectedProject.value}/phases`, { phase: p.phase })
      projectPhases.value = res.data.phases || projectPhases.value
      if (!selectedBatchPhase.value || !projectPhases.value.includes(selectedBatchPhase.value)) {
        selectedBatchPhase.value = p.phase
      }
      added.push(p.phase)
    }
    newPhase.value = ''
    confirmAddPhases.value = false
    phasePreviews.value = []
    phaseMsg.value = `Added: ${added.join(', ')}`
  } finally {
    addingPhase.value = false
  }
}

async function createBatches() {
  creating.value = true
  createMsg.value = ''
  const batches = previewRows.value
    .filter(r => r.status === 'new')
    .map(r => ({ name: r.name, phase: r.phase, linked_stdlibs: r.linked_stdlibs || [] }))
  try {
    const res = await api.post('/api/batches/create', {
      project_uuid: selectedProject.value,
      batches,
    })
    const created = res.data.filter(r => r.status === 'created').length
    createMsg.value = `Created ${created} batches.`
    previewRows.value = []
    await loadBatches()
  } finally {
    creating.value = false
  }
}

function confirmSetState(targetState) {
  const names = selectedBatches.value.map(b => b.name).filter(Boolean).join(', ')
  const isDefinitive = targetState === 'definitive'
  confirm.require({
    message: isDefinitive
      ? `Lock ${selectedBatches.value.length} batch(es) as definitive?\n\nBatches: ${names}\n\nDefinitive batches block all future imports — this cannot be undone without reverting to provisional.`
      : `Set ${selectedBatches.value.length} batch(es) back to provisional?\n\nBatches: ${names}`,
    header: isDefinitive ? 'Lock Batches as Definitive' : 'Revert to Provisional',
    icon: isDefinitive ? 'pi pi-lock' : 'pi pi-unlock',
    rejectLabel: 'Cancel',
    acceptLabel: isDefinitive ? 'Lock Batches' : 'Set Provisional',
    accept: () => setState(targetState),
  })
}

async function setState(state) {
  const uuids = selectedBatches.value.map(b => b.uuid).filter(Boolean)
  if (!uuids.length) return
  await api.patch('/api/batches/state', { batch_uuids: uuids, state })
  await loadBatches()
  selectedBatches.value = []
}

function stdlibName(uuid) {
  const s = projectStdlibs.value.find(x => x.uuid === uuid)
  return s ? s.name : ''
}

// ── Count Import ──
const countInitialMapping = computed(() => {
  if (!countParseResult.value) return {}
  const m = {}
  for (const [canonical, csvCol] of Object.entries(countParseResult.value.col_map || {})) {
    if (canonical === 'design') m[csvCol] = 'design_name'
    else if (canonical === 'batch') m[csvCol] = 'batch_number'
    else if (canonical === 'count') m[csvCol] = 'count'
  }
  for (const [csvCol, target] of Object.entries(countParseResult.value.meta_suggestions || {})) {
    m[csvCol] = target
  }
  return m
})

// The server groups rows by batch, so the batch column is required too. With no
// count column every design gets 1.
const countHasRequiredMapping = computed(() => {
  const targets = Object.values(countColumnMapping.value).flatMap(v => (Array.isArray(v) ? v : [v]))
  return Boolean(countParseResult.value && selectedProject.value) && targets.includes('design_name') && targets.includes('batch_number')
})

// A count import always writes counts; that is its whole job.
function countBody() {
  return {
    project_uuid: selectedProject.value,
    column_mapping: countColumnMapping.value,
    rows: countParseResult.value?.rows ?? [],
    include_production_counts: true,
    default_count: 1,
  }
}

const countGate = usePushGate({
  identity: () => [
    selectedProject.value || '',
    JSON.stringify(countColumnMapping.value),
    countParseResult.value?.rows?.length ?? -1,
    countParseResult.value?.headers?.join('|') ?? '',
  ].join('::'),
  check: async () => {
    const res = await api.post('/api/assemblies/preview-import', countBody())
    countPreviewData.value = res.data
    return res.data
  },
  push: async (previewToken) => {
    const res = await api.post('/api/assemblies/import', { ...countBody(), preview_token: previewToken })
    countImportResults.value = res.data
    countPreviewData.value = null
    return res.data
  },
})

const countSummary = computed(() => {
  const s = { new: 0, kept: 0, identical: 0, blocked: 0 }
  for (const bp of countPreviewData.value?.batch_previews || []) for (const k in s) s[k] += bp.summary?.[k] || 0
  return s
})

const countBlockers = computed(() => importBlockers({
  t, project: selectedProject.value, parsed: countParseResult.value, mapping: countColumnMapping.value,
  preview: countGate.checked ? countPreviewData.value : null, includeCounts: true,
}))

async function onCountFileSelect(e) {
  const file = e.files?.[0]; if (!file) return
  const form = new FormData(); form.append('file', file)
  const res = await api.post('/api/assemblies/parse-csv', form)
  countParseResult.value = res.data; countPreviewData.value = null; countImportResults.value = []
}

function onCountMappingUpdated(m) {
  countColumnMapping.value = m; countPreviewData.value = null
}

</script>

<style scoped>
.page-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 1.5rem; }
.mb-card { margin-bottom: 1.25rem; }
.info-text { color: #374151; }
</style>
