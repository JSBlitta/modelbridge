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
              <Tag v-if="row.status === 'ambiguous'" severity="danger"
                   :value="$t('unified.projectAmbiguous', { names: (row.candidates || []).join(', ') })" />
              <Tag v-else :severity="row.status === 'found' ? 'success' : 'secondary'"
                   :value="row.status === 'found' ? $t('unified.projectFound') + (row.project_name && row.project_name !== row.project_key ? ': ' + row.project_name : '') : $t('unified.projectNew')" />
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

        <div v-if="checkDone && hasAnythingToCreate" style="margin-top:1rem;">
          <Message v-if="newProjectCount" severity="warn" :closable="false" size="small">
            {{ $t('unified.newProjects', { count: newProjectCount }) }}
          </Message>
          <ConfirmationTable v-if="newProjectCount"
            :rows="confirmProjectRows"
            :columns="[{field:'project_key',header:$t('unified.project')},{field:'superproject',header:$t('unified.superproject')},{field:'phases_label',header:$t('unified.phase')}]"
            status-field="status"
            :show-actions="false"
            class="mt-sm"
            />
          <Message v-if="foundProjectCount && (missingPhaseCount || missingBatchCount)" severity="info" :closable="false" size="small" class="mt-sm">
            {{ $t('unified.foundProjectInfo', { count: foundProjectCount }) }}
          </Message>
          <Message v-if="rowsWithoutPhase.length" severity="error" :closable="false" size="small" class="mt-sm">
            {{ $t('unified.phaseMissingFor', { projects: rowsWithoutPhase.join(', ') }) }}
          </Message>
          <ConfirmedButton
            :label="$t('unified.createAllBtn')"
            icon="pi pi-plus"
            :confirm-label="$t('unified.confirmCreateItems', { items: createItemsLabel })"
            btn-class="btn-create"
            :reset-key="createItemsLabel"
            :loading="creatingAll"
            @action="createAll"
            style="margin-top:0.5rem;" />
        </div>

        <div v-if="createProjectResults.length" class="mt-sm">
          <!-- Plain DataTable: only the Trimble flow uses components/SortFilterTable.vue (sortable, filter per column). Switch to it if this view is ever rewritten. -->
          <DataTable :value="createProjectResults" size="small">
            <Column field="project_key" :header="$t('unified.project')" />
            <Column field="item" :header="$t('unified.item')" />
            <Column field="status" :header="$t('unified.status')">
              <template #body="{ data }">
                <Tag :severity="data.status==='error'?'danger':data.status==='already_exists'?'secondary':'success'" :value="data.status" />
              </template>
            </Column>
            <Column field="error" :header="$t('unified.error')" />
          </DataTable>
        </div>
      </template>
    </Card>

    <!-- ASSEMBLY IMPORT -->
    <Card class="mb-card">
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

        <div v-if="parseResult && !isUuidMode" class="flex-row gap-md" style="margin-bottom:0.75rem;align-items:center;flex-wrap:wrap;margin-top:0.75rem;">
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <Checkbox v-model="includeProductionCounts" :binary="true" input-id="uc_counts_toggle" />
            <label for="uc_counts_toggle" style="font-size:0.85rem;cursor:pointer;">{{ $t('unified.includeCounts') }}</label>
          </div>
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <label for="uc_default_count" style="font-size:0.85rem;">{{ $t('unified.defaultCount') }}</label>
            <InputNumber v-model="defaultCount" input-id="uc_default_count" :min="1" :step="1" :disabled="!includeProductionCounts" style="width:90px;" />
          </div>
        </div>
        <Message v-if="previewData && !isUuidMode" :severity="includeProductionCounts ? 'warn' : 'secondary'" :closable="false" size="small" style="margin-bottom:0.75rem;">
          {{ includeProductionCounts ? $t('unified.countsIncluded', { default: defaultCount || 1 }) : $t('unified.countsExcluded') }}
        </Message>

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
              <!-- Plain DataTable: only the Trimble flow uses components/SortFilterTable.vue (sortable, filter per column). Switch to it if this view is ever rewritten. -->
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
            <Message v-if="previewData.designs_to_create?.length" severity="warn" :closable="false" size="small">
              {{ $t('pushBlock.designsToCreate', { designs: shortList(previewData.designs_to_create) }) }}
            </Message>

            <div v-for="bp in previewData.batch_previews" :key="bp.batch_uuid" class="batch-preview-row">
              <Tag :severity="bp.blocked?'danger':'secondary'" :value="bp.batch_name" />
              <span style="color:#15803d;">{{ $t('unified.batchNewChip', { count: bp.summary.new }) }}</span>
              <span style="color:#b45309;">{{ $t('unified.keptChip', { count: bp.summary.kept }) }}</span>
                            <span class="text-identical">{{ $t('unified.batchIdenticalChip', { count: bp.summary.identical }) }}</span>
              <Tag v-if="bp.blocked" severity="danger" :value="$t('compactFlow.definitiveBlocked')" />
            </div>

            <div style="max-height:320px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:6px;margin-top:0.75rem;">
              <!-- Plain DataTable: only the Trimble flow uses components/SortFilterTable.vue (sortable, filter per column). Switch to it if this view is ever rewritten. -->
              <DataTable :value="previewRows" size="small" striped-rows>
                <Column field="design_name" :header="$t('unified.design')" />
                <Column field="client_order_id" :header="$t('unified.orderPrefix')" />
                <Column field="batch_name" :header="$t('unified.batch')" />
                <Column :header="$t('unified.status')" style="width:110px;">
                  <template #body="{ data }">
                    <Tag :severity="data.status==='new'?'success':data.status==='kept'?'info':data.status==='changed'?'warn':data.status==='identical'?'secondary':'danger'"
                      :value="statusLabel(data.status)" />
                  </template>
                </Column>
                <Column :header="$t('unified.countLabel')" style="width:150px;">
                  <template #body="{ data }">
                    <span v-if="data.count_requested != null">
                      <template v-if="data.status === 'new'">{{ data.count_requested }}</template><template v-else>{{ data.count_existing }}</template>
                      <span v-if="data.status === 'kept'" style="color:#6b7280;"> ({{ $t('unified.keptHint', { count: data.count_requested }) }})</span>
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
            <PushGate
              :gate="importGate"
              :show-check="false"
              :confirm-label="$t('unified.confirmImport', { totalNew, totalChanged }) + designsSuffix(previewData, $t)"
              :push-label="$t('unified.executeBtn')"
              push-icon="pi pi-bolt" />
          </div>
        </div>

        <Message v-if="pushBlockers.length && !importResults.length" severity="secondary" :closable="false" size="small" class="mt-sm">
          <strong>{{ $t('pushBlock.title') }}</strong>
          <ul style="margin:0.25rem 0 0 1.1rem;padding:0;"><li v-for="b in pushBlockers" :key="b">{{ b }}</li></ul>
        </Message>

        <div v-if="importResults.length" class="mt-sm">
          <div style="display:flex;gap:1rem;flex-wrap:wrap;">
            <span v-if="!isUuidMode" class="text-new">{{ importResults.filter(r=>r.status==='created').length }} {{ $t('unified.created') }}</span>
            <span class="text-changed">{{ importResults.filter(r=>r.status==='updated').length }} {{ $t('unified.updated') }}</span>
            <span class="text-identical">{{ importResults.filter(r=>r.status==='skipped').length }} {{ $t('unified.skipped') }}</span>
            <span class="text-blocked">{{ importResults.filter(r=>r.status==='error'||r.status==='blocked').length }} {{ $t('unified.errors') }}</span>
          </div>
          <!-- Plain DataTable: only the Trimble flow uses components/SortFilterTable.vue (sortable, filter per column). Switch to it if this view is ever rewritten. -->
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
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { api, apiErrorMessage } from '../api.js'
import { useProduuzitProjects } from '../composables/useProduuzitProjects.js'
import { useProjectChecker } from '../composables/useProjectChecker.js'
import { useNotifications } from '../composables/useNotifications.js'

