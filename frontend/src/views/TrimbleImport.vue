<template>
  <div class="trimble-import">
    <div class="page-header">
      <h2 class="page-title">{{ $t('trimble.title') }}</h2>
      <p class="page-subtitle">{{ $t('trimble.subtitle') }}</p>
    </div>

    <Card v-if="!authStatus" class="mb-card">
      <template #title>{{ $t('trimble.connect') }}</template>
      <template #content>
        <div class="flex-row gap-md">
          <Tag severity="warn" :value="$t('trimble.notConnected')" />
          <Button :label="$t('trimble.openLogin')" icon="pi pi-external-link" @click="startLogin" :loading="startingLogin" />
          <Button :label="$t('trimble.refreshStatus')" icon="pi pi-refresh" text @click="loadAuthStatus" :loading="loadingStatus" />
        </div>
        <Message severity="warn" :closable="false" class="mt-sm" style="margin-top:1rem">
          {{ $t('trimble.noAutoPush') }}
        </Message>
      </template>
    </Card>

    <Card v-if="authStatus" class="mb-card">
      <template #title>{{ $t('trimble.selectModelCard') }}</template>
      <template #content>
        <div class="flex-row gap-lg" style="align-items:flex-end">
          <div style="flex:1;min-width:280px;">
            <label class="field-label">{{ $t('trimble.trimbleProject') }}</label>
            <Select v-model="selectedProject" :options="trimbleProjects" option-label="name" option-value="id"
              :placeholder="$t('trimble.selectProject')" class="wide" @change="onProjectChange" />
          </div>
          <Button icon="pi pi-refresh" text :loading="loadingProjects" @click="loadTrimbleProjects"
            v-tooltip.top="$t('trimble.reloadProjects')" />
          <Button :label="$t('trimble.loadFiles')" icon="pi pi-folder-open" @click="loadProjectFiles" :loading="loadingFiles" :disabled="!selectedProject" />
        </div>
        <Message v-if="projectsError" severity="warn" :closable="false" size="small" style="margin-top:0.5rem;">
          {{ $t('trimble.loadFailed', { error: projectsError }) }}
          <Button :label="$t('trimble.retry')" icon="pi pi-refresh" size="small" text @click="loadTrimbleProjects" style="margin-left:0.5rem;" />
        </Message>
        <div v-if="loadingProjects" class="text-dim" style="margin-top:0.5rem">{{ $t('trimble.loadingProjects') }}</div>
        <div v-if="loadingFiles" class="text-dim" style="margin-top:0.5rem">{{ $t('trimble.scanningProject') }}</div>
        <div v-if="modelFiles.length" class="mt-sm">
          <label class="field-label">{{ $t('trimble.modelFile') }} <span style="font-weight:400;color:#6b7280;">({{ modelFiles.length }} found)</span></label>
          <Select v-model="selectedFile" :options="modelFiles" option-label="_display" option-value="id"
            :placeholder="$t('trimble.selectIfc')" class="wide" @change="onFileSelected" />
        </div>
        <Message v-if="selectedProject && !loadingFiles && modelFiles.length === 0" severity="info" :closable="false" class="mt-sm">
          {{ $t('trimble.noIfcFiles') }}
        </Message>
      </template>
    </Card>

    <Card v-if="psetDefs.length" class="mb-card">
      <template #title>{{ $t('trimble.propertySetsTitle') }} <span class="subtitle-dim">({{ totalSelectedProps }} selected)</span></template>
      <template #content>
        <div class="flex-row gap-sm mb-sm" style="margin-bottom:0.75rem">
          <Button :label="$t('trimble.selectAll')" icon="pi pi-check-square" text size="small" @click="selectAllProps" />
          <Button :label="$t('trimble.clearAll')" icon="pi pi-stop" text size="small" @click="clearAllProps" />
          <InputText v-model="psetFilter" :placeholder="$t('trimble.filterPsets')" size="small" style="width:200px;" />
        </div>
        <Message v-if="!psetDefs.length" severity="info" :closable="false">{{ $t('trimble.noPsets') }}</Message>
        <div v-for="pset in filteredPsets" :key="pset.name" class="pset-block">
          <div class="pset-header">
            <Checkbox v-model="psetChecks[pset.name]" :binary="true" @change="onPsetToggle(pset)" :input-id="'pset_' + pset.name" />
            <label :for="'pset_' + pset.name" class="pset-label">{{ pset.name }}</label>
            <span class="pset-count">{{ propsOfPset(pset).length }} props</span>
          </div>
          <div v-if="psetChecks[pset.name]" class="pset-props">
            <div v-for="prop in propsOfPset(pset)" :key="propName(prop)" class="prop-row">
              <Checkbox v-model="propChecks[propPath(pset.name, prop)]" :binary="true"
                :input-id="propPath(pset.name, prop)" @change="emitPropSelection" />
              <label :for="propPath(pset.name, prop)" class="prop-label">{{ propName(prop) }}</label>
              <span class="prop-type">{{ propType(prop) }}</span>
            </div>
          </div>
        </div>
      </template>
    </Card>

    <Card v-if="allSelectedProps.length" class="mb-card">
      <template #title>{{ $t('trimble.mapToProduuzit') }}</template>
      <template #content>
        <div class="mb-sm" style="display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap;margin-bottom:0.75rem;">
          <div>
            <label class="field-label">{{ $t('trimble.superproject') }}</label>
            <Select v-model="selectedSuperproject" :options="superprojects"
              :placeholder="$t('trimble.selectSuperproject')" style="min-width:220px;"
              @change="onSuperprojectChange" :loading="projectsLoading" />
            <small v-if="produuzitProjectsError" style="color:#ef4444;display:block;margin-top:2px;">
              ⚠ {{ produuzitProjectsError }}
            </small>
          </div>
          <div v-if="selectedSuperproject" style="flex:1;min-width:280px;">
            <label class="field-label">{{ $t('trimble.targetProjects') }}
              <span style="font-weight:400;color:#6b7280;">({{ filteredProjects.length }} found)</span>
            </label>
            <div class="project-checklist" style="max-height:180px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:6px;padding:0.4rem 0.6rem;">
              <div v-for="proj in filteredProjects" :key="proj.uuid" style="display:flex;align-items:center;gap:0.4rem;padding:0.15rem 0;">
                <Checkbox :model-value="selectedProjectUuids.has(proj.uuid)" :binary="true"
                  @change="toggleProject(proj.uuid)" :input-id="'proj_' + proj.uuid" />
                <label :for="'proj_' + proj.uuid" style="font-size:0.85rem;cursor:pointer;">{{ proj.name }}</label>
              </div>
            </div>
          </div>
          <Tag v-if="produuzitContext" severity="secondary"
            :value="$t('trimble.contextTag', { designs: produuzitContext.designs?.length || 0, batches: produuzitContext.batches?.length || 0 })" />
        </div>
        <ColumnMapper
          :detected-columns="allSelectedProps"
          :auto-mapping="initialIfcMapping"
          :preview-rows="previewRowsForMapping"
          @mapping-updated="onMappingUpdated"
        />
        <Message v-if="mappingWarnings.length" severity="warn" :closable="false" style="margin-top:0.5rem;">
          {{ mappingWarnings.join(' | ') }}
        </Message>
      </template>
    </Card>

    <Card v-if="allSelectedProps.length && hasSelectedProjects" class="mb-card">
      <template #title>{{ $t('trimble.step5') }}</template>
      <template #content>
        <div class="flex-row gap-md mb-sm" style="margin-bottom:0.75rem">
          <Button :label="$t('trimble.fetchEntities')" icon="pi pi-download" @click="fetchEntities" :loading="fetchingEntities"
            :disabled="!selectedFile" />
          <Button :label="$t('trimble.rawSample')" icon="pi pi-eye" severity="secondary" size="small" text
            @click="fetchRawSample" :loading="fetchingRawSample" :disabled="!selectedFile" />
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <Checkbox v-model="uniqueOnly" :binary="true" input-id="unique_toggle" />
            <label for="unique_toggle" style="font-size:0.85rem;cursor:pointer;">{{ $t('trimble.deduplicateOn') }}</label>
          </div>
          <Select v-if="uniqueOnly" v-model="uniqueKeyProp"
            :options="[{label:'\u2014 entity id (fallback)',value:''}, ...allSelectedProps.map(p=>({label:p.split('.').pop(),value:p}))]"
            option-label="label" option-value="value"
            :placeholder="$t('trimble.selectDedupKey')" style="min-width:200px;font-size:0.82rem;" />
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <Checkbox v-model="includeAssemblies" :binary="true" input-id="include_assemblies" />
            <label for="include_assemblies" style="font-size:0.85rem;cursor:pointer;">{{ $t('trimble.includeAssemblies') }}</label>
          </div>
          <Tag v-if="totalEntities > 0" severity="info" :value="$t('trimble.entitiesTag', { preview: previewEntities.length, total: totalEntities })" />
        </div>
        <details v-if="rawSampleEntity" class="mb-sm" style="font-size:0.78rem">
          <summary style="cursor:pointer;color:#6b7280;font-weight:600;">{{ $t('trimble.rawSampleSummary') }}</summary>
          <pre style="background:#f3f4f6;padding:0.5rem;border-radius:4px;overflow-x:auto;max-height:300px;font-size:0.72rem;white-space:pre-wrap;">{{ JSON.stringify(rawSampleEntity, null, 2) }}</pre>
        </details>
        <details v-if="previewEntities.length" class="mb-sm" style="font-size:0.78rem">
          <summary style="cursor:pointer;color:#6b7280;">{{ $t('trimble.rawFilteredSummary') }}</summary>
          <pre style="background:#f3f4f6;padding:0.5rem;border-radius:4px;overflow-x:auto;max-height:220px;font-size:0.72rem;white-space:pre-wrap;">{{ JSON.stringify(previewEntities[0], null, 2) }}</pre>
        </details>
        <Message v-if="uniqueOnly" severity="secondary" :closable="false" size="small" class="mb-sm">
          {{ $t('trimble.dedupInfo', { key: dedupLabel }) }}
        </Message>

        <div v-if="previewEntities.length">
          <div class="flex-row gap-sm" style="margin-bottom:0.25rem">
            <Button :label="$t('trimble.selectAllEntities')" icon="pi pi-check-square" size="small" text @click="selectAllEntities" />
            <Button :label="$t('trimble.deselectAll')" icon="pi pi-stop" size="small" text @click="deselectAllEntities" />
            <Tag severity="info" :value="$t('trimble.selectedCount', { count: selectedCount })" />
          </div>
          <div class="mb-sm" style="display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;">
            <template v-for="[batch, indices] in entityBatchGroups" :key="batch">
              <div style="display:flex;align-items:center;gap:0.2rem;">
                <Checkbox :model-value="batchSelectionState.get(batch) === 'all'" :binary="true" @change="toggleBatch(batch)" :input-id="'batch_cb_' + batch" />
                <label :for="'batch_cb_' + batch" style="font-size:0.82rem;cursor:pointer;">[{{ batch }}]</label>
              </div>
            </template>
          </div>
        </div>

        <DataTable v-if="previewEntities.length" :value="previewEntities" size="small" striped-rows scrollable scroll-height="400px"
          removable-sort sort-mode="multiple"
          :global-filter="entityFilter" :global-filter-fields="displayProps" filter-display="menu" global-filter-match-mode="contains">
          <template #header>
            <div style="display:flex;gap:0.5rem;align-items:center;">
              <InputText v-model="entityFilter" :placeholder="$t('trimble.filterEntities')" size="small" style="width:220px;" />
              <InputText v-model="propFilter" :placeholder="$t('trimble.filterColumns')" size="small" style="width:180px;" />
            </div>
          </template>
          <Column :header="$t('trimble.selectAllEntities')" style="width:3rem;">
            <template #body="{ data }">
              <Checkbox :model-value="selectedEntityIndices.has(entityIndex(data))" :binary="true" @change="toggleEntity(entityIndex(data))" />
            </template>
          </Column>
          <Column v-for="prop in displayProps" :key="prop" :field="prop" :header="prop.split('.').pop()" style="min-width:120px;" sortable>
            <template #body="{ data }">{{ extractProp(data, prop) }}</template>
          </Column>
        </DataTable>
        <div v-if="!previewEntities.length && !fetchingEntities" class="text-dim">{{ $t('trimble.clickFetch') }}</div>
      </template>
    </Card>

    <Card v-if="previewEntities.length && hasRequiredMapping" class="mb-card">
      <template #title>{{ $t('trimble.previewChanges') }}</template>
      <template #content>
        <div class="flex-row gap-md mb-sm" style="margin-bottom:0.75rem">
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <Checkbox v-model="uniqueOnlyImport" :binary="true" input-id="unique_toggle_import" />
            <label for="unique_toggle_import" style="font-size:0.85rem;cursor:pointer;">{{ $t('trimble.deduplicate') }}</label>
          </div>
          <Button :label="$t('trimble.checkChanges')" icon="pi pi-search" @click="doPreview" :loading="previewing" />
        </div>

        <div v-if="previewing" class="text-dim mb-sm">
          <i class="pi pi-spin pi-spinner" style="margin-right:0.4rem;"></i>
          {{ $t('trimble.comparing', { count: selectedEntities.length || previewEntities.length }) }}
        </div>

        <div v-if="previewError" class="mb-sm">
          <Message severity="error" :closable="true" @close="previewError = ''">{{ previewError }}</Message>
        </div>

        <div v-if="previewData" style="margin-bottom:1rem;">
          <Message v-if="previewData.unresolved_batches?.length" severity="error" :closable="false" size="small">
            {{ $t('trimble.batchesNotMatched', { batches: previewData.unresolved_batches.join(', ') }) }}
          </Message>
          <Message v-if="previewData.unresolved_designs?.length" severity="error" :closable="false" size="small">
            {{ $t('trimble.designsNotFound', { designs: previewData.unresolved_designs.slice(0, 5).join(', ') + (previewData.unresolved_designs.length > 5 ? '\u2026' : '') }) }}
          </Message>
          <div v-for="bp in previewData.batch_previews" :key="bp.batch_uuid"
            class="batch-preview-row">
            <Tag :severity="bp.blocked ? 'danger' : 'secondary'" :value="bp.batch_name" />
            <span class="chip-new">{{ $t('trimble.newChip', { count: bp.summary.new }) }}</span>
            <span class="chip-changed">{{ $t('trimble.changedChip', { count: bp.summary.changed }) }}</span>
            <span class="chip-identical" style="color:#9ca3af">{{ $t('trimble.identicalChip', { count: bp.summary.identical }) }}</span>
            <Tag v-if="bp.blocked" severity="danger" :value="$t('trimble.blockedChip')" />
          </div>
          <div style="max-height:320px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:6px;margin-top:0.75rem;">
            <DataTable :value="previewRows" size="small" striped-rows>
              <Column field="design_name" :header="$t('trimble.design')" />
              <Column field="client_order_id" :header="$t('trimble.orderId')" />
              <Column field="batch_name" :header="$t('trimble.batch')" />
              <Column :header="$t('trimble.statusLabel')" style="width:110px;">
                <template #body="{ data }">
                  <Tag :severity="data.status==='new'?'success':data.status==='changed'?'warn':data.status==='identical'?'secondary':'danger'"
                    :value="statusLabel(data.status)" />
                </template>
              </Column>
              <Column :header="$t('trimble.countLabel')" style="width:150px;">
                <template #body="{ data }">
                  <span v-if="data.count_requested > 1">
                    {{ $t('trimble.countRequested', { count: data.count_requested }) }}
                    <span v-if="data.count_to_create" class="text-new"> ({{ data.count_to_create }} {{ $t('trimble.toCreate') }})</span>
                  </span>
                  <span v-else style="color:#9ca3af;">—</span>
                </template>
              </Column>
              <Column :header="$t('trimble.changes')">
                <template #body="{ data }">
                  <span v-if="data.changed_fields?.length">{{ formatChanges(data) }}</span>
                  <span v-else style="color:#9ca3af;">—</span>
                </template>
              </Column>
            </DataTable>
          </div>
          <Message v-if="!canExecute" severity="secondary" :closable="false" size="small" style="margin-top:0.5rem;">
            {{ $t('trimble.nothingToPushDetail') }}
          </Message>
        </div>
      </template>
    </Card>

    <Card v-if="previewData?.unresolved_designs?.length" class="mb-card card-danger-border">
      <template #title>{{ $t('trimble.missingDesignsTitle') }}</template>
      <template #content>
        <Message severity="warn" :closable="false" style="margin-bottom:0.75rem;">
          {{ $t('trimble.missingDesignsBody', { designs: previewData.unresolved_designs.join(', ') }) }}
        </Message>
        <ConfirmedButton
          :label="$t('trimble.createDesignsBtn', { count: previewData.unresolved_designs.length })"
          icon="pi pi-plus"
          :confirm-label="$t('trimble.confirmCreateDesigns', { count: previewData.unresolved_designs.length })"
          :loading="creatingDesigns"
          @action="createMissingDesignsAction" />

        <div v-if="designCreateResults.length" style="margin-top:0.75rem;">
          <Message v-if="designCreateFailedCount === 0" severity="success" :closable="false" size="small">
            {{ $t('trimble.designsCreated', { count: designCreateCreatedCount }) }}
          </Message>
          <Message v-else severity="error" :closable="false" size="small">
            {{ $t('trimble.designsCreatePartial', { created: designCreateCreatedCount, failed: designCreateFailedCount }) }}
          </Message>
          <DataTable v-if="designCreateFailedCount" :value="designCreateFailedRows" size="small" style="margin-top:0.5rem;">
            <Column field="design_name" :header="$t('trimble.design')" />
            <Column field="reason" :header="$t('trimble.reason')" />
          </DataTable>
        </div>
      </template>
    </Card>

    <Card v-if="previewData && canExecute" class="mb-card card-warn-border">
      <template #title>{{ $t('trimble.pushToProduuzitTitle') }}</template>
      <template #content>
        <Message severity="warn" :closable="false" style="margin-bottom:1rem;">
          <strong>{{ $t('trimble.explicitConfirm') }}</strong>
        </Message>
        <div v-if="selectedCount" class="mb-sm" style="margin-bottom:0.75rem">
          <Button :label="$t('trimble.pushSelected')" icon="pi pi-cloud-upload" severity="warning" @click="doImport" :loading="importing" />
        </div>
        <div v-else class="mb-sm" style="margin-bottom:0.75rem">
          <Button :label="$t('trimble.pushToProduuzit')" icon="pi pi-cloud-upload" severity="warning" @click="doImport" :loading="importing" />
        </div>
      </template>
    </Card>

    <Card v-if="importResults.length" class="mb-card">
      <template #title>{{ $t('trimble.importResultsTitle') }}</template>
      <template #content>
        <Message v-if="importSummary.error === 0 && importSummary.blocked === 0" severity="success" :closable="false" style="margin-bottom:0.75rem;">
          <strong>{{ $t('trimble.importSuccess') }}</strong>
        </Message>
        <Message v-else severity="warn" :closable="false" style="margin-bottom:0.75rem;">
          {{ $t('trimble.importPartialSuccess') }}
        </Message>
        <div class="summary-chips" style="margin-bottom:0.75rem;">
          <span class="chip-new">{{ importSummary.designs_created }} {{ $t('trimble.designsCreated') }}</span>
          <span class="chip-new">{{ importSummary.constructibles_created }} {{ $t('trimble.constructiblesCreated') }}</span>
          <span class="chip-changed">{{ importSummary.updated }} {{ $t('trimble.updated') }}</span>
          <span class="chip-identical">{{ importSummary.skipped }} {{ $t('trimble.skipped') }}</span>
          <span v-if="importSummary.blocked" class="chip-blocked">{{ importSummary.blocked }} {{ $t('trimble.blocked') }}</span>
          <span v-if="importSummary.error" class="chip-blocked">{{ importSummary.error }} {{ $t('trimble.errors') }}</span>
        </div>
        <DataTable v-if="importResults.some(r => r.status === 'error' || r.status === 'blocked')"
          :value="importResults.filter(r => r.status === 'error' || r.status === 'blocked')" size="small" style="margin-top:0.5rem;">
          <Column field="design_name" :header="$t('trimble.design')" />
          <Column field="client_order_id" :header="$t('trimble.orderId')" />
          <Column field="batch" :header="$t('trimble.batch')" />
          <Column field="reason" :header="$t('trimble.reason')" />
        </DataTable>
      </template>
    </Card>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
