<template>
  <div>
    <div v-if="confirmLabel" style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;">
      <Checkbox v-model="confirmed" :binary="true" :input-id="confirmId" />
      <label :for="confirmId" style="cursor:pointer;font-size:0.85rem;">{{ confirmLabel }}</label>
    </div>
    <Button :label="label" :icon="icon" :class="btnClass"
      @click="$emit('action')" :loading="loading" :disabled="confirmLabel && !confirmed" />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  label: { type: String, required: true },
  icon: { type: String, default: 'pi pi-check' },
  confirmLabel: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  btnClass: { type: String, default: 'btn-create' },
})

defineEmits(['action'])

const confirmId = `confirm-${Math.random().toString(36).slice(2, 8)}`
const confirmed = ref(false)
</script>
