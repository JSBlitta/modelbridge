<template>
  <div class="trimble-import">
    <div class="page-header">
      <h2 class="page-title">Trimble Connect</h2>
      <p class="page-subtitle">Browse IFC models, pick properties, map to Produuzit, and push with explicit approval.</p>
    </div>

    <!-- Connect (hidden once authenticated) -->
    <Card v-if="!authStatus" class="mb-card">
      <template #title>Connect</template>
      <template #content>
        <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;">
          <Tag :severity="authStatus ? 'success' : 'warn'" :value="authStatus ? $t('trimble.connected') : $t('trimble.notConnected')" />
          <Button :label="$t('trimble.openLogin')" icon="pi pi-external-link" @click="startLogin" :loading="startingLogin" />
          <Tag v-if="oauthPolling" severity="info" :value="$t('trimble.waitingLogin')" />
          <Button :label="$t('trimble.refreshStatus')" icon="pi pi-refresh" text @click="loadAuthStatus" :loading="loadingStatus" />
        </div>
        <Message v-if="oauthPolling" severity="info" :closable="false" size="small" style="margin-top:0.5rem;">
          {{ $t('trimble.callbackInfo') }}
        </Message>
        <Message v-if="!authStatus && !oauthPolling" severity="secondary" :closable="false" size="small" style="margin-top:0.5rem;">
          {{ $t('trimble.callbackFallback') }}
        </Message>
        <div v-if="!authStatus && !oauthPolling" style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-top:0.75rem;">
          <InputText v-model="authCode" placeholder="Paste full URL (http://localhost:PORT/callback/?code=...)" style="min-width:320px;flex:1;" />
          <Button :label="$t('trimble.exchangeCode')" icon="pi pi-key" severity="secondary" @click="exchangeAuthCode" :loading="exchangingCode" />
        </div>
        <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-top:0.5rem;">
          <InputText v-model="manualToken" placeholder="Or paste access token directly" style="min-width:320px;flex:1;" />
          <Button :label="$t('trimble.setToken')" icon="pi pi-lock" text @click="saveManualToken" :loading="savingToken" />
        </div>
        <Message severity="warn" :closable="false" style="margin-top:1rem;">
          {{ $t('trimble.noAutoPush') }}
        </Message>
      </template>
    </Card>

    <!-- Select Model (shown once authenticated) -->
    <Card v-if="authStatus" class="mb-card">
      <template #title>Select Model</template>
      <template #content>
        <div style="display:flex;gap:1rem;align-items:flex-end;flex-wrap:wrap;">
          <div style="flex:1;min-width:280px;">
            <label class="field-label">Trimble Project</label>
            <Select v-model="selectedProject" :options="trimbleProjects" option-label="name" option-value="id"
              placeholder="Select project..." class="wide" @change="onProjectChange" />
          </div>
          <Button :label="$t('trimble.loadFiles')" icon="pi pi-folder-open" @click="loadProjectFiles" :loading="loadingFiles" :disabled="!selectedProject" />
        </div>
        <div v-if="loadingFiles" style="margin-top:0.5rem;color:#6b7280;font-size:0.85rem;">Scanning project for IFC files&hellip;</div>
        <div v-if="modelFiles.length" style="margin-top:0.75rem;">
          <label class="field-label">IFC Model File <span style="font-weight:400;color:#6b7280;">({{ modelFiles.length }} found)</span></label>
          <Select v-model="selectedFile" :options="modelFiles" option-label="_display" option-value="id"
            placeholder="Select an IFC file..." class="wide" @change="onFileSelected" />
        </div>
        <Message v-if="selectedProject && !loadingFiles && modelFiles.length === 0" severity="info" :closable="false" style="margin-top:0.75rem;">
          No IFC files found in this project. Try a different project.
        </Message>
      </template>
    </Card>

    <!-- 3: Select Properties -->
    <Card v-if="psetDefs.length" class="mb-card">
      <template #title>Property Sets <span class="subtitle-dim">({{ totalSelectedProps }} selected)</span></template>
      <template #content>
        <div style="margin-bottom:0.75rem;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
          <Button :label="$t('trimble.selectAll')" icon="pi pi-check-square" text size="small" @click="selectAllProps" />
          <Button :label="$t('trimble.clearAll')" icon="pi pi-stop" text size="small" @click="clearAllProps" />
          <InputText v-model="psetFilter" placeholder="Filter psets..." size="small" style="width:200px;" />
        </div>
        <Message v-if="!psetDefs.length" severity="info" :closable="false">No property sets found for this model.</Message>
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

    <!-- 4: Map to Produuzit -->
    <Card v-if="allSelectedProps.length" class="mb-card">
      <template #title>Map to Produuzit</template>
      <template #content>
        <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem;">
          <div>
            <label class="field-label">Target Produuzit Project</label>
            <Select v-model="targetProjectUuid" :options="produuzitProjects" option-label="name" option-value="uuid"
              placeholder="Select Produuzit project..." style="min-width:280px;" @change="loadProduuzitContext" />
            <small v-if="produuzitProjectsError" style="color:#ef4444;display:block;margin-top:2px;">
              ⚠ {{ produuzitProjectsError }}
            </small>
          </div>
          <Tag v-if="produuzitContext" severity="secondary"
            :value="`${produuzitContext.designs?.length || 0} designs | ${produuzitContext.batches?.length || 0} batches`" />
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

    <!-- 5: Preview -->
    <Card v-if="allSelectedProps.length && targetProjectUuid" class="mb-card">
      <template #title>Preview Entities</template>
      <template #content>
        <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem;">
          <Button :label="$t('trimble.fetchEntities')" icon="pi pi-download" @click="fetchEntities" :loading="fetchingEntities"
            :disabled="!selectedFile" />
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <Checkbox v-model="uniqueOnly" :binary="true" input-id="unique_toggle" />
            <label for="unique_toggle" style="font-size:0.85rem;cursor:pointer;">Unique records only</label>
          </div>
          <Tag v-if="totalEntities > 0" severity="info" :value="`${previewEntities.length} of ${totalEntities} entities`" />
        </div>
        <Message v-if="uniqueOnly" severity="secondary" :closable="false" size="small" style="margin-bottom:0.5rem;">
          Unique mode: duplicate (batch &times; design) combos collapsed to first instance only.
        </Message>
        <DataTable v-if="previewEntities.length" :value="previewEntities.slice(0, 20)" size="small" striped-rows scrollable scroll-height="400px">
          <Column v-for="prop in allSelectedProps.slice(0, 8)" :key="prop" :field="prop" :header="prop.split('.').pop()" style="min-width:120px;">
            <template #body="{ data }">{{ extractProp(data, prop) }}</template>
          </Column>
        </DataTable>
        <div v-if="!previewEntities.length && !fetchingEntities" style="color:#6b7280;font-size:0.85rem;">Click Fetch Entities.</div>
      </template>
    </Card>

    <!-- 6: Preview & Push -->
    <Card v-if="previewEntities.length && hasRequiredMapping" class="mb-card card-warn-border">
      <template #title>Preview &amp; Push to Produuzit</template>
      <template #content>
        <Message severity="warn" :closable="false" style="margin-bottom:1rem;">
          <strong>Explicit confirmation required.</strong> No automatic sync runs.
        </Message>
        <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem;">
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <Checkbox v-model="uniqueOnlyImport" :binary="true" input-id="unique_toggle_import" />
            <label for="unique_toggle_import" style="font-size:0.85rem;cursor:pointer;">Deduplicate before import</label>
          </div>
          <Button :label="$t('trimble.checkChanges')" icon="pi pi-search" @click="doPreview" :loading="previewing" />
        </div>

        <!-- Per-batch preview summary -->
        <div v-if="previewData" style="margin-bottom:1rem;">
          <Message v-if="previewData.unresolved_batches?.length" severity="error" :closable="false" size="small">
            Batch numbers not matched: {{ previewData.unresolved_batches.join(', ') }}
          </Message>
          <Message v-if="previewData.unresolved_designs?.length" severity="error" :closable="false" size="small">
            Designs not found: {{ previewData.unresolved_designs.slice(0, 5).join(', ') }}{{ previewData.unresolved_designs.length > 5 ? '…' : '' }}
          </Message>
          <div v-for="bp in previewData.batch_previews" :key="bp.batch_uuid"
            style="display:flex;gap:0.5rem;align-items:center;padding:0.3rem 0;border-bottom:1px solid #f3f4f6;">
            <Tag :severity="bp.blocked ? 'danger' : 'secondary'" :value="bp.batch_name" />
            <span class="chip-new">{{ bp.summary.new }}↑ new</span>
            <span class="chip-changed">{{ bp.summary.changed }}~ changed</span>
            <span class="chip-identical" style="color:#9ca3af">{{ bp.summary.identical }}= identical</span>
            <Tag v-if="bp.blocked" severity="danger" value="BLOCKED" />
          </div>
          <div v-if="canExecute" style="margin-top:0.75rem;">
            <Button :label="$t('trimble.pushToProduuzit')" icon="pi pi-cloud-upload" severity="warning" @click="doImport" :loading="importing" />
          </div>
          <Message v-else-if="previewData" severity="secondary" :closable="false" size="small" style="margin-top:0.5rem;">
            Nothing to push — all batches are blocked or identical.
          </Message>
        </div>

        <div v-if="importResults.length" style="margin-top:1rem;">
          <div class="summary-chips">
            <span class="chip-new">{{ importSummary.created }} created</span>
            <span class="chip-changed">{{ importSummary.updated }} updated</span>
            <span class="chip-identical">{{ importSummary.skipped }} skipped</span>
            <span v-if="importSummary.blocked" class="chip-blocked">{{ importSummary.blocked }} blocked</span>
            <span v-if="importSummary.error" class="chip-blocked">{{ importSummary.error }} errors</span>
          </div>
          <DataTable v-if="importResults.some(r => r.status === 'error' || r.status === 'blocked')"
            :value="importResults.filter(r => r.status === 'error' || r.status === 'blocked')" size="small" style="margin-top:0.5rem;">
            <Column field="design_name" :header="$t('trimble.design')" />
            <Column field="client_order_id" :header="$t('trimble.orderId')" />
            <Column field="batch" :header="$t('trimble.batch')" />
            <Column field="reason" :header="$t('trimble.reason')" />
          </DataTable>
        </div>
      </template>
    </Card>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { api } from '../api.js'