const { t } = useI18n()
const route = useRoute()
import { api } from '../api.js'
import ColumnMapper from '../components/ColumnMapper.vue'
import ConfirmedButton from '../components/ConfirmedButton.vue'
import { useProduuzitProjects } from '../composables/useProduuzitProjects.js'
import { useNotifications } from '../composables/useNotifications.js'

const { notify } = useNotifications()

const authStatus = ref(false)
const loadingStatus = ref(false)
const startingLogin = ref(false)

const trimbleProjects = ref([])
const loadingProjects = ref(false)
const projectsError = ref('')
const modelFiles = ref([])
const selectedProject = ref(null)
const selectedFile = ref(null)
const selectedFileVersionId = ref(null)
const loadingFiles = ref(false)

const psetDefs = ref([])
const psetFilter = ref('')
const psetChecks = ref({})
const propChecks = ref({})

const { projects: produuzitProjects, superprojects, loading: projectsLoading, error: produuzitProjectsError, projectsForSuperproject } = useProduuzitProjects()
const selectedSuperproject = ref('')
const selectedProjectUuids = ref(new Set())
const produuzitContext = ref(null)

const filteredProjects = computed(() =>
  selectedSuperproject.value ? projectsForSuperproject(selectedSuperproject.value) : []
)

const hasSelectedProjects = computed(() => selectedProjectUuids.value.size > 0)
const selectedTargetProjects = computed(() => filteredProjects.value.filter(p => selectedProjectUuids.value.has(p.uuid)))

