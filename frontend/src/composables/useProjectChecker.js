import { ref } from 'vue'
import { api } from '../api.js'

/**
 * Shared composable for the "Check in Produuzit" flow used by both
 * UnifiedImport and ProjectSetup. Sends CSV-parsed phase suggestions
 * to /api/projects/find-or-create and maps the results back.
 */
export function useProjectChecker() {
  const checking = ref(false)
  const checkDone = ref(false)
  const error = ref('')

  async function checkProjects(phaseSuggestions) {
    checking.value = true
    checkDone.value = false
    error.value = ''
    try {
      const payload = phaseSuggestions.value.map(p => ({
        project_key: p.project_key,
        superproject: p.superproject,
        letter: p.letter,
        description: p.description,
        suggested_suffix: p.suggested_suffix,
        phase: p.suggested_phase || '',
        batch_specs: (p.batches || []).map(b => ({
          number: b.number,
          phase: b.phase || p.suggested_phase || '',
        })),
      }))
      const res = await api.post('/api/projects/find-or-create', payload)
      const byKey = {}
      for (const r of res.data) {
        byKey[r.project_key] = r
      }
      phaseSuggestions.value = phaseSuggestions.value.map(p => {
        const r = byKey[p.project_key]
        if (!r) return p
        return {
          ...p,
          status: r.status,
          superproject_found: r.superproject_found,
          phase_exists: r.phase_exists,
          batches_found: r.batches_found || [],
          batches_missing: r.batches_missing || [],
        }
      })
      checkDone.value = true
    } catch (err) {
      error.value = err.response?.data?.detail || err.message
    } finally {
      checking.value = false
    }
  }

  return { checking, checkDone, error, checkProjects }
}