import ColumnMapper from '../components/ColumnMapper.vue'

const authStatus = ref(false)
const loadingStatus = ref(false)
const startingLogin = ref(false)
const savingToken = ref(false)
const manualToken = ref('')
const authCode = ref('')
const exchangingCode = ref(false)
let oauthPollTimer = null
const oauthPolling = ref(false)

const trimbleProjects = ref([])
const modelFiles = ref([])
const selectedProject = ref(null)
const selectedFile = ref(null)
const selectedFileVersionId = ref(null)
const loadingFiles = ref(false)

const psetDefs = ref([])
const psetFilter = ref('')
const psetChecks = ref({})
const propChecks = ref({})

const produuzitProjects = ref([])
const produuzitProjectsError = ref('')
const targetProjectUuid = ref(null)
const produuzitContext = ref(null)

const columnMapping = ref({})

const allSelectedProps = computed(() => {
  const props = []
  for (const [key, checked] of Object.entries(propChecks.value))
    if (checked) props.push(key)
  return props
})

const initialIfcMapping = computed(() => {
  const m = {}
  for (const prop of allSelectedProps.value) {
    const leaf = prop.split('.').pop()?.toLowerCase() || ''
    if ((leaf.includes('element') || leaf.includes('nummer') || leaf.includes('name')) && !Object.values(m).includes('design_name'))
      m[prop] = 'design_name'
    else if ((leaf.includes('batch') || leaf.includes('levering') || leaf.includes('productie')) && !Object.values(m).includes('batch_number'))
      m[prop] = 'batch_number'
  }
  return m
})

