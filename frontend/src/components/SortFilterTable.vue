<template>
  <DataTable
    :value="rows"
    v-model:filters="filters"
    filter-display="row"
    removable-sort
    sort-mode="multiple"
    size="small"
    striped-rows
    v-bind="$attrs"
  >
    <template #header v-if="$slots.header">
      <slot name="header" />
    </template>
    <template #empty v-if="$slots.empty">
      <slot name="empty" />
    </template>
    <Column
      v-for="col in columns"
      :key="col.field"
      :field="col.field"
      :header="col.header"
      :style="col.style"
      :sortable="col.sortable !== false"
      :show-filter-menu="false"
      :show-clear-button="false"
    >
      <template #body="{ data }">
        <slot :name="col.field" :data="data" :col="col">
          <template v-for="v in [cellValue(data, col.field)]" :key="1">
            <span v-if="v !== null && v !== undefined && v !== ''">{{ v }}</span>
            <span v-else style="color:#9ca3af;">—</span>
          </template>
        </slot>
      </template>
      <template #filter="{ filterModel, filterCallback }" v-if="col.filter !== false">
        <InputText v-model="filterModel.value" @input="filterCallback()" size="small" style="width:100%;min-width:4rem;" />
      </template>
    </Column>
  </DataTable>
</template>

<script setup>
// sort and filter act on row[field], so a view puts the text it displays
// into the row under that field (for example status_label).
import { ref, watch } from 'vue'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import InputText from 'primevue/inputtext'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  rows: { type: Array, default: () => [] },
  columns: { type: Array, default: () => [] },
})

const filters = ref({})

// Rebuilt only when the set of filterable fields changes, so a parent that
// passes a fresh columns array on every render does not disturb a typed filter.
watch(() => props.columns.filter(c => c.filter !== false).map(c => c.field).join('\u0000'), () => {
  const next = {}
  for (const col of props.columns) {
    if (col.filter === false) continue
    next[col.field] = { value: filters.value[col.field]?.value ?? null, matchMode: 'contains' }
  }
  filters.value = next
}, { immediate: true })

function cellValue(data, field) {
  if (data == null) return null
  if (Object.prototype.hasOwnProperty.call(data, field) || data[field] !== undefined) {
    return data[field]
  }
  const parts = String(field).split('.')
  let val = data
  for (const p of parts) {
    if (val == null) return undefined
    val = val[p]
  }
  return val
}
</script>
