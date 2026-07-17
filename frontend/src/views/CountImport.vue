<template>
  <div>
    <h2 class="page-title">Production Count</h2>
    <p class="page-sub">{{ $t('countImport.subtitle') }}</p>

    <!-- Project + Batch -->
    <Card class="mb-card">
      <template #title>1 · Select Batch</template>
      <template #content>
        <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-end;">
          <div>
            <label class="field-label">Project</label>
            <Select v-model="selectedProject" :options="projects" option-label="name" option-value="uuid"
              placeholder="Select project..." style="min-width:260px" @change="onProjectChange" />
          </div>
          <div>
            <label class="field-label">Batch</label>
            <Select v-model="selectedBatch" :options="batches" option-label="name" option-value="uuid"
              placeholder="Select batch..." style="min-width:220px" :disabled="!batches.length" />
          </div>
        </div>
      </template>
    </Card>

    <!-- Design picker + quantity table -->
    <Card v-if="selectedBatch && designs.length" class="mb-card">
      <template #title>2 · Set Quantities</template>
      <template #content>
        <div style="margin-bottom:0.75rem;display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;">
          <input v-model="designFilter" type="text" :placeholder="$t('countImport.filterDesigns')"…" class="filter-input" />
          <Button :label="$t('countImport.addAllFiltered')" icon="pi pi-plus" text size="small" @click="addAllFiltered" />
        </div>
        <DataTable :value="items" size="small" style="margin-bottom:0.75rem;">
          <Column :header="$t('countImport.design')" style="min-width:200px">
            <template #body="{ data }">{{ data.design_name }}</template>
          </Column>
          <Column :header="$t('countImport.orderPrefix')" style="width:160px">
            <template #body="{ data }">
              <input v-model="data.order_prefix" type="text" class="inline-input" :placeholder="$t('countImport.auto')" />
            </template>
          </Column>
          <Column :header="$t('countImport.count')" style="width:100px">
            <template #body="{ data }">
              <input v-model.number="data.count" type="number" min="1" class="inline-input count-input" />
            </template>
          </Column>
          <Column header="" style="width:48px">
            <template #body="{ data }">
              <Button icon="pi pi-trash" text severity="secondary" size="small" @click="removeItem(data)" />
            </template>
          </Column>
        </DataTable>

        <!-- Design picker -->
        <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
          <Select v-model="designToAdd" :options="filteredDesigns" option-label="name"
            :placeholder="$t('countImport.addDesign')"…" style="min-width:260px" />
          <Button :label="$t('countImport.add')" icon="pi pi-plus" @click="addDesign" :disabled="!designToAdd" />
        </div>
      </template>
    </Card>

    <!-- Preview -->
    <Card v-if="items.length && selectedBatch" class="mb-card">
      <template #title>3 · Preview &amp; Create</template>
      <template #content>
        <div style="display:flex;gap:0.75rem;margin-bottom:1rem;">
          <Button :label="$t('countImport.preview')" icon="pi pi-search" @click="doPreview" :loading="previewing" :disabled="!items.length" />
          <Button v-if="previewData" :label="$t('countImport.createConstructibles')" icon="pi pi-plus-circle" severity="success"
            @click="doCreate" :loading="creating"
            :disabled="!previewData || !previewData.previews.some(p => p.count_to_create > 0)" />
        </div>

        <div v-if="previewData">
          <DataTable :value="previewData.previews" size="small">
            <Column field="design_name" :header="$t('countImport.design')" style="min-width:180px" />
            <Column :header="$t('countImport.requested')" style="width:110px">
              <template #body="{ data }">{{ data.count_requested }}</template>
            </Column>
            <Column :header="$t('countImport.alreadyExist')" style="width:120px">
              <template #body="{ data }">
                <span :style="data.count_existing > 0 ? 'color:#6b7280' : ''">{{ data.count_existing }}</span>
              </template>
            </Column>
            <Column :header="$t('countImport.toCreate')" style="width:100px">
              <template #body="{ data }">
                <Tag :severity="data.count_to_create > 0 ? 'success' : 'secondary'"
                  :value="String(data.count_to_create)" />
              </template>
            </Column>
            <Column :header="$t('countImport.firstIds')" style="min-width:200px">
              <template #body="{ data }">
                <span style="font-size:0.78rem;color:#6b7280;font-family:monospace">
                  {{ data.new_order_ids.slice(0, 3).join(', ') }}{{ data.new_order_ids.length > 3 ? '…' : '' }}
                </span>
              </template>
            </Column>
          </DataTable>
          <div style="margin-top:0.5rem;font-size:0.85rem;color:#6b7280;">
            Total to create: <strong>{{ previewData.previews.reduce((a, p) => a + p.count_to_create, 0) }}</strong>
          </div>
        </div>

        <div v-if="results.length" style="margin-top:1rem;">
          <div style="display:flex;gap:1rem;font-size:0.9rem;margin-bottom:0.5rem;">
            <span class="chip-new">{{ summary.created }} created</span>
            <span class="chip-identical">{{ summary.skipped }} already at count</span>
            <span v-if="summary.error" class="chip-blocked">{{ summary.error }} errors</span>
          </div>
          <DataTable v-if="results.some(r => r.status === 'error')"
            :value="results.filter(r => r.status === 'error')" size="small">
            <Column field="design_name" :header="$t('countImport.design')" />
            <Column field="client_order_id" :header="$t('countImport.orderPrefix')" />
            <Column field="reason" :header="$t('countImport.error')" />
          </DataTable>
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

