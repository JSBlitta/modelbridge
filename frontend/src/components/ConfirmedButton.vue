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
import { ref, watch } from 'vue'

// Legacy confirm control. Prefer <PushGate> + usePushGate for anything that
// writes to Produuzit — that pair also requires a completed check and carries a
// server-verified token. This component survives only for the two creation
// flows whose endpoints do not issue tokens yet.
//
// `resetKey` fixes the defect this component shipped with: `confirmed` was
// private state that was never cleared, so a tick made for one preview stayed
// ticked for the next, different one. Pass anything that changes when the thing
// being confirmed changes.
let confirmSeq = 0

const props = defineProps({
  label: { type: String, required: true },
  icon: { type: String, default: 'pi pi-check' },
  confirmLabel: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  btnClass: { type: String, default: 'btn-create' },
  resetKey: { type: [String, Number, Boolean], default: '' },
})

defineEmits(['action'])

const confirmId = `confirm-${++confirmSeq}`
const confirmed = ref(false)

watch(() => props.resetKey, () => { confirmed.value = false })
</script>
