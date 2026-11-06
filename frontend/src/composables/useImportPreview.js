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

// Why the push to Produuzit is not on screen yet, in the order the operator has to
// fix it. Empty means the push is available. Both CSV screens (/import and the
// count import on /batches) show this list where the push button would be.
export function importBlockers({ t, project, parsed, mapping, preview, includeCounts }) {
  if (!project) return [t('pushBlock.project')]
  if (!parsed) return [t('pushBlock.csv')]
  const targets = Object.values(mapping || {}).flatMap(v => (Array.isArray(v) ? v : [v]))
  const out = []
  if (!targets.includes('design_name')) out.push(t('pushBlock.design'))
  if (!targets.includes('batch_number')) out.push(t('pushBlock.batch'))
  if (out.length) return out
  if (!preview) return [t('pushBlock.check')]
  if (preview.uuid_mode) {
    if (preview.has_errors) return [t('pushBlock.uuidErrors')]
    if (!preview.row_previews?.some(r => r.status === 'changed')) return [t('pushBlock.nothingChanged')]
    return []
  }
  const bps = preview.batch_previews || []
  if (!bps.length) {
    return [preview.unresolved_batches?.length
      ? t('pushBlock.batchesMissing', { batches: preview.unresolved_batches.join(', ') })
      : t('pushBlock.noRows')]
  }
  if (bps.every(b => b.blocked)) return [t('pushBlock.definitive')]
  if (!bps.some(b => !b.blocked && b.summary.new > 0)) return [t('pushBlock.nothingNew')]
  if (!includeCounts) return [t('pushBlock.counts')]
  return []
}