const { projects, loading: projectsLoading, error: projectsError } = useProduuzitProjects()
const selectedProject = ref(null)
const batches = ref([])
const selectedBatch = ref(null)
const designs = ref([])
const designFilter = ref('')
const designToAdd = ref(null)
const items = ref([])
const previewing = ref(false)
const creating = ref(false)
const previewData = ref(null)
const results = ref([])
const summary = ref({ created: 0, skipped: 0, error: 0 })

const filteredDesigns = computed(() => {
  const q = designFilter.value.toLowerCase()
  const existing = new Set(items.value.map(i => i.design_uuid))
  return designs.value
    .filter(d => !existing.has(d.uuid))
    .filter(d => !q || d.name.toLowerCase().includes(q))
})

async function onProjectChange() {
  batches.value = []; designs.value = []; items.value = []; selectedBatch.value = null; previewData.value = null
  if (!selectedProject.value) return
  const [batchRes, contextRes] = await Promise.all([
    api.get(`/api/batches?project_uuid=${selectedProject.value}&limit=200`),
    api.get(`/api/assemblies/context?project_uuid=${selectedProject.value}`),
  ])
  batches.value = batchRes.data.results || []
  designs.value = contextRes.data.designs || []
}

function addDesign() {
  if (!designToAdd.value) return
  const d = designs.value.find(x => x.uuid === designToAdd.value || x === designToAdd.value)
  const design = typeof designToAdd.value === 'object' ? designToAdd.value : d
  if (!design) return
  items.value.push({
    design_uuid: design.uuid,
    design_name: design.name,
    count: 1,
    order_prefix: '',
  })
  designToAdd.value = null
  previewData.value = null
}

function addAllFiltered() {
  for (const d of filteredDesigns.value) {
    items.value.push({ design_uuid: d.uuid, design_name: d.name, count: 1, order_prefix: '' })
  }
  designFilter.value = ''
  previewData.value = null
}

function removeItem(row) {
  items.value = items.value.filter(i => i.design_uuid !== row.design_uuid)
  previewData.value = null
}

async function doPreview() {
  previewing.value = true; previewData.value = null
  try {
    const r = await api.post('/api/assemblies/preview-by-count', {
      batch_uuid: selectedBatch.value,
      items: items.value,
    })
    previewData.value = r.data
  } finally { previewing.value = false }
}

async function doCreate() {
  creating.value = true; results.value = []
  try {
    const r = await api.post('/api/assemblies/create-by-count', {
      batch_uuid: selectedBatch.value,
      project_uuid: selectedProject.value,
      items: items.value,
    })
    results.value = r.data.results || []
    summary.value = r.data.summary || { created: 0, skipped: 0, error: 0 }
    await doPreview() // refresh counts
  } finally { creating.value = false }
}
</script>

<style scoped>
.page-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; }
.page-sub { color: #6b7280; font-size: 0.85rem; margin-bottom: 1.25rem; }
.mb-card { margin-bottom: 1.25rem; }
.field-label { display: block; font-size: 0.75rem; font-weight: 600; color: #6b7280; margin-bottom: 0.35rem; }
.filter-input, .inline-input {
  padding: 0.35rem 0.6rem; border: 1px solid #d1d5db; border-radius: 5px;
  font-size: 0.85rem; font-family: inherit; outline: none;
}
.filter-input { width: 220px; }
.filter-input:focus, .inline-input:focus { border-color: #3b82f6; }
.count-input { width: 70px; }
.chip-new { color: #15803d; font-weight: 600; }
.chip-identical { color: #6b7280; }
.chip-blocked { color: #dc2626; font-weight: 600; }
</style>