const { notify } = useNotifications()
import PhaseTable from '../components/PhaseTable.vue'
import ConfirmationTable from '../components/ConfirmationTable.vue'
import ConfirmedButton from '../components/ConfirmedButton.vue'
import PushGate from '../components/PushGate.vue'
import { usePushGate } from '../composables/usePushGate.js'
import { useImportPreview, importBlockers, shortList, designsSuffix } from '../composables/useImportPreview.js'
import ColumnMapper from '../components/ColumnMapper.vue'

// Project
const { projects: allProjects, loading: refreshing, fetchProjects } = useProduuzitProjects()
const project = ref(null)
const context = ref(null)

// Superproject CSV
const phaseSuggestions = ref([])
const superParseError = ref('')
const superNoProjects = ref(false)
const { checking, checkDone, checkProjects } = useProjectChecker()
const creatingAll = ref(false)
const createProjectResults = ref([])

// Assembly CSV
const parseResult = ref(null)
const columnMapping = ref({})
const presetName = ref('')
const presets = ref([])
const selectedPreset = ref(null)
// previewing / importing come from importGate (declared below).
const previewData = ref(null)
const importResults = ref([])
// Production counts are an explicit opt-in per import; default off.
const includeProductionCounts = ref(false)
const defaultCount = ref(1)

