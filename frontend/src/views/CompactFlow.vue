<template>
  <div class="compact-flow">
    <div class="compact-header">
      <h2>{{ $t('compactFlow.title') }}</h2>
      <span class="compact-hint">{{ $t('compactFlow.hint') }}</span>
    </div>

    <!-- Row 1: Project + File side by side -->
    <div class="row-two">
      <div class="panel">
        <label class="panel-label">{{ $t('compactFlow.project') }}</label>
        <Select v-model="selectedProject" :options="projects" option-label="name" option-value="uuid"
          :placeholder="$t('compactFlow.selectProject')" class="wide" @change="onProjectChange" />
        <Tag v-if="context && context.batches.length" severity="secondary" style="margin-top:0.4rem;"
          :value="`${context.designs.length} ${$t('compactFlow.designsBatches', { designs: context.designs.length, batches: context.batches.length }).split('·')[0]} · ${context.batches.length} ${$t('compactFlow.designsBatches', { designs: context.designs.length, batches: context.batches.length }).split('·')[1]}`" />
        <Message v-if="!projectsLoading && projects.length === 0" severity="info" :closable="false" size="small" style="margin-top:0.4rem;">
          {{ $t('compactFlow.noProjects') }}
        </Message>
        <Message v-if="context && context.batches.length === 0" severity="warn" :closable="false" size="small" style="margin-top:0.4rem;">
          {{ $t('compactFlow.noBatches') }}
        </Message>
      </div>
      <div class="panel">
        <label class="panel-label">{{ $t('compactFlow.csvFile') }}</label>
        <FileUpload mode="basic" accept=".csv" :auto="false" :choose-label="$t('compactFlow.selectCsv')" @select="onFileSelect" />
        <span v-if="parseResult" class="badge-info" style="margin-top:0.4rem;">
          {{ parseResult.rows.length }} rows · {{ parseResult.headers.length }} columns
        </span>
      </div>
    </div>

    <!-- Column mapping: compact table -->
    <div v-if="parseResult && selectedProject" class="panel mt-sm">
      <label class="panel-label">{{ $t('compactFlow.columnMapping') }}</label>
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
      <div class="flex-row gap-md">
        <Button :label="$t('compactFlow.previewBtn')" icon="pi pi-search" @click="doPreview" :loading="previewing" class="btn-preview" />
        <span v-if="previewData" class="summary-chips">
          <span class="chip-new">{{ $t('compactFlow.newChip', { count: totalNew }) }}</span>
          <span class="chip-changed">{{ $t('compactFlow.changedChip', { count: totalChanged }) }}</span>
          <span class="chip-identical">{{ $t('compactFlow.identicalChip', { count: totalIdentical }) }}</span>
          <span v-if="totalBlocked" class="chip-blocked">{{ $t('compactFlow.blockedChip', { count: totalBlocked }) }}</span>
          <span v-if="previewData.unresolved_batches.length" class="chip-blocked">
            {{ $t('compactFlow.unresolvedChip', { count: previewData.unresolved_batches.length }) }}
          </span>
        </span>
      </div>

      <!-- Warnings / errors -->
      <div v-if="previewData" style="margin-top:0.5rem;">
        <Message v-if="previewData.warnings.length" severity="warn" :closable="false" size="small">
          {{ previewData.warnings.join(' · ') }}
        </Message>
        <Message v-if="previewData.unresolved_batches.length" severity="error" :closable="false" size="small">
          {{ $t('compactFlow.batchesNotFound', { batches: previewData.unresolved_batches.join(', ') }) }}
        </Message>
        <Message v-if="previewData.unresolved_designs.length" severity="error" :closable="false" size="small">
          {{ $t('compactFlow.designsNotFound', { designs: previewData.unresolved_designs.slice(0, 5).join(', ') + (previewData.unresolved_designs.length > 5 ? '…' : '') }) }}
        </Message>

        <!-- Batch state list: only those with issues or changes -->
        <div v-for="bp in previewData.batch_previews" :key="bp.batch_uuid" class="compact-batch-row">
          <Tag :severity="bp.blocked ? 'danger' : 'secondary'" :value="bp.batch_name" />
          <span class="chip-new">{{ bp.summary.new }}↑</span>
          <span class="chip-changed">{{ bp.summary.changed }}~</span>
          <span class="chip-identical">{{ bp.summary.identical }}=</span>
          <Tag v-if="bp.blocked" severity="danger" :value="$t('compactFlow.definitiveBlocked')" />
        </div>

        <!-- Execute -->
        <div v-if="canExecute" class="mt-sm">
          <div class="flex-row gap-sm mb-sm">
            <Checkbox v-model="confirmImport" :binary="true" input-id="confirm-compact-import" />
            <label for="confirm-compact-import" style="cursor:pointer;font-size:0.85rem;">
              {{ $t('compactFlow.confirmImport', { totalNew, totalChanged }) }}
            </label>
          </div>
          <Button :label="$t('compactFlow.executeBtn')" icon="pi pi-bolt" @click="doImport" :loading="importing" :disabled="!confirmImport" class="btn-create" />
        </div>
      </div>
    </div>

    <!-- Result bar -->
    <div v-if="importResults.length" class="panel mt-sm">
      <div class="summary-chips">
        <span class="chip-new">{{ importResults.filter(r=>r.status==='created').length }} {{ $t('compactFlow.created') }}</span>
        <span class="chip-changed">{{ importResults.filter(r=>r.status==='updated').length }} {{ $t('compactFlow.updated') }}</span>
        <span class="chip-identical">{{ importResults.filter(r=>r.status==='skipped').length }} {{ $t('compactFlow.skipped') }}</span>
        <span v-if="importResults.some(r=>r.status==='error'||r.status==='blocked')" class="chip-blocked">
          {{ importResults.filter(r=>r.status==='error'||r.status==='blocked').length }} {{ $t('compactFlow.errors') }}
        </span>
      </div>
      <DataTable v-if="importResults.some(r=>r.status==='error'||r.status==='blocked')"
        :value="importResults.filter(r=>r.status==='error'||r.status==='blocked')"
        size="small" style="margin-top:0.5rem;">
        <Column field="design_name" :header="$t('compactFlow.design')" />
        <Column field="batch" :header="$t('compactFlow.batch')" />
        <Column field="reason" :header="$t('compactFlow.reason')" />
      </DataTable>
      <Button :label="$t('compactFlow.downloadCsv')" icon="pi pi-download" text size="small" style="margin-top:0.5rem;" @click="downloadCsv" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { api } from '../api.js'
