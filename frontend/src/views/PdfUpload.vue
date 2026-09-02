<template>
  <div>
    <h2 class="page-title">{{ $t('pdfUpload.title') }}</h2>

    <Card class="mb-card">
      <template #title>{{ $t('pdfUpload.selectTarget') }}</template>
      <template #content>
        <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-end;">
          <div>
            <label class="field-label">{{ $t('pdfUpload.project') }}</label>
            <Select v-model="selectedProject" :options="projects" option-label="name" option-value="uuid"
              :placeholder="$t('pdfUpload.selectProject')" style="min-width:220px" @change="loadBatches" />
          </div>
          <div>
            <label class="field-label">{{ $t('pdfUpload.phase') }}</label>
            <Select v-model="selectedPhase" :options="phases" :placeholder="$t('pdfUpload.selectPhase')"
              style="min-width:160px" :disabled="!selectedProject" @change="filterBatchesByPhase" />
          </div>
          <div>
            <label class="field-label">{{ $t('pdfUpload.batch') }}</label>
            <Select v-model="selectedBatch" :options="filteredBatches" option-label="name" option-value="uuid"
              :placeholder="$t('pdfUpload.selectBatch')" style="min-width:200px" :disabled="!selectedProject" @change="loadAssemblies" />
          </div>
          <div>
            <label class="field-label">{{ $t('pdfUpload.assembly') }}</label>
            <Select v-model="selectedAssembly" :options="assemblies" option-label="client_order_id" option-value="uuid"
              :placeholder="$t('pdfUpload.selectAssembly')" style="min-width:220px" :disabled="!selectedBatch" />
          </div>
        </div>
      </template>
    </Card>

    <Card v-if="selectedAssembly" class="mb-card">
      <template #title>{{ $t('pdfUpload.uploadPdfs') }}</template>
      <template #content>
        <div
          class="drop-zone"
          @dragover.prevent
          @drop.prevent="onDrop"
          @click="triggerFileInput"
        >
          <i class="pi pi-cloud-upload" style="font-size:2rem;color:#6b7280;"></i>
          <p>{{ $t('pdfUpload.dropZone') }}</p>
          <input ref="fileInput" type="file" accept=".pdf" multiple style="display:none" @change="onFilesSelected" />
        </div>
      </template>
    </Card>

    <Card v-if="files.length" class="mb-card">
      <template #title>{{ $t('pdfUpload.filesToUpload') }} ({{ files.length }})</template>
      <template #content>
        <DataTable :value="files" size="small" striped-rows>
          <Column field="name" :header="$t('pdfUpload.filename')" />
          <Column :header="$t('pdfUpload.status')">
            <template #body="{ data }">
              <Tag v-if="data.status" :severity="data.status === 'uploaded' ? 'success' : 'danger'" :value="data.status" />
              <span v-else>{{ $t('pdfUpload.pending') }}</span>
            </template>
          </Column>
        </DataTable>
        <Button :label="$t('pdfUpload.uploadAll')" icon="pi pi-upload" style="margin-top:1rem;" @click="uploadAll" :loading="uploading" />
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

const fileInput = ref(null)
const files = ref([])
const uploading = ref(false)

const { projects } = useProduuzitProjects()
const batches = ref([])
const selectedProject = ref(null)
const selectedPhase = ref('')
const selectedBatch = ref(null)
const selectedAssembly = ref(null)
const assemblies = ref([])

const phases = computed(() => {
  const seen = new Set()
  const list = []
  for (const b of batches.value) {
    const p = String(b.phase || '').trim()
    if (p && !seen.has(p)) { seen.add(p); list.push(p) }
  }
  return list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
})

const filteredBatches = computed(() => {
  if (!selectedPhase.value) return batches.value
  return batches.value.filter(b => String(b.phase || '').trim() === selectedPhase.value)
})

function triggerFileInput() {
  fileInput.value?.click()
}

function onFilesSelected(e) {
  addFiles(Array.from(e.target.files || []))
}

function onDrop(e) {
  addFiles(Array.from(e.dataTransfer.files || []))
}

function addFiles(newFiles) {
  for (const f of newFiles) {
    files.value.push({ file: f, name: f.name, status: null })
  }
}

async function loadBatches() {
  selectedPhase.value = ''
  selectedBatch.value = null
  selectedAssembly.value = null
  assemblies.value = []
  batches.value = []
  files.value = []
  if (!selectedProject.value) return
  const res = await api.get(`/api/batches?project_uuid=${selectedProject.value}&limit=500`)
  batches.value = res.data.results || []
}

function filterBatchesByPhase() {
  selectedBatch.value = null
  selectedAssembly.value = null
  assemblies.value = []
  files.value = []
}

async function loadAssemblies() {
  selectedAssembly.value = null
  assemblies.value = []
  files.value = []
  if (!selectedBatch.value) return
  const res = await api.get(`/api/assemblies/?batch_uuid=${selectedBatch.value}&limit=500`)
  assemblies.value = res.data.results || []
}

async function uploadAll() {
  if (!selectedAssembly.value) return
  uploading.value = true
  for (const item of files.value) {
    const form = new FormData()
    form.append('file', item.file)
    form.append('batch_uuid', selectedBatch.value)
    form.append('project_uuid', selectedProject.value)
    form.append('assembly_uuid', selectedAssembly.value)
    try {
      await api.post('/api/cloudstorage/upload', form)
      item.status = 'uploaded'
    } catch (e) {
      item.status = 'error: ' + (e.response?.data?.detail || e.message)
    }
  }
  uploading.value = false
}
</script>

<style scoped>
.page-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 1.5rem; }
.mb-card { margin-bottom: 1.25rem; }
.field-label { display: block; font-size: 0.8rem; font-weight: 600; color: #4b5563; margin-bottom: 0.25rem; }
.drop-zone {
  border: 2px dashed #d1d5db;
  border-radius: 8px;
  padding: 3rem;
  text-align: center;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  transition: border-color 0.15s;
}
.drop-zone:hover { border-color: #3b82f6; }
</style>