const mappingWarnings = computed(() => {
  const targets = Object.values(columnMapping.value)
  const w = []
  if (!targets.includes('design_name')) w.push('No Design Name mapped (required)')
  if (!targets.includes('batch_number')) w.push('No Batch Number mapped (required)')
  return w
})

const hasRequiredMapping = computed(() =>
  Object.values(columnMapping.value).includes('design_name') &&
  Object.values(columnMapping.value).includes('batch_number'))

const previewEntities = ref([])
const totalEntities = ref(0)
const fetchingEntities = ref(false)
const uniqueOnly = ref(true)

const importing = ref(false)
const previewing = ref(false)
const previewData = ref(null)
const importResults = ref([])
const importSummary = ref({ created: 0, updated: 0, skipped: 0, blocked: 0, error: 0 })
const uniqueOnlyImport = ref(true)

const canExecute = computed(() =>
  previewData.value?.batch_previews?.some(bp => !bp.blocked && (bp.summary.new > 0 || bp.summary.changed > 0))
)

const targetProjectName = computed(() => {
  const p = produuzitProjects.value.find(x => x.uuid === targetProjectUuid.value)
  return p?.name || targetProjectUuid.value || ''
})

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
  await Promise.all([loadAuthStatus(), loadProduuzitProjects()])
  if (authStatus.value) await loadTrimbleProjects()
})

