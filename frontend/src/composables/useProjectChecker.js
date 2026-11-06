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

  async function checkProjects(phaseSuggestions) {
    checking.value = true
    checkDone.value = false
    try {
      const payload = phaseSuggestions.value.map(p => ({
        project_key: p.project_key,
        superproject: p.superproject,
        letter: p.letter,
        description: p.description,
        suggested_suffix: p.suggested_suffix,
        phase: p.suggested_phase || '',
        phases: [...new Set([p.suggested_phase, ...(p.batches || []).map(b => b.phase)].filter(Boolean))],
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
          project_uuid: r.existing?.uuid || null,
          project_name: r.existing?.name || '',
          candidates: r.candidates || [],
          phases_missing: r.phases_missing || [],
          batches_found: r.batches_found || [],
          batches_missing: r.batches_missing || [],
        }
      })
      checkDone.value = true
    } catch {
      // Errors are surfaced by the global API error toast.
    } finally {
      checking.value = false
    }
  }

  return { checking, checkDone, checkProjects }
}
