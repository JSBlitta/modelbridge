import { computed } from 'vue'

// Shared derivations for the import preview tables. UnifiedImport and
// TrimbleImport show the same result shape, differing only in the i18n
// namespace their labels come from.
export function useImportPreview({ t, ns, columnMapping, previewData }) {
  const mappingWarnings = computed(() => {
    const targets = Object.values(columnMapping.value).flatMap(v => (Array.isArray(v) ? v : [v]))
    const w = []
    if (!targets.includes('design_name')) w.push(t(`${ns}.noDesignName`))
    if (!targets.includes('batch_number')) w.push(t(`${ns}.noBatchNumber`))
    return w
  })

  const previewRows = computed(() => {
    const rows = []
    for (const bp of previewData.value?.batch_previews || []) {
      for (const r of bp.rows || []) {
        rows.push({ ...r, batch_name: bp.batch_name })
      }
    }
    return rows
  })

  return { mappingWarnings, previewRows }
}
