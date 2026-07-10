<template>
  <div class="phase-table">
    <DataTable :value="localRows" edit-mode="cell" @cell-edit-complete="onCellEdit" striped-rows size="small">
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
          <span :style="!data.suggested_phase ? 'color:#dc2626;font-style:italic' : ''">
            {{ data.suggested_phase || $t('phaseTable.required') }}
          </span>
        </template>
        <template #editor="{ data, field }">
          <InputText v-model="data[field]" style="width:5rem" />
        </template>
      </Column>
      <Column field="batches" :header="$t('phaseTable.batches')">
        <template #body="{ data }">{{ Array.isArray(data.batches) ? data.batches.length : 0 }} {{ $t('phaseTable.batches').toLowerCase() }}</template>
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
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()

const props = defineProps({
  rows: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:rows'])

const localRows = ref([...props.rows])
watch(() => props.rows, v => { localRows.value = [...v] })

function onCellEdit(e) {
  const { data, newValue, field } = e
  data[field] = newValue
  emit('update:rows', [...localRows.value])
}
</script>