const columnMapping = ref({})
const synonyms = ref({})

const allSelectedProps = computed(() => {
  const props = []
  for (const [key, checked] of Object.entries(propChecks.value))
    if (checked) props.push(key)
  return props
})

function normalizedKey(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
}

// Reverse lookup: normalized synonym → canonical Produuzit field (from config.yaml)
const synonymLookup = computed(() => {
  const map = {}
  for (const [canonical, syns] of Object.entries(synonyms.value)) {
    for (const syn of Array.isArray(syns) ? syns : []) {
      const key = normalizedKey(syn)
      if (key) map[key] = canonical
    }
  }
  return map
})

const initialIfcMapping = computed(() => {
  const m = {}
  // config.yaml canonical keys → Produuzit target names
  const CANONICAL_TARGET = { design: 'design_name', batch: 'batch_number' }
  const lookup = synonymLookup.value
  // Longest synonym first so substring fallback prefers the most specific match
  const entries = Object.entries(lookup).sort((a, b) => b[0].length - a[0].length)

  for (const prop of allSelectedProps.value) {
    const leaf = normalizedKey(prop.split('.').pop())
    if (!leaf) continue
    let canonical = lookup[leaf]
    if (!canonical) {
      for (const [synKey, canon] of entries) {
        if (synKey.length >= 3 && leaf.includes(synKey)) {
          canonical = canon
          break
        }
      }
    }
    if (!canonical) continue
    const target = CANONICAL_TARGET[canonical] || canonical
    if (target && !Object.values(m).includes(target)) m[prop] = target
  }
  return m
})

