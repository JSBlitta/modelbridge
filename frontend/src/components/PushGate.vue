<template>
  <div class="push-gate">
    <!-- 1. CHECK — always available once there is something to check -->
    <Button
      v-if="showCheck"
      :label="checkLabel"
      icon="pi pi-search"
      class="btn-preview"
      :loading="gate.checking"
      :disabled="checkDisabled"
      @click="gate.runCheck()" />

    <!-- 2. CONFIRM + 3. PUSH — only exist once a check has been run for the
         current inputs. Change any input and this whole block disappears. -->
    <div v-if="gate.checked" class="push-gate__confirm">
      <div class="push-gate__row">
        <Checkbox v-model="gate.confirmed" :binary="true" :input-id="confirmId" />
        <label :for="confirmId" class="push-gate__label">{{ confirmLabel }}</label>
      </div>
      <Button
        :label="pushLabel"
        :icon="pushIcon"
        :severity="severity"
        :loading="gate.pushing"
        :disabled="!gate.canPush"
        @click="gate.runPush()" />
    </div>

    <Message
      v-if="gate.error"
      severity="error"
      :closable="false"
      size="small"
      class="push-gate__error">
      {{ gate.error }}
    </Message>
  </div>
</template>

<script setup>

// The single confirm-before-push control. Every Produuzit write path uses it, so
// the rule is stated once and cannot drift between screens.
let gateIdSeq = 0
function nextGateId() { return ++gateIdSeq }

defineProps({
  // The object returned by usePushGate().
  gate: { type: Object, required: true },
  checkLabel: { type: String, default: '' },
  confirmLabel: { type: String, required: true },
  pushLabel: { type: String, required: true },
  pushIcon: { type: String, default: 'pi pi-cloud-upload' },
  severity: { type: String, default: 'warning' },
  showCheck: { type: Boolean, default: true },
  checkDisabled: { type: Boolean, default: false },
})

// A module-scoped counter rather than Math.random(): the old component minted a
// fresh id on every render, so the <label for> could point at a stale input.
// (useId() would do, but it needs Vue 3.5 and package.json allows 3.4.)
const confirmId = `push-gate-${nextGateId()}`
</script>

<style scoped>
.push-gate__confirm {
  margin-top: 0.75rem;
}
.push-gate__row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.push-gate__label {
  cursor: pointer;
  font-size: 0.85rem;
}
.push-gate__error {
  margin-top: 0.5rem;
}
</style>
