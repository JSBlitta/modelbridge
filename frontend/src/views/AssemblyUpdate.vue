<template>
  <div>
    <h2 class="page-title">Assembly Update</h2>

    <Message v-if="isDefinitive" severity="warn" style="margin-bottom:1rem;">
      This batch is marked <strong>definitive</strong> in local DB. Proceed with caution.
    </Message>

    <Card class="mb-card">
      <template #title>{{ $t('assemblyUpdate.selectProjectBatch') }}</template>
      <template #content>
        <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-end;">
          <div>
            <label>Project</label><br/>
            <div style="display:flex;gap:0.25rem;align-items:center;">
              <Select v-model="selectedProject" :options="projects" option-label="name" option-value="uuid"
                placeholder="Select project..." style="min-width:250px" @change="loadBatches" />
              <Button icon="pi pi-refresh" text size="small" @click="refreshProjects" v-tooltip.top="'Refresh projects'" />
            </div>
          </div>
          <div>
            <label>Batch</label><br/>
            <Select v-model="selectedBatch" :options="batches" option-label="name" option-value="uuid"
              placeholder="Select batch..." style="min-width:250px" @change="loadAssemblies" />
          </div>
        </div>
      </template>
    </Card>

    <Card v-if="assemblies.length" class="mb-card">
      <template #title>Assemblies ({{ assemblies.length }})</template>
      <template #content>
        <DataTable
          :value="assemblies"
          edit-mode="cell"
          @cell-edit-complete="onCellEdit"
          :row-class="rowClass"
          size="small"
          striped-rows
        >
          <Column field="design" :header="$t('assemblyUpdate.design')" style="min-width:120px" />
          <Column field="scheduled_prod_date" :header="$t('assemblyUpdate.scheduledDate')" style="min-width:140px">
            <template #editor="{ data, field }">
              <InputText v-model="data[field]" />
            </template>
          </Column>
          <Column field="client_order_id" :header="$t('assemblyUpdate.orderId')" style="min-width:120px">
            <template #editor="{ data, field }">
              <InputText v-model="data[field]" />
            </template>
          </Column>
          <Column field="priority" :header="$t('assemblyUpdate.priority')" style="width:90px">
            <template #editor="{ data, field }">
              <InputNumber v-model="data[field]" style="width:70px" />
            </template>
          </Column>
          <Column field="client_meta" :header="$t('assemblyUpdate.clientMeta')" style="min-width:200px">
            <template #body="{ data }">
              <span style="font-size:0.75rem;font-family:monospace;">{{ JSON.stringify(data.client_meta || {}) }}</span>
            </template>
            <template #editor="{ data, field }">
              <Textarea v-model="data[field + '_str']" rows="2" style="width:200px;font-size:0.75rem;" />
            </template>
          </Column>
        </DataTable>
        <div style="margin-top:0.75rem;display:flex;gap:0.75rem;">
          <Button label="Review Changes" icon="pi pi-eye" :disabled="!changedRows.length" @click="showReview = true" />
        </div>
      </template>
    </Card>

    <Dialog v-model:visible="showReview" :header="$t('assemblyUpdate.reviewChanges')" :style="{width:'70vw'}" modal>
      <DataTable :value="changedRows" size="small">
        <Column field="design" :header="$t('assemblyUpdate.design')" />
        <Column field="scheduled_prod_date" :header="$t('assemblyUpdate.schedDate')" />
        <Column field="client_order_id" :header="$t('assemblyUpdate.orderId')" />
        <Column field="priority" :header="$t('assemblyUpdate.priority')" />
      </DataTable>
      <template #footer>
        <Button label="Apply Changes" icon="pi pi-check" class="btn-create" @click="applyChanges" :loading="applying" />
        <Button label="Cancel" severity="secondary" @click="showReview = false" />
      </template>
    </Dialog>

    <Card v-if="updateResults.length" class="mb-card">
      <template #title>Update Results</template>
      <template #content>
        <DataTable :value="updateResults" size="small">
          <Column field="design" :header="$t('assemblyUpdate.design')" />
          <Column field="status" :header="$t('assemblyUpdate.status')">
            <template #body="{ data }">
              <Tag :severity="data.status === 'updated' ? 'success' : 'danger'" :value="data.status" />
            </template>
          </Column>
          <Column field="error" :header="$t('assemblyUpdate.error')" />
        </DataTable>
      </template>
    </Card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { api } from '../api.js'