const mappingWarnings = computed(() => {
  const targets = Object.values(columnMapping.value).flatMap(v => Array.isArray(v) ? v : [v])
  const w = []
  if (!targets.includes('design_name')) w.push(t('trimble.noDesignName'))
  if (!targets.includes('batch_number')) w.push(t('trimble.noBatchNumber'))
  return w
})

const hasRequiredMapping = computed(() => {
  const targets = Object.values(columnMapping.value).flatMap(v => Array.isArray(v) ? v : [v])
  return targets.includes('design_name') && targets.includes('batch_number')
})

const dedupLabel = computed(() => {
  if (uniqueKeyProp.value) return uniqueKeyProp.value.split('.').pop()
  return 'entity id (no key selected)'
})

const _rawEntities = ref([])
const previewEntities = computed(() =>
  includeAssemblies.value
    ? _rawEntities.value
    : _rawEntities.value.filter(e => String(e.type || '').toUpperCase() !== 'IFCELEMENTASSEMBLY')
)
const totalEntities = ref(0)
const fetchingEntities = ref(false)
const uniqueOnly = ref(false)
const uniqueKeyProp = ref('')
const includeAssemblies = ref(true)
watch(includeAssemblies, () => { selectedEntityIndices.value = new Set() })
const rawSampleEntity = ref(null)
const fetchingRawSample = ref(false)