onUnmounted(() => {
  stopOauthPolling()
})

async function loadAuthStatus() {
  loadingStatus.value = true
  try { const r = await api.get('/api/trimble/auth/status'); authStatus.value = !!r.data.authenticated }
  catch { authStatus.value = false }
  finally { loadingStatus.value = false }
}

async function loadProduuzitProjects() {
  produuzitProjectsError.value = ''
  try {
    const r = await api.get('/api/projects?limit=200')
    produuzitProjects.value = r.data.results || []
    if (!produuzitProjects.value.length) console.warn('[api-coupler] /api/projects/ returned 0 results. Full response:', r.data)
  } catch (e) {
    const msg = e?.response?.data?.detail || e?.response?.data?.error || e?.message || String(e)
    produuzitProjectsError.value = msg
    console.error('[api-coupler] loadProduuzitProjects failed:', msg, e?.response?.data)
  }
}

async function startLogin() {
  startingLogin.value = true
  try {
    const r = await api.get('/api/trimble/auth/start')
    window.open(r.data.url, '_blank', 'noopener,noreferrer')
    // Start polling for OAuth callback completion
    startOauthPolling()
  } finally { startingLogin.value = false }
}

function startOauthPolling() {
  stopOauthPolling()
  oauthPolling.value = true
  let attempts = 0
  const maxAttempts = 120 // 4 minutes at 2s intervals

  oauthPollTimer = setInterval(async () => {
    attempts++
    try {
      const r = await api.get('/api/trimble/auth/callback-status')
      if (r.data.completed) {
        stopOauthPolling()
        if (r.data.authenticated) {
          authStatus.value = true
          await loadTrimbleProjects()
        } else if (r.data.error) {
          console.warn('OAuth callback error:', r.data.error)
        }
        // Stop the server
        await api.post('/api/trimble/auth/stop-server').catch(() => {})
        return
      }
      if (attempts >= maxAttempts) {
        stopOauthPolling()
        await api.post('/api/trimble/auth/stop-server').catch(() => {})
      }
    } catch {
      if (attempts >= maxAttempts) stopOauthPolling()
    }
  }, 2000)
}

function stopOauthPolling() {
  if (oauthPollTimer) {
    clearInterval(oauthPollTimer)
    oauthPollTimer = null
  }
  oauthPolling.value = false
}

async function saveManualToken() {
  const t = manualToken.value.trim(); if (!t) return
  savingToken.value = true
  try { await api.post('/api/trimble/auth/token', { token: t }); manualToken.value = ''; await loadAuthStatus(); await loadTrimbleProjects() }
  finally { savingToken.value = false }
}