import { useProduuzitProjects } from '../composables/useProduuzitProjects.js'
import ColumnMapper from '../components/ColumnMapper.vue'

const { projects, loading: projectsLoading, error: projectsError } = useProduuzitProjects()
const selectedProject = ref(null)
const context = ref(null)
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
  const targets = Object.values(columnMapping.value).flatMap(v => Array.isArray(v) ? v : [v])
  const w = []
  if (!targets.includes('design_name')) w.push(t('compactFlow.noDesignName'))
  if (!targets.includes('batch_number')) w.push(t('compactFlow.noBatchNumber'))
  return w
})

const hasRequiredMapping = computed(() => {
  const targets = Object.values(columnMapping.value).flatMap(v => Array.isArray(v) ? v : [v])
  return parseResult.value && selectedProject.value &&
    targets.includes('design_name') &&
    targets.includes('batch_number')
})

const totalNew = computed(() => previewData.value?.batch_previews.reduce((a, b) => a + b.summary.new, 0) ?? 0)
const totalChanged = computed(() => previewData.value?.batch_previews.reduce((a, b) => a + b.summary.changed, 0) ?? 0)
const totalIdentical = computed(() => previewData.value?.batch_previews.reduce((a, b) => a + b.summary.identical, 0) ?? 0)
const totalBlocked = computed(() => previewData.value?.batch_previews.filter(b => b.blocked).reduce((a, b) => a + b.rows.length, 0) ?? 0)

const canExecute = computed(() => previewData.value?.batch_previews.some(bp => !bp.blocked && (bp.summary.new > 0 || bp.summary.changed > 0)))

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
