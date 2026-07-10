<template>
  <div>
    <h2 class="page-title">PDF Upload</h2>

    <Card class="mb-card">
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
      <template #title>Files to Upload ({{ files.length }})</template>
      <template #content>
        <DataTable :value="files" size="small" striped-rows>
          <Column field="name" :header="$t('pdfUpload.filename')" />
          <Column :header="$t('pdfUpload.matchedBatch')">
            <template #body="{ data, index }">
              <Select
                v-model="files[index].matchedBatch"
                :options="dbBatches"
                option-label="name"
                option-value="uuid"
                :placeholder="$t('pdfUpload.selectBatch')"
                style="min-width:180px"
              />
            </template>
          </Column>
          <Column :header="$t('pdfUpload.confidence')">
            <template #body="{ data }">
              <Tag :severity="data.confidence > 0.7 ? 'success' : data.confidence > 0.3 ? 'warn' : 'secondary'"
                :value="data.confidence > 0 ? `${Math.round(data.confidence * 100)}%` : 'Manual'" />
            </template>
          </Column>
          <Column :header="$t('pdfUpload.status')">
            <template #body="{ data }">
              <Tag v-if="data.status" :severity="data.status === 'uploaded' ? 'success' : 'danger'" :value="data.status" />
              <span v-else>Pending</span>
            </template>
          </Column>
        </DataTable>
        <Button :label="$t('pdfUpload.uploadAll')" icon="pi pi-upload" style="margin-top:1rem;" @click="uploadAll" :loading="uploading" />
      </template>
    </Card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { api } from '../api.js'

const fileInput = ref(null)
const files = ref([])
const dbBatches = ref([])
const uploading = ref(false)

onMounted(async () => {
  const res = await api.get('/api/batches/db')
  dbBatches.value = res.data || []
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
    const matched = autoMatch(f.name)
    files.value.push({
      file: f,
      name: f.name,
      matchedBatch: matched?.uuid || null,
      confidence: matched?.confidence || 0,
      status: null,
    })
  }
}

function autoMatch(filename) {
  const base = filename.replace(/\.pdf$/i, '').toLowerCase()
  let best = null
  let bestScore = 0
  for (const batch of dbBatches.value) {
    const batchName = (batch.name || '').toLowerCase()
    if (base.includes(batchName) || batchName.includes(base)) {
      const score = batchName === base ? 1.0 : 0.6
      if (score > bestScore) {
        bestScore = score
        best = { ...batch, confidence: score }
      }
    }
  }
  return best
}

async function uploadAll() {
  uploading.value = true
  for (const item of files.value) {
    if (!item.matchedBatch) {
      item.status = 'skipped (no batch)'
      continue
    }
    const form = new FormData()
    form.append('file', item.file)
    form.append('batch_uuid', item.matchedBatch)
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