const importing = ref(false)
const previewing = ref(false)
const previewData = ref(null)
const previewError = ref('')
const importResults = ref([])
const importSummary = ref({ designs_created: 0, constructibles_created: 0, updated: 0, skipped: 0, blocked: 0, error: 0 })
const uniqueOnlyImport = ref(true)

const creatingDesigns = ref(false)
const designCreateResults = ref([])
const designCreateCreatedCount = computed(() => designCreateResults.value.filter(r => r.status === 'created').length)
const designCreateFailedCount = computed(() => designCreateResults.value.filter(r => r.status === 'error').length)
const designCreateFailedRows = computed(() => designCreateResults.value.filter(r => r.status === 'error'))

const selectedEntityIndices = ref(new Set())

const entityBatchGroups = computed(() => {
  const groups = new Map()
  const batchProp = resolveProp(columnMapping.value, 'batch_number')
  previewEntities.value.forEach((e, i) => {
    const batch = batchProp ? extractProp(e, batchProp) || '__no_batch__' : '__no_batch__'
    if (!groups.has(batch)) groups.set(batch, [])
    groups.get(batch).push(i)
  })
  // Sort low → high by leading number; no-batch entries last
  return new Map([...groups.entries()].sort(([a], [b]) => {
    const na = parseInt(a, 10)
    const nb = parseInt(b, 10)
    if (isNaN(na) && isNaN(nb)) return String(a).localeCompare(String(b))
    if (isNaN(na)) return 1
    if (isNaN(nb)) return -1
    return na - nb
  }))
})

const selectedCount = computed(() => selectedEntityIndices.value.size)

// Entity table filter/sort state
const entityFilter = ref('')
const propFilter = ref('')
const displayProps = computed(() => {
  const q = propFilter.value.trim().toLowerCase()
  const props = q ? allSelectedProps.value.filter(p => p.toLowerCase().includes(q)) : allSelectedProps.value
  return props.slice(0, 12)
})

const selectedEntities = computed(() =>
  previewEntities.value.filter((_, i) => selectedEntityIndices.value.has(i))
)

// Map entity object → its index in previewEntities. Selection is tracked by
// index, but the DataTable's row `index` reflects the sorted/filtered view, so
// we resolve the real index from the row object itself.
const entityIndexMap = computed(() => {
  const m = new Map()
  previewEntities.value.forEach((e, i) => m.set(e, i))
  return m
})

function entityIndex(entity) {
  return entityIndexMap.value.get(entity) ?? -1
}

function toggleEntity(index) {
  if (index < 0) return
  const s = new Set(selectedEntityIndices.value)
  s.has(index) ? s.delete(index) : s.add(index)
  selectedEntityIndices.value = s
}