// Module-level cache — survives component unmount/remount during navigation
let _projectsCache = null
let _dbBatchesCache = null

const projects = ref([])
const batches = ref([])
const selectedProject = ref(null)
const selectedBatch = ref(null)
const assemblies = ref([])
const changedUuids = ref(new Set())
const showReview = ref(false)
const applying = ref(false)
const updateResults = ref([])
const dbBatches = ref([])

const isDefinitive = computed(() => {
  if (!selectedBatch.value) return false
  const db = dbBatches.value.find(b => b.uuid === selectedBatch.value)
  return db?.state === 'definitive'
})

const changedRows = computed(() => assemblies.value.filter(a => changedUuids.value.has(a.uuid)))

async function loadProjects() {
  if (_projectsCache) {
    projects.value = _projectsCache
    return
  }
  try {
    const res = await api.get('/api/projects?limit=100')
    _projectsCache = res.data.results || []
    projects.value = _projectsCache
    if (!projects.value.length) console.warn('[api-coupler] /api/projects/ returned 0 results:', res.data)
  } catch (e) {
    console.error('[api-coupler] Failed to load projects:', e?.response?.data || e?.message)
  }
}

async function loadDbBatches() {
  if (_dbBatchesCache) {
    dbBatches.value = _dbBatchesCache
    return
  }
  try {
    const dbRes = await api.get('/api/batches/db')
    _dbBatchesCache = dbRes.data || []
    dbBatches.value = _dbBatchesCache
  } catch (e) {
    console.error('[api-coupler] Failed to load db batches:', e?.response?.data || e?.message)
  }
}

onMounted(() => {
  loadProjects()
  loadDbBatches()
})

async function refreshProjects() {
  _projectsCache = null
  await loadProjects()
}

async function loadBatches() {
  selectedBatch.value = null
  assemblies.value = []
  changedUuids.value = new Set()
  updateResults.value = []
  if (!selectedProject.value) return
  const res = await api.get(`/api/batches?project_uuid=${selectedProject.value}&limit=200`)
  batches.value = res.data.results || []
}

async function loadAssemblies() {
  if (!selectedBatch.value) return
  const res = await api.get(`/api/assemblies/?batch_uuid=${selectedBatch.value}&limit=500`)
  assemblies.value = (res.data.results || []).map(a => ({
    ...a,
    client_meta_str: JSON.stringify(a.client_meta || {}),
  }))
  changedUuids.value = new Set()
  updateResults.value = []
}

function onCellEdit(e) {
  const { data, newValue, field } = e
  if (field === 'client_meta_str') {
    try {
      data.client_meta = JSON.parse(newValue)
      data.client_meta_str = newValue
    } catch {}
  } else {
    data[field] = newValue
  }
  if (data.uuid) changedUuids.value.add(data.uuid)
}

function rowClass(row) {
  return changedUuids.value.has(row.uuid) ? 'row-changed' : ''
}

async function applyChanges() {
  applying.value = true
  showReview.value = false
  const results = []
  for (const row of changedRows.value) {
    try {
      await api.patch(`/api/assemblies/${row.uuid}`, {
        scheduled_prod_date: row.scheduled_prod_date,
        client_order_id: row.client_order_id,
        priority: row.priority,
        client_meta: row.client_meta,
      })
      results.push({ design: row.design, status: 'updated' })
    } catch (e) {
      results.push({ design: row.design, status: 'error', error: e.message })
    }
  }
  updateResults.value = results
  changedUuids.value = new Set()
  applying.value = false
}
</script>

<style scoped>
.page-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 1.5rem; }
.mb-card { margin-bottom: 1.25rem; }
:deep(.row-changed td) { background: #fef9c3 !important; }

</style>
