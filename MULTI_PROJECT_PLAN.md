# Multi-Project Trimble Import Plan

## Goal

Allow entities from a **single Trimble model** to be imported into **multiple Produuzit projects** that share the same superproject, split by a "Productgroep" (product group) property in the IFC model.

---

## Key Domain Rules

1. **The Trimble model MUST contain a property literally named `Productgroep` (or `- Productgroep` or equivalent synonyms)** whose value is a **single letter** (A, B, C, D...). This property identifies which sub-project each entity belongs to.

2. **The user first selects a superproject** (e.g., `12709`). This filters the list of available Produuzit target projects to only those matching the pattern `<superproject>-<letter>-*`.

3. **Produuzit project naming convention**: `<5-digit-number>-<Productgroup letter>-<optional description>`.
   - Examples: `12709-C-Elementen`, `12676-A-Beton`, `12713-B`
   - The letter after the first dash IS the product group.

4. **Auto-match**: When a distinct product group letter is found in the entities (e.g., "C"), it is automatically matched to the Produuzit project whose name starts with `XXXXX-C-` (where XXXXX is the selected superproject number).

---

## Architecture Overview

```
Superproject selected: 12709
                                                        
Trimble Model (single IFC file)                        
  │                                                     
  ├── Entity A  (Productgroep = "C")  ──►  Produuzit Project "12709-C-Elementen"
  ├── Entity B  (Productgroep = "A")  ──►  Produuzit Project "12709-A-Beton"    
  ├── Entity C  (Productgroep = "C")  ──►  Produuzit Project "12709-C-Elementen"
  └── Entity D  (Productgroep = "B")  ──►  Produuzit Project "12709-B"          
                                                                                 
Filtered Produuzit projects (matching 12709-*-*):                               
  12709-A-Beton ✓                                                                
  12709-B ✓                                                                      
  12709-C-Elementen ✓                                                            
  12709-D-Gevel ✓                                                                
  12888-A-Other ✗ (wrong superproject)                                          
```

---

## Required Changes

### 1. Configuration: Productgroep Synonyms (`config.yaml`)

Add `product_group` as a new recognized field in the synonyms table so the CSV column detection engine and the Trimble auto-mapper can both recognize it:

```yaml
synonyms:
  # ... existing entries ...
  product_group:
  - productgroep
  - product_group
  - - productgroep
  - -productgroep
  - prod_groep
  - productgroepletter
```

### 2. Frontend: ColumnMapper — New Target (`ColumnMapper.vue`)

Add `product_group` (with label "Product Group ★") as a new selectable target in the ColumnMapper dropdown, alongside `design_name`, `batch_number`, `client_order_id`, etc. When selected, this triggers the multi-project routing UI.

**New i18n keys**:
```javascript
// columnMapper section
productGroup: 'Product Group ★',
```

### 3. Frontend: Superproject-First Selection (`TrimbleImport.vue`)

**Replace the current single "Target Produuzit Project" dropdown** with a two-step flow:

**Step A — Select Superproject**:
```html
<label>Superproject</label>
<Select v-model="selectedSuperproject"
  :options="superprojectOptions"
  placeholder="Select superproject (e.g. 12709)..."
  @change="onSuperprojectChange" />
```

**Step B — Product Group → Project Mapping** (only shown when `product_group` column mapping exists):
```html
<Card title="Project Routing">
  <div v-for="group in distinctProductGroups" :key="group">
    <span>Productgroep "{{ group }}"</span>
    <Select v-model="projectRouting[group]"
      :options="filteredProjects"
      option-label="name" option-value="uuid"
      :placeholder="'Select project for group ' + group + '...'" />
  </div>
  <Button label="Auto-match" @click="autoMatchProjects" />
</Card>
```

**New state**:
```javascript
const selectedSuperproject = ref(null)
const projectRouting = ref({})      // { "A": "uuid-1", "B": "uuid-2", "C": "uuid-3" }
const distinctProductGroups = ref([]) // ["A", "B", "C"] — populated after entity fetch

// Derive superproject numbers from produuzit projects
const superprojectOptions = computed(() => {
  const nums = new Set()
  for (const p of produuzitProjects.value) {
    const m = /^(\d{5})-/.exec(p.name)
    if (m) nums.add(m[1])
  }
  return [...nums].sort().map(n => ({ label: n, value: n }))
})

// Filter projects by selected superproject
const filteredProjects = computed(() => {
  if (!selectedSuperproject.value) return produuzitProjects.value
  return produuzitProjects.value.filter(p =>
    p.name?.startsWith(selectedSuperproject.value + '-')
  )
})
```

**Auto-match logic**:
```javascript
function autoMatchProjects() {
  const routing = {}
  for (const group of distinctProductGroups.value) {
    const pattern = new RegExp(`^${selectedSuperproject.value}-${group}-`)
    const match = filteredProjects.value.find(p => pattern.test(p.name))
    if (match) routing[group] = match.uuid
  }
  projectRouting.value = routing
}
```

### 4. Frontend: Populate Product Groups After Fetch

After `fetchEntities()`, extract distinct product group values from the fetched entities using the mapped `product_group` property:

```javascript
function extractDistinctGroups() {
  const prop = resolveProp(columnMapping.value, 'product_group')
  if (!prop) { distinctProductGroups.value = []; return }
  const groups = new Set()
  for (const entity of previewEntities.value) {
    const val = extractProp(entity, prop)
    if (val) groups.add(val.trim().toUpperCase())
  }
  distinctProductGroups.value = [...groups].sort()
}
```