const phasesOf = (p) => [...new Set([p.suggested_phase, ...(p.batches || []).map(b => b.phase)].filter(Boolean))]
const newProjectCount = computed(() => phaseSuggestions.value.filter(r => r.status === 'new').length)
const foundProjectCount = computed(() => phaseSuggestions.value.filter(r => r.status === 'found').length)
const confirmProjectRows = computed(() => phaseSuggestions.value
  .filter(r => r.status === 'new')
  .map(r => ({ ...r, phases_label: phasesOf(r).join(', ') })))
// A project (or batch) without a phase cannot be created: Produuzit batches live in a phase.
const rowsWithoutPhase = computed(() => phaseSuggestions.value
  .filter(r => !r.suggested_phase)
  .map(r => r.project_key))

// After a check every row carries what is missing, new projects included.
const missingPhaseCount = computed(() =>
  phaseSuggestions.value.reduce((sum, r) => sum + (r.phases_missing?.length || 0), 0)
)
const missingBatchCount = computed(() =>
  phaseSuggestions.value.reduce((sum, r) => sum + (r.batches_missing?.length || 0), 0)
)
// Batches the CSV links to a standard library. The server adds a missing link and
// leaves one that is already there, so offering it again is harmless.
const stdlibLinkCount = computed(() => {
  const keys = new Set(stdlibsFromMapping().keys())
  for (const p of phaseSuggestions.value) for (const b of p.batches || []) if (b.stdlibs?.length) keys.add(`${p.project_key}|${b.number}`)
  return keys.size
})
const hasAnythingToCreate = computed(() => newProjectCount.value > 0 || missingPhaseCount.value > 0 || missingBatchCount.value > 0 || stdlibLinkCount.value > 0)

const createItemsLabel = computed(() => {
  const parts = []
  if (newProjectCount.value) parts.push(t('unified.projectCreateCount', { count: newProjectCount.value }))
  if (missingPhaseCount.value) parts.push(t('unified.phaseCreateCount', { count: missingPhaseCount.value }))
  if (missingBatchCount.value) parts.push(t('unified.batchCreateCount', { count: missingBatchCount.value }))
  if (stdlibLinkCount.value) parts.push(t('unified.stdlibLinkCount', { count: stdlibLinkCount.value }))
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

const hasRequiredMapping = computed(() => {
  const targets = Object.values(columnMapping.value).flatMap(v => Array.isArray(v) ? v : [v])
  return parseResult.value && project.value &&
    targets.includes('design_name') &&
    targets.includes('batch_number')
})

const isUuidMode = computed(() => previewData.value?.uuid_mode)
const { mappingWarnings, previewRows } = useImportPreview({
  t, ns: 'unified', columnMapping, previewData,
})
const totalNew = computed(() => previewData.value?.batch_previews?.reduce((a, b) => a + b.summary.new, 0) ?? 0)
const totalChanged = computed(() => isUuidMode.value
  ? (previewData.value?.row_previews?.filter(r => r.status === 'changed').length ?? 0)
  : 0) // counts are write-once: nothing in a batch preview is "changed"
const totalIdentical = computed(() => isUuidMode.value
  ? (previewData.value?.row_previews?.filter(r => r.status === 'identical').length ?? 0)
  : (previewData.value?.batch_previews?.reduce((a, b) => a + b.summary.identical, 0) ?? 0))
const totalBlocked = computed(() => isUuidMode.value
  ? (previewData.value?.row_previews?.filter(r => r.status === 'error').length ?? 0)
  : (previewData.value?.batch_previews?.filter(b => b.blocked).reduce((a, b) => a + b.rows.length, 0) ?? 0))

const pushBlockers = computed(() => {
  // A CSV that names its project selects it once it exists; until then say what to do.
  if (!project.value && parseResult.value?.col_map?.project && phaseSuggestions.value.length) {
    return [phaseSuggestions.value.length > 1
      ? t('unified.pickCsvProject', { count: phaseSuggestions.value.length })
      : t('unified.createCsvProject')]
  }
  return importBlockers({
    t, project: project.value, parsed: parseResult.value, mapping: columnMapping.value,
    // A changed input (e.g. the counts toggle) voids the check: ask for a new one.
    preview: importGate.checked ? previewData.value : null, includeCounts: includeProductionCounts.value,
  })
})
const canExecute = computed(() => Boolean(previewData.value) && !pushBlockers.value.length)

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
    superParseError.value = apiErrorMessage(err)
  }
}

