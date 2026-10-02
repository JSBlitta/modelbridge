<template>
  <div class="confirmation-table">
    <!-- Plain DataTable: only the Trimble flow uses components/SortFilterTable.vue (sortable, filter per column). Switch to it if this view is ever rewritten. -->
    <DataTable :value="rows" :row-class="rowClass" striped-rows size="small">
      <Column v-for="col in columns" :key="col.field" :field="col.field" :header="col.header" />
      <Column :field="statusField" :header="$t('confirmationTable.status')">
        <template #body="{ data }">
          <Tag :severity="statusSeverity(data[statusField])" :value="data[statusField]" />
        </template>
      </Column>
    </DataTable>
    <div v-if="showActions" class="actions" style="margin-top:1rem; display:flex; gap:0.75rem;">
      <Button :label="$t('confirmationTable.confirm')" icon="pi pi-check" @click="$emit('confirm')" />
      <Button :label="$t('confirmationTable.cancel')" icon="pi pi-times" severity="secondary" @click="$emit('cancel')" />
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  rows: { type: Array, default: () => [] },
  columns: { type: Array, default: () => [] },
  statusField: { type: String, default: 'status' },
  showActions: { type: Boolean, default: true },
})
defineEmits(['confirm', 'cancel'])

function statusSeverity(status) {
  if (status === 'new' || status === 'created') return 'success'
  if (status === 'changed' || status === 'updated') return 'warn'
  if (status === 'found' || status === 'existing' || status === 'already_exists') return 'secondary'
  if (status === 'error') return 'danger'
  return 'info'
}

function rowClass(row) {
  const s = row[props.statusField]
  if (s === 'new' || s === 'created') return 'row-new'
  if (s === 'changed' || s === 'updated') return 'row-changed'
  if (s === 'error') return 'row-error'
  return 'row-existing'
}
</script>

<style scoped>
:deep(.row-new td) { background: #dcfce7 !important; }
:deep(.row-changed td) { background: #fef9c3 !important; }
:deep(.row-existing td) { background: #f3f4f6 !important; }
:deep(.row-error td) { background: #fee2e2 !important; }
</style>