function selectAllEntities() {
  selectedEntityIndices.value = new Set(previewEntities.value.map((_, i) => i))
}

function deselectAllEntities() {
  selectedEntityIndices.value = new Set()
}

const batchSelectionState = computed(() => {
  const state = new Map()
  for (const [batch, indices] of entityBatchGroups.value) {
    const count = indices.filter(i => selectedEntityIndices.value.has(i)).length
    state.set(batch, count === 0 ? 'none' : count === indices.length ? 'all' : 'some')
  }
  return state
})

function toggleBatch(batchKey) {
  const indices = entityBatchGroups.value.get(batchKey) || []
  const s = new Set(selectedEntityIndices.value)
  const allSelected = indices.every(i => s.has(i))
  if (allSelected) {
    indices.forEach(i => s.delete(i))
  } else {
    indices.forEach(i => s.add(i))
  }
  selectedEntityIndices.value = s
}

const canExecute = computed(() =>
  previewData.value?.batch_previews?.some(bp => !bp.blocked && (bp.summary.new > 0 || bp.summary.changed > 0))
)

const previewRows = computed(() => {
  const rows = []
  for (const bp of previewData.value?.batch_previews || []) {
    for (const r of bp.rows || []) {
      rows.push({ ...r, batch_name: bp.batch_name })
    }
  }
  return rows
})

function statusLabel(status) {
  if (status === 'new') return t('trimble.statusNew')
  if (status === 'changed') return t('trimble.statusChanged')
  if (status === 'identical') return t('trimble.statusIdentical')
  if (status === 'blocked') return t('trimble.statusBlocked')
  return status
}

function formatChanges(row) {
  const fields = row.changed_fields || []
  return fields.map(f => {
    const oldVal = row.existing?.[f]
    const newVal = row.proposed?.[f]
    const fmt = v => v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    return `${f}: ${fmt(oldVal)} → ${fmt(newVal)}`
  }).join(' | ')
}


const totalSelectedProps = computed(() => allSelectedProps.value.length)

const filteredPsets = computed(() => {
  const q = psetFilter.value.toLowerCase()
  if (!q) return psetDefs.value
  return psetDefs.value.filter(p => (p.name || '').toLowerCase().includes(q))
})

const estimatedCreates = computed(() => {
  if (uniqueOnlyImport.value && totalEntities.value > 0) return Math.min(totalEntities.value, previewEntities.value.length)
  return totalEntities.value
})

const previewRowsForMapping = computed(() => {
  if (!previewEntities.value.length) return []
  return previewEntities.value.slice(0, 3).map(flattenEntity)
})

onMounted(async () => {
  loadSynonyms()
  if (route.query.auth === 'success') {
    await loadAuthStatus()
    if (authStatus.value) await loadTrimbleProjects()
  }
  await Promise.all([loadAuthStatus()])
  if (authStatus.value) await loadTrimbleProjects()
})

async function loadSynonyms() {
  try { const r = await api.get('/api/config/synonyms'); synonyms.value = r.data || {} }
  catch { synonyms.value = {} }
}

async function loadAuthStatus() {
  loadingStatus.value = true
  try { const r = await api.get('/api/trimble/auth/status'); authStatus.value = !!r.data.authenticated }
  catch { authStatus.value = false }
  finally { loadingStatus.value = false }
}



async function startLogin() {
  startingLogin.value = true
  try {
    const r = await api.get('/api/trimble/auth/start')
    window.location.href = r.data.url
  } finally { startingLogin.value = false }
}

async function loadTrimbleProjects() {
  loadingProjects.value = true
  projectsError.value = ''
  try {
    const r = await api.get('/api/trimble/projects')
    trimbleProjects.value = Array.isArray(r.data) ? r.data : (r.data?.results || [])
  } catch (e) {
    const msg = e?.response?.data?.detail || e?.response?.data?.error || e?.message || String(e)
    const isTokenError = /invalid.*(token|refresh)|token.*invalid|401/i.test(msg)
    if (isTokenError) {
      await api.post('/api/trimble/auth/disconnect').catch(() => {})
      authStatus.value = false
      projectsError.value = ''
    } else {
      projectsError.value = msg
      console.error('[trimble] loadTrimbleProjects failed:', msg)
    }
  } finally { loadingProjects.value = false }
}

async function onProjectChange() {
  modelFiles.value = []; psetDefs.value = []; _rawEntities.value = []; importResults.value = []; selectedEntityIndices.value = new Set()
  selectedFile.value = null; selectedFileVersionId.value = null
}

async function loadProjectFiles() {
  if (!selectedProject.value) return
  loadingFiles.value = true
  modelFiles.value = []; psetDefs.value = []; _rawEntities.value = []; importResults.value = []; selectedEntityIndices.value = new Set()
  selectedFile.value = null; selectedFileVersionId.value = null
  try {
    const r = await api.get(`/api/trimble/projects/${selectedProject.value}/tree`)
    modelFiles.value = (r.data?.items || []).map(f => ({
      ...f,
      _display: `${f.name || f.filename || f.id}${f._releaseName ? '  [' + f._releaseName + ']' : ''}${f._parent ? '  ' + f._parent : ''}`,
    }))
  } catch { modelFiles.value = [] }
  finally { loadingFiles.value = false }
}

function onFileSelected() {
  psetDefs.value = []; _rawEntities.value = []; importResults.value = []; selectedEntityIndices.value = new Set()
  const f = modelFiles.value.find(x => x.id === selectedFile.value)
  selectedFileVersionId.value = f?.versionId || null
  if (selectedFile.value) loadPsetDefs()
}

