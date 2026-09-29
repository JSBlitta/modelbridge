<template>
  <div class="phase-table">
    <DataTable :value="flatRows" edit-mode="cell" @cell-edit-complete="onCellEdit" striped-rows size="small">
      <Column field="project_key" :header="$t('phaseTable.projectCode')" style="min-width:130px" />
      <Column field="superproject" :header="$t('phaseTable.superproject')" style="min-width:110px" />
      <Column field="letter" :header="$t('phaseTable.letter')" style="width:70px" />
      <Column field="description" :header="$t('phaseTable.description')" />
      <Column field="suggested_suffix" :header="$t('phaseTable.suffix')" style="width:80px">
        <template #editor="{ data, field }">
          <InputText v-model="data[field]" style="width:4rem" />
        </template>
      </Column>
      <Column field="suggested_phase" :header="$t('phaseTable.phase')" style="width:100px">
        <template #body="{ data }">
          <span :style="!(data._batch?.phase || data.suggested_phase) ? 'color:#dc2626;font-style:italic' : ''">
            {{ data._batch?.phase || data.suggested_phase || $t('phaseTable.required') }}
          </span>
        </template>
        <template #editor="{ data, field }">
          <InputText v-model="data[field]" style="width:5rem" />
        </template>
      </Column>
      <Column :header="$t('phaseTable.batchHeader')" style="width:80px">
        <template #body="{ data }">
          <span v-if="data._batch != null" style="font-family:monospace;">{{ data._batch.number }}</span>
          <span v-else style="color:#9ca3af;">—</span>
        </template>
      </Column>
      <Column :header="$t('phaseTable.batchStatus')" style="width:100px">
        <template #body="{ data }">
          <template v-if="data._batch != null && (data.batches_found?.length || data.batches_missing?.length)">
            <Tag
              :severity="data.batches_found?.includes(String(data._batch.number)) ? 'success' : 'info'"
              :value="data.batches_found?.includes(String(data._batch.number)) ? $t('phaseTable.exists') : $t('phaseTable.new')"
            />
          </template>
        </template>
      </Column>
      <Column :header="$t('phaseTable.stdlib')">
        <template #body="{ data }">
          <span v-if="data._batch?.stdlibs?.length">{{ data._batch.stdlibs.join(', ') }}</span>
          <span v-else style="color:#9ca3af;">—</span>
        </template>
      </Column>
      <Column field="status" :header="$t('phaseTable.status')">
        <template #body="{ data }">
          <Tag
            :severity="data.status === 'found' ? 'success' : 'warn'"
            :value="data.status === 'found' ? $t('phaseTable.found') : $t('phaseTable.new')"
          />
        </template>
      </Column>
    </DataTable>
  </div>
</template>

<script setup>
import { ref, watch, computed } from 'vue'

const props = defineProps({
  rows: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:rows'])

const localRows = ref([...props.rows])
watch(() => props.rows, v => { localRows.value = [...v] })

// One flat row per batch — projects with no batches get a single placeholder row
const flatRows = computed(() => {
  const result = []
  localRows.value.forEach((proj, projIdx) => {
    const batches = Array.isArray(proj.batches) && proj.batches.length ? proj.batches : [null]
    for (const b of batches) {
      result.push({ ...proj, _batch: b, _projIdx: projIdx })
    }
  })
  return result
})

function onCellEdit(e) {
  const { data, newValue, field } = e
  const proj = localRows.value[data._projIdx]
  if (proj) proj[field] = newValue
  emit('update:rows', [...localRows.value])
}
</script>
