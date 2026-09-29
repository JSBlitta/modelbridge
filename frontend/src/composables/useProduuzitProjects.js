import { ref, computed } from 'vue'
import { api, apiErrorMessage } from '../api.js'

// ── Module-level cache — shared across all components ──
let _cache = null       // { projects: [], fetchedAt: timestamp }
let _pending = null     // Promise | null — deduplicates concurrent fetches

export function useProduuzitProjects() {
  const projects = ref([])
  const loading = ref(false)
  const error = ref('')

  // ── Derived: unique superprojects, sorted A-Z ──
  const superprojects = computed(() => {
    const seen = new Set()
    const list = []
    for (const p of projects.value) {
      const sp = (p.super_project || '').toString().trim()
      if (sp && !seen.has(sp)) { seen.add(sp); list.push(sp) }
    }
    list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    return list
  })

  // ── Filter projects by superproject ──
  function projectsForSuperproject(superproject) {
    if (!superproject) return []
    return projects.value
      .filter(p => (p.super_project || '').toString().trim() === superproject)
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }))
  }

  // ── Fetch (with dedup + cache) ──
  async function fetchProjects(force = false) {
    // Return cached if fresh (< 60s)
    if (!force && _cache && Date.now() - _cache.fetchedAt < 60_000) {
      projects.value = _cache.projects
      return
    }

    // Deduplicate concurrent fetches
    if (_pending) { await _pending; projects.value = _cache?.projects || []; return }

    loading.value = true
    error.value = ''
    _pending = (async () => {
      try {
        const r = await api.get('/api/projects?limit=500')
        const results = r.data.results || []
        // Sort A-Z
        results.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }))
        _cache = { projects: results, fetchedAt: Date.now() }
        projects.value = results
      } catch (e) {
        const msg = apiErrorMessage(e)
        error.value = msg
        console.error('[useProduuzitProjects] fetch failed:', msg)
      } finally {
        loading.value = false
        _pending = null
      }
    })()
    await _pending
  }

  // ── Auto-fetch on first use ──
  if (_cache) {
    projects.value = _cache.projects
  } else {
    fetchProjects()
  }

  return { projects, superprojects, loading, error, projectsForSuperproject, fetchProjects }
}
