<template>
  <div class="column-mapper">
    <table class="map-table">
      <thead>
        <tr>
          <th>{{ $t('columnMapper.csvColumn') }}</th>
          <th>{{ $t('columnMapper.mapsTo') }}</th>
          <th>{{ $t('columnMapper.preview') }}</th>
          <th>{{ $t('columnMapper.warning') }}</th>
          <th style="width:3rem;"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="col in detectedColumns" :key="col" :class="{ 'row-warn': hasWarning(col) }">
          <td class="csv-col">{{ col }}</td>
          <td>
            <Select
              v-model="mapping[col]"
              :options="targetOptions"
              option-label="label"
              option-value="name"
              :placeholder="$t('columnMapper.ignore')"
              class="field-select"
              @change="emitMapping"
            />
            <div v-if="mapping[col] === '__new_meta__'" style="display:flex;gap:0.4rem;margin-top:0.35rem;align-items:center;">
              <InputText v-model="newMetaKeys[col]" :placeholder="$t('columnMapper.keyName')" style="width:120px;font-size:0.8rem;" @input="emitMapping" />
              <small>→ client_meta.<em>{{ newMetaKeys[col] || '...' }}</em></small>
            </div>
            <!-- Duplicate mappings: same source column to additional Produuzit targets -->
            <div v-for="dup in dupsOf(col)" :key="dup.id" class="dup-row">
              <Select
                v-model="dup.target"
                :options="targetOptions"
                option-label="label"
                option-value="name"
                :placeholder="$t('columnMapper.ignore')"
                class="field-select"
                @change="emitMapping"
              />
              <Button icon="pi pi-times" text size="small" severity="danger" @click="removeDuplicate(dup.id)" />
            </div>
          </td>
          <td class="preview-val">{{ previewValue(col) }}</td>
          <td>
            <span v-if="hasWarning(col)" class="warn-icon" title="Value contains special characters">{{ $t('columnMapper.specialChars') }}</span>
          </td>
          <td>
            <Button icon="pi pi-copy" text size="small" v-tooltip.top="$t('columnMapper.duplicateHint')" @click="addDuplicate(col)" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const props = defineProps({
  detectedColumns: { type: Array, default: () => [] },
  autoMapping:     { type: Object, default: () => ({}) },
  unmappedColumns: { type: Array, default: () => [] },
  previewRows:     { type: Array, default: () => [] },  // first few rows for preview
})
const emit = defineEmits(['mapping-updated'])

const mapping = ref({})
const newMetaKeys = ref({})
const dups = ref([])  // [{ id, col, target, metaKey }]
let _dupSeq = 0

// Fixed target options
const targetOptions = computed(() => {
  const standard = [
    { name: '', label: t('columnMapper.ignore') },
    { name: 'design_name', label: t('columnMapper.designName') },
    { name: 'batch_number', label: t('columnMapper.batchNumber') },
    { name: 'client_order_id', label: t('columnMapper.clientOrderId') },
    { name: 'scheduled_prod_date', label: t('columnMapper.scheduledProdDate') },
    { name: 'priority', label: t('columnMapper.priority') },
    { name: 'count', label: t('columnMapper.count') },
    { name: 'uuid', label: t('columnMapper.assemblyUuid') },
    { name: 'superproject', label: 'Superproject' },
    { name: 'phase', label: 'Phase' },
    { name: 'project', label: 'Project' },
    { name: 'stdlib', label: 'Standard Library' },
    { name: 'client_meta', label: t('columnMapper.clientMetaJson') },
    { name: 'client_meta.gevel', label: t('columnMapper.clientMeta_gevel') },
    { name: 'client_meta.verdieping', label: t('columnMapper.clientMeta_verdieping') },
    { name: 'client_meta.levering_montage', label: t('columnMapper.clientMeta_levering') },
    { name: 'client_meta.uid_element', label: t('columnMapper.clientMeta_uid') },
    { name: '__new_meta__', label: t('columnMapper.newMetaKey') },
  ]
  // Add any auto-mapped targets not in the standard list
  for (const target of Object.values(props.autoMapping)) {
    const ts = Array.isArray(target) ? target : [target]
    for (const tgt of ts) {
      if (tgt && !standard.some(o => o.name === tgt)) {
        standard.push({ name: tgt, label: tgt })
      }
    }
  }
  return standard
})

const WARN_RE = /["\\\n\r]/

function previewValue(col) {
  if (!props.previewRows.length) return ''
  return String(props.previewRows[0]?.[col] ?? '')
}

function hasWarning(col) {
  for (const row of props.previewRows) {
    const v = String(row?.[col] ?? '')
    if (WARN_RE.test(v)) return true
  }
  return false
}

function dupsOf(col) {
  return dups.value.filter(d => d.col === col)
}

function addDuplicate(col) {
  dups.value = [...dups.value, { id: ++_dupSeq, col, target: '', metaKey: '' }]
}

function removeDuplicate(id) {
  dups.value = dups.value.filter(d => d.id !== id)
  emitMapping()
}

watch(() => props.autoMapping, (am) => {
  for (const [col, target] of Object.entries(am)) {
    if (!mapping.value[col]) mapping.value[col] = Array.isArray(target) ? target[0] : target
  }
  emitMapping()
}, { immediate: true })

watch(() => props.detectedColumns, (cols) => {
  cols.forEach(col => {
    if (mapping.value[col] === undefined) mapping.value[col] = props.autoMapping[col] || ''
  })
  emitMapping()
}, { immediate: true })

function emitMapping() {
  const result = {}
  for (const [col, target] of Object.entries(mapping.value)) {
    const primary = target === '__new_meta__'
      ? (newMetaKeys.value[col]?.trim() ? `client_meta.${newMetaKeys.value[col].trim()}` : '')
      : target
    const dupTargets = dupsOf(col).map(d => d.target).filter(Boolean)
    const allTargets = [primary, ...dupTargets].filter(Boolean)
    if (!allTargets.length) continue
    result[col] = allTargets.length === 1 ? allTargets[0] : allTargets
  }
  emit('mapping-updated', result)
}
</script>

<style scoped>
.column-mapper { overflow-x: auto; }
.map-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
.map-table th { text-align: left; padding: 0.4rem 0.75rem; border-bottom: 2px solid #e5e7eb; color: #6b7280; font-weight: 600; }
.map-table td { padding: 0.4rem 0.75rem; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
.map-table tr.row-warn { background: #fffbeb; }
.csv-col { font-family: monospace; font-size: 0.82rem; background: #e2e8f0; padding: 0.2rem 0.5rem; border-radius: 4px; white-space: nowrap; }
.field-select { min-width: 210px; }
.dup-row { display: flex; align-items: center; gap: 0.3rem; margin-top: 0.35rem; }
.preview-val { color: #6b7280; font-size: 0.8rem; font-family: monospace; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.warn-icon { color: #b45309; font-size: 0.8rem; white-space: nowrap; }
</style>