Call this after `fetchEntities()` completes.

### 5. Backend: `src/routes/trimble.ts` — Accept Project Routing

**`POST /preview-import`** — new optional field:
```typescript
{
  project_uuid: string,        // default project (backward compat)
  column_mapping: Record<string, string>,
  entities: Record<string, unknown>[],
  unique_only?: boolean,
  // NEW:
  project_routing?: {
    prop: string,                     // IFC property path for product_group
    mapping: Record<string, string>,  // product_group_letter -> project_uuid
  }
}
```

**`POST /import`** — same new field.

**Logic change in preview/import loops**:
```typescript
function resolveProjectUuid(
  entity: Record<string, unknown>,
  defaultProjectUuid: string,
  routing: { prop: string; mapping: Record<string, string> } | undefined,
): string {
  if (!routing?.prop?.trim()) return defaultProjectUuid
  const group = (extractProp(entity, routing.prop) || '').trim().toUpperCase()
  return routing.mapping[group] || defaultProjectUuid
}
```

**Batch/design loading must become per-project**:
```typescript
const projectCache = new Map<string, {
  designs: Map<string, string>,
  batches: Record<string, unknown>[],
  assemblies: Record<string, unknown>[],
  dbBatches: Map<string, BatchRow>,
}>()

async function getProjectCache(uuid: string) {
  if (!projectCache.has(uuid)) {
    projectCache.set(uuid, {
      designs: await loadDesigns(uuid),
      batches: await loadBatches(uuid),
      assemblies: await fetchAllPages("/constructibles/assemblies/", { project: uuid, limit: 1000 }),
      dbBatches: new Map(db.getBatches(uuid).map(b => [b.uuid, b])),
    })
  }
  return projectCache.get(uuid)!
}
```

### 6. Frontend Preview Changes

The per-batch preview summary (currently grouped by batch name) needs grouping by `(project, batch)` since different projects may share batch names.

### 7. i18n Keys Needed

```javascript
// en.js — trimble section
superproject: 'Superproject',
selectSuperproject: 'Select superproject (e.g. 12709)...',
projectRouting: 'Project Routing',
routingProp: 'Split by product group',
autoMatch: 'Auto-match',
unmatchedGroups: '{count} unmatched groups',
sameProjectAll: 'Use same project for all',
groupLabel: 'Productgroep "{group}"',
selectProjectForGroup: 'Select project for group {group}...',

// en.js — columnMapper section
productGroup: 'Product Group ★',
```

---

## Revised Effort Estimate

| Component | Complexity | Est. Lines | Est. Hours |
|-----------|-----------|------------|------------|
| `config.yaml`: product_group synonyms | Trivial | ~8 | 0.1h |
| `ColumnMapper.vue`: product_group target | Low | ~15 | 0.3h |
| Frontend: superproject dropdown + filtering | Low | ~40 | 0.5h |
| Frontend: Project Routing card + auto-match | Medium | ~100 | 2h |
| Frontend: distinct group extraction after fetch | Low | ~20 | 0.3h |
| Backend: `POST /preview-import` routing | Medium | ~60 | 1.5h |
| Backend: `POST /import` routing | Medium | ~60 | 1.5h |
| Backend: per-project cache layer | Low | ~40 | 1h |
| Frontend: preview grouping update | Low | ~30 | 0.5h |
| i18n keys (en.js + nl.js) | Trivial | ~25 | 0.25h |
| **Total** | | **~400** | **~8h** |

---

## Risks & Edge Cases

| Risk | Mitigation |
|------|------------|
| Productgroep property missing on some entities | Route to default project (`project_uuid`), warn in UI |
| Productgroep value has no mapped project | Route to default project, flag in results with reason |
| Different projects have same batch names | Group preview by `(project, batch)` tuple |
| Superproject not found in any project name | Show warning, fall back to unfiltered list |
| Productgroep letter doesn't match any project | Show "unmatched" tag, user can manually select or leave unmapped |
| Multiple projects match same letter (e.g., `12709-C` and `12709-C-Elementen`) | Show all matches in dropdown, let user pick |
| Definitive batch blocking per project | Already handled — `dbBatches` is per-project |
| Performance: loading assemblies for N projects | Cache results; typically only 2-5 product groups |
| Trimble property named with hyphen prefix (`- Productgroep`) | Add to synonyms; `detectColumns` handles case-insensitive matching |

---

## Backward Compatibility

- If no property is mapped to `product_group`, behavior is identical to current single-project flow
- The `project_uuid` field remains the default for entities that can't be routed
- All existing API calls to `/preview-import` and `/import` work unchanged without `project_routing`

---

## Implementation Order

1. `config.yaml`: add `product_group` synonyms
2. `ColumnMapper.vue`: add `product_group` target option
3. Backend: add `project_routing` support to both endpoints (non-breaking, optional field)
4. Backend: add per-project cache layer
5. Frontend: add superproject dropdown + project filtering
6. Frontend: add "Project Routing" card with auto-match
7. Frontend: extract distinct product groups after entity fetch
8. Frontend: update preview grouping by `(project, batch)`
9. i18n: add all new translation keys
10. Test with a model containing ≥2 product groups (letters A, B, C...)