async function loadPsetDefs() {
  if (!selectedFile.value) return
  try {
    const params = {}
    if (selectedFileVersionId.value) params.versionId = selectedFileVersionId.value
    const r = await api.get(`/api/trimble/models/${selectedFile.value}/psetdefs`, { params })
    const data = r.data
    let raw = []
    if (data.psetdefs) raw = data.psetdefs
    else if (Array.isArray(data)) raw = data
    else if (data.results) raw = data.results
    psetDefs.value = mergePsetsByName(raw)
    psetChecks.value = {}
    propChecks.value = {}
  } catch { psetDefs.value = [] }
}

function mergePsetsByName(raw) {
  const merged = {}
  for (const pset of raw) {
    const name = pset.name || ''
    if (!merged[name]) {
      merged[name] = { name, properties: [] }
    }
    const props = Array.isArray(pset.properties) ? pset.properties
      : (Array.isArray(pset.props) ? pset.props : [])
    for (const prop of props) {
      const pname = typeof prop === 'string' ? prop : (prop?.name || '')
      if (!merged[name].properties.some(ex =>
        (typeof ex === 'string' ? ex : ex?.name) === pname
      )) {
        merged[name].properties.push(prop)
      }
    }
  }
  return Object.values(merged)
}

function propsOfPset(pset) {
  return Array.isArray(pset?.properties) ? pset.properties : (Array.isArray(pset?.props) ? pset.props : [])
}

function propPath(psetName, prop) {
  const pn = typeof prop === 'string' ? prop : (prop?.name || prop?.id || '')
  return `psets.${psetName}.${pn}`
}

function propName(prop) { return typeof prop === 'string' ? prop : (prop?.name || prop?.propertyName || '') }
function propType(prop) { return typeof prop === 'object' ? (prop?.type || '') : '' }

function selectAllProps() {
  for (const pset of psetDefs.value) {
    psetChecks.value[pset.name] = true
    for (const prop of propsOfPset(pset))
      propChecks.value[propPath(pset.name, prop)] = true
  }
}

function clearAllProps() { psetChecks.value = {}; propChecks.value = {} }
function onPsetToggle(pset) { const c = psetChecks.value[pset.name]; for (const prop of propsOfPset(pset)) propChecks.value[propPath(pset.name, prop)] = c }
function emitPropSelection() { /* reactive */ }

async function loadProduuzitContext(projectUuid) {
  if (!projectUuid) return
  try { const r = await api.get(`/api/assemblies/context?project_uuid=${projectUuid}`); produuzitContext.value = r.data }
  catch { /* noop */ }
}

function toggleProject(uuid) {
  const s = new Set(selectedProjectUuids.value)
  s.has(uuid) ? s.delete(uuid) : s.add(uuid)
  selectedProjectUuids.value = s
  // Load context for the last toggled-on project (or clear if none)
  const arr = [...s]
  loadProduuzitContext(arr.length ? arr[arr.length - 1] : null)
}

function onSuperprojectChange() {
  selectedProjectUuids.value = new Set()
  produuzitContext.value = null
}

function onMappingUpdated(m) { columnMapping.value = m }

function flattenEntity(e) { const f = {}; for (const p of allSelectedProps.value) f[p] = extractProp(e, p); return f }

function extractProp(entity, propPathStr) {
  if (!propPathStr) return ''
  const parts = propPathStr.split('.')
  let val = entity
  for (const p of parts) {
    if (val === null || val === undefined) return ''
    if (Array.isArray(val)) {
      const match = val.find(item => typeof item === 'object' && item !== null && (item.pset_name === p || item.name === p))
      if (match !== undefined) { val = match } else { return '' }
    } else if (typeof val === 'object') {
      if (p in val) {
        val = val[p]
      } else {
        const sub = val.props ?? val.properties ?? val.values
        if (sub && typeof sub === 'object') {
          if (Array.isArray(sub)) {
            const found = sub.find(pr => typeof pr === 'string' ? pr === p : (pr?.name === p || pr?.propertyName === p))
            val = found === undefined ? '' : (typeof found === 'string' ? found : (found?.value ?? found?.nominalValue ?? ''))
          } else { val = sub[p] ?? '' }
        } else { return '' }
      }
    } else { return '' }
  }
  return val !== null && val !== undefined ? String(val) : ''
}

async function fetchRawSample() {
  if (!selectedFile.value) return
  fetchingRawSample.value = true
  rawSampleEntity.value = null
  try {
    const versionId = selectedFileVersionId.value || selectedFile.value
    const r = await api.get(`/api/trimble/models/${selectedFile.value}/entities/sample`, { params: { versionId } })
    rawSampleEntity.value = r.data
  } catch (e) {
    rawSampleEntity.value = { error: e?.response?.data || e?.message || String(e) }
  } finally { fetchingRawSample.value = false }
}

async function fetchEntities() {
  if (!selectedFile.value || !allSelectedProps.value.length) return
  fetchingEntities.value = true; _rawEntities.value = []; totalEntities.value = 0; selectedEntityIndices.value = new Set()
  try {
    // Always fetch with assemblies — client-side toggle filters instantly
    const body = { versionId: selectedFileVersionId.value || selectedFile.value, fields: allSelectedProps.value, unique_only: uniqueOnly.value, unique_key_prop: uniqueKeyProp.value || undefined, include_assemblies: true, column_mapping: columnMapping.value }
    const r = await api.post(`/api/trimble/models/${selectedFile.value}/entities`, body)
    _rawEntities.value = r.data.entities || []
    totalEntities.value = r.data.total || _rawEntities.value.length
    if (previewEntities.value.length) console.log('[trimble] sample entity structure:', JSON.stringify(previewEntities.value[0], null, 2))
  } finally { fetchingEntities.value = false }
}

