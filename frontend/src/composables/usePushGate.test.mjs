// Proves the define -> check -> confirm -> push contract, including the
// behaviour the old ConfirmedButton got wrong: a confirmation must not survive a
// change to the thing it confirmed.
//
// Run: npm run test  (from frontend/)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ref, nextTick } from 'vue'
import { usePushGate } from './usePushGate.js'

function makeGate({ checkImpl, pushImpl } = {}) {
  const project = ref('p1')
  const mapping = ref({ A: 'design_name' })
  const rows = ref([{ a: 1 }])

  const calls = { checks: 0, pushes: [], }
  const gate = usePushGate({
    identity: () => [project.value, JSON.stringify(mapping.value), rows.value.length].join('::'),
    check: checkImpl ?? (async () => {
      calls.checks++
      return { preview_token: `tok-${calls.checks}`, rows: [] }
    }),
    push: pushImpl ?? (async (token) => {
      calls.pushes.push(token)
      return { ok: true }
    }),
  })
  return { gate, project, mapping, rows, calls }
}

test('push is unreachable before a check has run', async () => {
  const { gate } = makeGate()
  assert.equal(gate.checked, false)
  assert.equal(gate.canPush, false)
  assert.equal(await gate.runPush(), null, 'runPush must be a no-op before a check')
})

test('push is unreachable after a check but before confirming', async () => {
  const { gate, calls } = makeGate()
  await gate.runCheck()
  assert.equal(gate.checked, true)
  assert.equal(gate.canPush, false, 'a check alone must not arm the push')
  await gate.runPush()
  assert.deepEqual(calls.pushes, [], 'nothing may be sent without a confirmation')
})

test('push works once checked and confirmed, and forwards the token', async () => {
  const { gate, calls } = makeGate()
  await gate.runCheck()
  gate.confirmed = true
  assert.equal(gate.canPush, true)
  await gate.runPush()
  assert.deepEqual(calls.pushes, ['tok-1'], 'the push must carry the token from the check')
})

test('changing an input clears both the check and the confirmation', async () => {
  const { gate, mapping } = makeGate()
  await gate.runCheck()
  gate.confirmed = true
  assert.equal(gate.canPush, true)

  // The operator edits the column mapping after confirming.
  mapping.value = { A: 'batch_number' }
  await nextTick()

  assert.equal(gate.checked, false, 'the stale check must be discarded')
  assert.equal(gate.confirmed, false, 'the stale confirmation must be discarded')
  assert.equal(gate.canPush, false, 'the push button must not be reachable')
})

test('a re-check after an edit requires a fresh confirmation', async () => {
  const { gate, rows, calls } = makeGate()
  await gate.runCheck()
  gate.confirmed = true

  rows.value = [{ a: 1 }, { a: 2 }]
  await nextTick()
  await gate.runCheck()

  assert.equal(gate.checked, true)
  assert.equal(gate.confirmed, false, 'the new check starts unconfirmed')
  await gate.runPush()
  assert.deepEqual(calls.pushes, [], 'no push until the new check is confirmed')

  gate.confirmed = true
  await gate.runPush()
  assert.deepEqual(calls.pushes, ['tok-2'], 'the second token, not the first')
})

test('the token is not reusable for a second push', async () => {
  const { gate, calls } = makeGate()
  await gate.runCheck()
  gate.confirmed = true
  await gate.runPush()

  assert.equal(gate.canPush, false, 'the gate re-arms only after another check')
  await gate.runPush()
  assert.equal(calls.pushes.length, 1, 'a spent token must not be sent twice')
})

test('a check that returns no token leaves the push disabled', async () => {
  const { gate } = makeGate({ checkImpl: async () => ({ rows: [] }) })
  await gate.runCheck()
  gate.confirmed = true
  assert.equal(gate.checked, false)
  assert.equal(gate.canPush, false)
  assert.match(gate.error, /confirmation token/)
})

test('a server 409 forces a fresh check instead of a blind retry', async () => {
  const err = Object.assign(new Error('stale'), {
    response: { data: { code: 'PREVIEW_REQUIRED', error: 'The data changed after the check was run.' } },
  })
  const { gate } = makeGate({ pushImpl: async () => { throw err } })
  await gate.runCheck()
  gate.confirmed = true
  await gate.runPush()

  assert.equal(gate.checked, false, 'the rejected check must be cleared')
  assert.equal(gate.confirmed, false)
  assert.match(gate.error, /data changed/)
})

test('a failed check reports the error and does not arm the push', async () => {
  const { gate } = makeGate({ checkImpl: async () => { throw new Error('upstream exploded') } })
  await gate.runCheck()
  assert.equal(gate.checked, false)
  assert.equal(gate.canPush, false)
  assert.match(gate.error, /upstream exploded/)
})