const doCheck = async () => { superParseError.value = ''; await checkProjects(phaseSuggestions); selectCsvProject() }

// One confirmed action: new projects (with all their phases, which also brings a
// new superproject into being), then every missing phase and batch, then a
// re-check. Each step is idempotent server-side, so a repeat creates nothing.
// Standard-library cells per project and batch from the assembly CSV's own column
// mapping, so a column mapped by hand counts, not only one the parser recognised.
function stdlibsFromMapping() {
  const out = new Map()
  const colFor = (target) => Object.entries(columnMapping.value).find(([, v]) => (Array.isArray(v) ? v : [v]).includes(target))?.[0]
  const sCol = colFor('stdlib'), bCol = colFor('batch_number'), pCol = colFor('project') || parseResult.value?.col_map?.project
  if (!sCol || !bCol || !pCol) return out
  for (const r of parseResult.value?.rows || []) {
    const cell = String(r[sCol] ?? '').trim()
    if (!cell) continue
    const key = `${String(r[pCol] ?? '').trim()}|${String(r[bCol] ?? '').trim()}`
    out.set(key, [...new Set([...(out.get(key) || []), cell])])
  }
  return out
}

async function createAll() {
  creatingAll.value = true
  createProjectResults.value = []
  const rows = []
  try {
    const mappedStdlibs = stdlibsFromMapping()
    const uuidByKey = {}
    for (const p of phaseSuggestions.value) if (p.project_uuid) uuidByKey[p.project_key] = p.project_uuid

    const newOnes = phaseSuggestions.value.filter(r => r.status === 'new')
    if (newOnes.length) {
      const res = await api.post('/api/projects/create', newOnes.map(p => ({
        project_key: p.project_key,
        superproject: p.superproject,
        letter: p.letter,
        description: p.description,
        suggested_suffix: p.suggested_suffix,
        phase: p.suggested_phase || '',
        phases: phasesOf(p),
      })))
      for (const r of res.data) {
        if (r.data?.uuid) uuidByKey[r.project_key] = r.data.uuid
        rows.push({ project_key: r.project_key, item: t('unified.project'), status: r.status, error: r.error || '' })
      }
    }

    const phaseDefs = []
    const batchDefs = []
    for (const p of phaseSuggestions.value) {
      const project_uuid = uuidByKey[p.project_key]
      if (!project_uuid) continue // creation failed; reported above
      for (const phase of p.phases_missing || []) phaseDefs.push({ project_key: p.project_key, project_uuid, phase })
      const missing = new Set((p.batches_missing || []).map(String))
      for (const b of p.batches || []) {
        const stdlibs = [...new Set([...(b.stdlibs || []), ...(mappedStdlibs.get(`${p.project_key}|${b.number}`) || [])])]
        // An existing batch is sent too when the CSV links a standard library: the
        // server adds a link that is missing and creates nothing else.
        if (missing.has(String(b.number)) || stdlibs.length) {
          batchDefs.push({ project_key: p.project_key, project_uuid, batch_number: b.number, phase: b.phase || p.suggested_phase || '', stdlibs })
        }
      }
    }
    if (phaseDefs.length || batchDefs.length) {
      const res = await api.post('/api/batches/add-for-projects', { phase_defs: phaseDefs, batch_defs: batchDefs })
      for (const r of res.data || []) {
        const item = r.batch_number != null ? `${t('unified.batch')} ${r.batch_number}` : `${t('unified.phase')} ${r.phase ?? ''}`
        rows.push({ project_key: r.project_key, item, status: r.status, error: r.error || '' })
      }
    }

    createProjectResults.value = rows
    const errors = rows.filter(r => r.status === 'error').length
    const created = rows.length - errors - rows.filter(r => r.status === 'already_exists').length
    if (created) notify({ severity: 'success', summary: t('unified.created'), detail: t('unified.createAllDetail', { created }), life: 5000 })
    if (errors) notify({ severity: 'error', summary: t('unified.error'), detail: t('unified.createAllErrors', { errors }), life: 8000 })
    // Re-check so the tags show what now exists.
    await checkProjects(phaseSuggestions)
    await selectCsvProject()
  } catch (err) {
    createProjectResults.value = rows
    superParseError.value = apiErrorMessage(err)
  } finally {
    creatingAll.value = false
  }
}