async function doPreview() {
  previewing.value = true; previewData.value = null; previewError.value = ''
  try {
    const ents = selectedEntities.value.length ? selectedEntities.value : previewEntities.value
    const projectUuid = [...selectedProjectUuids.value][0]
    const body = { project_uuid: projectUuid, column_mapping: columnMapping.value, entities: ents, unique_only: uniqueOnlyImport.value }
    const r = await api.post('/api/trimble/preview-import', body)
    previewData.value = r.data
  } catch (e) {
    previewError.value = e?.response?.data?.detail || e?.response?.data?.error || e?.message || String(e)
    console.error('[trimble] preview failed:', previewError.value)
  } finally { previewing.value = false }
}

async function doImport() {
  importing.value = true; importResults.value = []
  try {
    const ents = selectedEntities.value.length ? selectedEntities.value : previewEntities.value
    const projectUuid = [...selectedProjectUuids.value][0]
    const body = { project_uuid: projectUuid, column_mapping: columnMapping.value, entities: ents, unique_only: uniqueOnlyImport.value }
    const r = await api.post('/api/trimble/import', body)
    importResults.value = r.data.results || []
    importSummary.value = r.data.summary || { designs_created: 0, constructibles_created: 0, updated: 0, skipped: 0, blocked: 0, error: 0 }
    previewData.value = null
    const unmatched = importResults.value.filter(x => x.status === 'error' && /No batch named/.test(x.reason || ''))
    if (importSummary.value.error) {
      notify({ severity: 'error', summary: t('trimble.errors'), detail: t('trimble.importErrorsDetail', { count: importSummary.value.error }), life: 8000 })
    }
    if (unmatched.length) {
      notify({ severity: 'warn', summary: t('trimble.batchesNotMatched', { batches: unmatched.map(x => x.batch).join(', ') }), detail: '', life: 8000 })
    } else if (importSummary.value.designs_created || importSummary.value.constructibles_created || importSummary.value.updated) {
      notify({ severity: 'success', summary: t('trimble.pushToProduuzitTitle'), detail: t('trimble.importSuccessDetail', { designs: importSummary.value.designs_created, constructibles: importSummary.value.constructibles_created }), life: 5000 })
    }
  } finally { importing.value = false }
}

async function createMissingDesignsAction() {
  const missing = previewData.value?.unresolved_designs || []
  if (!missing.length) return
  creatingDesigns.value = true
  designCreateResults.value = []
  try {
    const projectUuid = [...selectedProjectUuids.value][0]
    const r = await api.post('/api/trimble/create-missing-designs', {
      project_uuid: projectUuid,
      design_names: missing,
    })
    designCreateResults.value = r.data.results || []
    const summary = r.data.summary || { created: 0, failed: 0 }
    if (summary.failed) {
      notify({ severity: 'error', summary: t('trimble.designsCreatePartial', { created: summary.created, failed: summary.failed }), life: 8000 })
    } else if (summary.created) {
      notify({ severity: 'success', summary: t('trimble.designsCreated', { count: summary.created }), life: 5000 })
    }
    // Refresh the preview so the newly created designs resolve and appear in
    // the normal import confirmation step.
    if (summary.created) await doPreview()
  } catch (e) {
    const msg = e?.response?.data?.detail || e?.response?.data?.error || e?.message || String(e)
    notify({ severity: 'error', summary: t('trimble.createDesignsFailed'), detail: msg, life: 8000 })
  } finally {
    creatingDesigns.value = false
  }
}

function resolveProp(columnMappingObj, target) {
  for (const [ifcProp, prodTarget] of Object.entries(columnMappingObj)) {
    if (prodTarget === target) return ifcProp
    if (Array.isArray(prodTarget) && prodTarget.includes(target)) return ifcProp
  }
  return ''
}
</script>

<style scoped>
.trimble-import { max-width: 1440px; margin: 0 auto; }
.page-header { margin-bottom: 1.25rem; }
.page-subtitle { color: #6b7280; font-size: 0.9rem; margin-top: 0.25rem; }
.subtitle-dim { font-weight: 400; font-size: 0.85rem; color: #6b7280; }
.field-label { display: block; font-size: 0.8rem; font-weight: 600; color: #4b5563; margin-bottom: 0.25rem; }
.wide { width: 100%; }
.mb-card { margin-bottom: 1rem; }
.card-warn-border { border-left: 4px solid #f59e0b; }
.card-danger-border { border-left: 4px solid #ef4444; }

.pset-block { margin-bottom: 0.5rem; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; }
.pset-header { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; background: #f9fafb; }
.pset-label { font-weight: 600; font-size: 0.9rem; flex: 1; cursor: pointer; }
.pset-count { color: #9ca3af; font-size: 0.75rem; }
.pset-props { padding: 0.25rem 0.75rem 0.5rem 2rem; }
.prop-row { display: flex; align-items: center; gap: 0.4rem; padding: 0.2rem 0; }
.prop-label { font-size: 0.82rem; cursor: pointer; }
.prop-type { color: #9ca3af; font-size: 0.7rem; margin-left: auto; }

.summary-chips { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.chip-new { background: #dcfce7; color: #166534; padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.8rem; font-weight: 600; }
.chip-changed { background: #fef3c7; color: #92400e; padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.8rem; font-weight: 600; }
.chip-identical { background: #e0e7ff; color: #3730a3; padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.8rem; font-weight: 600; }
.chip-blocked { background: #fce4ec; color: #b91c1c; padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.8rem; font-weight: 600; }
</style>