async function exchangeAuthCode() {
  let raw = authCode.value.trim()
  if (!raw) return
  // Accept full URL like http://localhost/?code=xxx&state=yyy — extract just the code
  const urlMatch = raw.match(/[?&]code=([^&#]+)/)
  const code = urlMatch ? decodeURIComponent(urlMatch[1]) : raw
  exchangingCode.value = true
  try { await api.post('/api/trimble/auth/exchange-code', { code }); authCode.value = ''; await loadAuthStatus(); await loadTrimbleProjects() }
  finally { exchangingCode.value = false }
}

async function loadTrimbleProjects() {
  try { const r = await api.get('/api/trimble/projects'); trimbleProjects.value = Array.isArray(r.data) ? r.data : (r.data?.results || []) }
  catch { /* noop */ }
}

async function onProjectChange() {
  modelFiles.value = []; psetDefs.value = []; previewEntities.value = []; importResults.value = []
  selectedFile.value = null; selectedFileVersionId.value = null
}

async function loadProjectFiles() {
  if (!selectedProject.value) return
  loadingFiles.value = true
  modelFiles.value = []; psetDefs.value = []; previewEntities.value = []  ; importResults.value = []
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
  psetDefs.value = []; previewEntities.value = []; importResults.value = []
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

async function loadProduuzitContext() {
  if (!targetProjectUuid.value) return
  try { const r = await api.get(`/api/assemblies/context?project_uuid=${targetProjectUuid.value}`); produuzitContext.value = r.data }
  catch { /* noop */ }
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
      const match = val.find(item => (typeof item === 'object' && item !== null) && (item.pset_name === p || item.name === p))
      val = match || ''
    } else if (typeof val === 'object') { val = val[p] }
    else { return '' }
  }
  return val !== null && val !== undefined ? String(val) : ''
}

async function fetchEntities() {
  if (!selectedFile.value || !allSelectedProps.value.length) return
  fetchingEntities.value = true; previewEntities.value = []; totalEntities.value = 0
  try {
    const body = { versionId: selectedFile.value, fields: allSelectedProps.value, unique_only: uniqueOnly.value, column_mapping: columnMapping.value }
    const r = await api.post(`/api/trimble/models/${selectedFile.value}/entities`, body)
    previewEntities.value = r.data.entities || []
    totalEntities.value = r.data.total || previewEntities.value.length
  } finally { fetchingEntities.value = false }
}

async function doPreview() {
  previewing.value = true; previewData.value = null
  try {
    const body = { project_uuid: targetProjectUuid.value, column_mapping: columnMapping.value, entities: previewEntities.value, unique_only: uniqueOnlyImport.value }
    const r = await api.post('/api/trimble/preview-import', body)
    previewData.value = r.data
  } finally { previewing.value = false }
}

async function doImport() {
  importing.value = true; importResults.value = []
  try {
    const body = { project_uuid: targetProjectUuid.value, column_mapping: columnMapping.value, entities: previewEntities.value, unique_only: uniqueOnlyImport.value }
    const r = await api.post('/api/trimble/import', body)
    importResults.value = r.data.results || []
    importSummary.value = r.data.summary || { created: 0, updated: 0, skipped: 0, blocked: 0, error: 0 }
    previewData.value = null
  } finally { importing.value = false }
}
</script>

<style scoped>
.trimble-import { max-width: 960px; }
.page-header { margin-bottom: 1.25rem; }
.page-subtitle { color: #6b7280; font-size: 0.9rem; margin-top: 0.25rem; }
.subtitle-dim { font-weight: 400; font-size: 0.85rem; color: #6b7280; }
.field-label { display: block; font-size: 0.8rem; font-weight: 600; color: #4b5563; margin-bottom: 0.25rem; }
.wide { width: 100%; }
.mb-card { margin-bottom: 1rem; }
.card-warn-border { border-left: 4px solid #f59e0b; }

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