async function onAsmFileSelect(e) {
  const file = e.files?.[0]; if (!file) return
  const form = new FormData(); form.append('file', file)
  try {
    const res = await api.post('/api/assemblies/parse-csv', form)
    parseResult.value = res.data; previewData.value = null; importResults.value = []
  } catch (err) {
    return
  }
  // The CSV names its own project: check it in Produuzit (read-only) and select it,
  // so nobody picks it by hand. Whatever is missing goes through "Create all" above.
  if (!parseResult.value.col_map?.project) return
  await parseSuperCsvFile(file)
  if (!phaseSuggestions.value.length) return
  await checkProjects(phaseSuggestions)
  selectCsvProject()
}

// Select the CSV's project once it exists in Produuzit. A project picked by hand
// stays; one selected from an earlier CSV is replaced.
const projectFromCsv = ref(false)
watch(project, (v, old) => { if (v !== old) projectFromCsv.value = false })
async function selectCsvProject() {
  if (project.value && !projectFromCsv.value) return
  const found = phaseSuggestions.value.filter(r => r.project_uuid)
  // Several projects in one file: the push goes per project, so the operator picks one.
  if (phaseSuggestions.value.length !== 1 || found.length !== 1) return
  if (!allProjects.value.some(p => p.uuid === found[0].project_uuid)) await fetchProjects(true)
  project.value = found[0].project_uuid
  await nextTick() // let the watch above clear the flag first, then claim it
  projectFromCsv.value = true
  await onProjectChange()
}

// With several projects in the file, only the selected project's rows go to Produuzit.
const importRows = computed(() => {
  const rows = parseResult.value?.rows ?? []
  const col = parseResult.value?.col_map?.project
  const key = phaseSuggestions.value.find(r => r.project_uuid && r.project_uuid === project.value)?.project_key
  return col && key && phaseSuggestions.value.length > 1 ? rows.filter(r => String(r[col] ?? '').trim() === key) : rows
})

function onMappingUpdated(m) { columnMapping.value = m; previewData.value = null }

function statusLabel(status) {
  if (status === 'new') return t('unified.statusNew')
  if (status === 'changed') return t('unified.statusChanged')
  if (status === 'identical') return t('unified.statusIdentical')
  if (status === 'kept') return t('unified.statusKept')
  return status
}

function importBody() {
  return {
    project_uuid: project.value,
    column_mapping: columnMapping.value,
    rows: importRows.value,
    include_production_counts: includeProductionCounts.value,
    default_count: Number(defaultCount.value) || 1,
  }
}

const importGate = usePushGate({
  // Cheap identity over every input the check depends on.
  identity: () => [
    project.value || '',
    JSON.stringify(columnMapping.value),
    importRows.value.length,
    parseResult.value?.headers?.join('|') ?? '',
    includeProductionCounts.value ? '1' : '0',
    String(Number(defaultCount.value) || 1),
  ].join('::'),
  check: async () => {
    const res = await api.post('/api/assemblies/preview-import', importBody())
    previewData.value = res.data
    return res.data
  },
  push: async (previewToken) => {
    const res = await api.post('/api/assemblies/import', { ...importBody(), preview_token: previewToken })
    importResults.value = res.data
    previewData.value = null
    return res.data
  },
})

const previewing = computed(() => importGate.checking)
const doPreview = () => importGate.runCheck()

async function savePreset() {
  if (!presetName.value.trim() || !parseResult.value) return
  await api.post('/api/config/presets', {
    name: presetName.value.trim(),
    mapping: columnMapping.value,
  })
  presets.value = (await api.get('/api/config/presets')).data || []
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
</style>
