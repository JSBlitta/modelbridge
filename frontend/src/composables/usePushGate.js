import { computed, reactive, ref, watch } from 'vue'

/**
 * The define -> check -> confirm -> push contract, in one place.
 *
 * Nothing reaches Produuzit until the operator has run a check and ticked a box
 * confirming *that* check. The important word is "that": the confirmation is
 * bound to the inputs it was given for, and clears itself the moment any of them
 * change. The previous ConfirmedButton kept a private `confirmed` ref that was
 * never reset, so a tick made for one preview silently authorised a later,
 * different one.
 *
 * Options:
 *   identity  () => string|any   cheap, stable summary of every input the check
 *                                depends on. Cheap matters: it is recomputed on
 *                                every reactive change, so summarise large
 *                                collections (length + ids) rather than
 *                                serialising them.
 *   check     async () => data   runs the preview. Must resolve to the server
 *                                response, which carries `preview_token`.
 *   push      async (token) => data   performs the write, passing the token back.
 *
 * The server enforces the same rule independently (see src/lib/push-gate.ts):
 * an import without a matching, unexpired, unused token is refused with 409.
 * This composable is the affordance; that is the boundary.
 */
export function usePushGate({ identity, check, push }) {
  const checking = ref(false)
  const pushing = ref(false)
  const checkResult = ref(null)
  const previewToken = ref('')
  const confirmed = ref(false)
  const error = ref('')

  const fingerprint = computed(() => {
    try {
      const id = identity()
      return typeof id === 'string' ? id : JSON.stringify(id)
    } catch {
      return ''
    }
  })

  // Any change to the inputs invalidates both the check and the confirmation.
  watch(fingerprint, () => reset())

  function reset() {
    checkResult.value = null
    previewToken.value = ''
    confirmed.value = false
    error.value = ''
  }

  // A check has been run and the server issued a token for these exact inputs.
  const checked = computed(() => checkResult.value !== null && Boolean(previewToken.value))
  const canPush = computed(() => checked.value && confirmed.value && !pushing.value)

  function messageFor(e) {
    return e?.response?.data?.error || e?.data?.error || e?.message || String(e)
  }

  async function runCheck() {
    if (checking.value) return null
    checking.value = true
    error.value = ''
    checkResult.value = null
    previewToken.value = ''
    confirmed.value = false
    try {
      const data = await check()
      checkResult.value = data ?? null
      previewToken.value = data?.preview_token || ''
      if (!previewToken.value) {
        error.value = 'The check did not return a confirmation token, so the push stays disabled.'
      }
      return data
    } catch (e) {
      error.value = messageFor(e)
      return null
    } finally {
      checking.value = false
    }
  }

  async function runPush() {
    if (!canPush.value) return null
    pushing.value = true
    error.value = ''
    try {
      const data = await push(previewToken.value)
      // The token is spent server-side; make that visible rather than leaving a
      // dead button armed.
      previewToken.value = ''
      confirmed.value = false
      return data
    } catch (e) {
      error.value = messageFor(e)
      const code = e?.response?.data?.code || e?.data?.code
      if (code === 'PREVIEW_REQUIRED' || code === 'CONCURRENT_MODIFICATION') {
        // The server rejected the token. Force a fresh check rather than letting
        // the operator retry against a stale result.
        checkResult.value = null
        previewToken.value = ''
        confirmed.value = false
      }
      return null
    } finally {
      pushing.value = false
    }
  }

  // Returned as a reactive object, not a bag of refs: the gate is passed to
  // <PushGate> as a prop, and refs inside a plain prop object are NOT unwrapped
  // in templates. reactive() unwraps them, so `gate.checking` is a boolean and
  // `v-model="gate.confirmed"` works.
  return reactive({
    checking, pushing, checkResult, confirmed,
    checked, canPush, error, runCheck, runPush, reset,
  })
}
