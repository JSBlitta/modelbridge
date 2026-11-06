<template>
  <div class="trimble-import">
    <div class="page-header">
      <h2 class="page-title">{{ $t('trimble.title') }}</h2>
      <p class="page-subtitle">{{ $t('trimble.subtitle') }}</p>
    </div>

    <Card v-if="!authStatus" class="mb-card">
      <template #title>{{ $t('trimble.connect') }}</template>
      <template #content>
        <div class="flex-row gap-md">
          <Tag severity="warn" :value="$t('trimble.notConnected')" />
          <Button :label="$t('trimble.openLogin')" icon="pi pi-external-link" @click="startLogin" :loading="startingLogin" />
          <Button :label="$t('trimble.refreshStatus')" icon="pi pi-refresh" text @click="loadAuthStatus" :loading="loadingStatus" />
        </div>
        <Message severity="warn" :closable="false" class="mt-sm" style="margin-top:1rem">
          {{ $t('trimble.noAutoPush') }}
        </Message>
      </template>
    </Card>

    <Card v-if="authStatus" class="mb-card">
      <template #title>{{ $t('trimble.selectModelCard') }}</template>
      <template #content>
        <div class="flex-row gap-lg" style="align-items:flex-end">
          <div style="flex:1;min-width:280px;">
            <label class="field-label">{{ $t('trimble.trimbleProject') }}</label>
            <Select v-model="selectedProject" :options="trimbleProjects" option-label="name" option-value="id"
              :placeholder="$t('trimble.selectProject')" class="wide" @change="onProjectChange" />
          </div>
          <Button icon="pi pi-refresh" text :loading="loadingProjects" @click="loadTrimbleProjects"
            v-tooltip.top="$t('trimble.reloadProjects')" />
          <Button :label="$t('trimble.loadFiles')" icon="pi pi-folder-open" @click="loadProjectFiles" :loading="loadingFiles" :disabled="!selectedProject" />
        </div>
        <Message v-if="projectsError" severity="warn" :closable="false" size="small" style="margin-top:0.5rem;">
          {{ $t('trimble.loadFailed', { error: projectsError }) }}
          <Button :label="$t('trimble.retry')" icon="pi pi-refresh" size="small" text @click="loadTrimbleProjects" style="margin-left:0.5rem;" />
        </Message>
        <div v-if="loadingProjects" class="text-dim" style="margin-top:0.5rem">{{ $t('trimble.loadingProjects') }}</div>
        <div v-if="loadingFiles" class="text-dim" style="margin-top:0.5rem">{{ $t('trimble.scanningProject') }}</div>
        <div v-if="modelFiles.length" class="mt-sm">
          <label class="field-label">{{ $t('trimble.modelFile') }} <span style="font-weight:400;color:#6b7280;">({{ modelFiles.length }} found)</span></label>
          <Select v-model="selectedFile" :options="modelFiles" option-label="_display" option-value="id"
            :placeholder="$t('trimble.selectIfc')" class="wide" @change="onFileSelected" />
          <div class="flex-row gap-sm mt-sm" style="align-items:center">
            <Checkbox v-model="geometryOnly" :binary="true" input-id="geometryOnly" @change="onGeometryOnlyToggle" />
            <label for="geometryOnly" style="font-size:0.9rem">{{ $t('trimble.geometryOnly') }}</label>
          </div>
        </div>
        <Message v-if="selectedProject && !loadingFiles && modelFiles.length === 0" severity="info" :closable="false" class="mt-sm">
          {{ $t('trimble.noIfcFiles') }}
        </Message>
      </template>
    </Card>

    <Card v-if="psetDefs.length" class="mb-card">
      <template #title>{{ $t('trimble.propertySetsTitle') }} <span class="subtitle-dim">({{ totalSelectedProps }} selected)</span></template>
      <template #content>
        <div class="flex-row gap-sm mb-sm" style="margin-bottom:0.75rem">
          <Button :label="$t('trimble.selectAll')" icon="pi pi-check-square" text size="small" @click="selectAllProps" />
          <Button :label="$t('trimble.clearAll')" icon="pi pi-stop" text size="small" @click="clearAllProps" />
          <InputText v-model="psetFilter" :placeholder="$t('trimble.filterPsets')" size="small" style="width:200px;" />
        </div>
        <Message v-if="!psetDefs.length" severity="info" :closable="false">{{ $t('trimble.noPsets') }}</Message>
        <template v-for="(group, gi) in psetGroups" :key="group.key">
          <div v-if="gi > 0" class="pset-separator"></div>
          <div v-for="pset in group.items" :key="pset.name" class="pset-block">
            <div class="pset-header" :class="{ 'pset-header-open': isExpanded(pset) }" @click="toggleExpanded(pset)">
              <span class="pset-check" @click.stop>
                <Checkbox :model-value="psetAllChecked(pset)" :indeterminate="psetPartial(pset)" :binary="true"
                  :input-id="'pset_' + pset.name" @change="onPsetToggle(pset)" />
              </span>
              <span class="pset-label">{{ pset.name }}</span>
              <span class="pset-count">{{ psetSelectedCount(pset) }}/{{ propsOfPset(pset).length }} props</span>
              <i class="pi" :class="isExpanded(pset) ? 'pi-chevron-up' : 'pi-chevron-down'"></i>
            </div>
            <div v-if="isExpanded(pset)" class="pset-props">
              <div v-for="prop in propsOfPset(pset)" :key="propName(prop)" class="prop-row">
                <Checkbox v-model="propChecks[propPath(pset.name, prop)]" :binary="true"
                  :input-id="propPath(pset.name, prop)" @change="emitPropSelection" />
                <label :for="propPath(pset.name, prop)" class="prop-label">{{ propLabel(prop) }}</label>
                <span class="prop-type">{{ propType(prop) }}</span>
              </div>
            </div>
          </div>
        </template>
      </template>
    </Card>

    <Card v-if="allSelectedProps.length" class="mb-card">
      <template #title>{{ $t('trimble.mapToProduuzit') }}</template>
      <template #content>
        <div class="mb-sm" style="display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap;margin-bottom:0.75rem;">
          <div>
            <label class="field-label">{{ $t('trimble.superproject') }}</label>
            <Select v-model="selectedSuperproject" :options="superprojects"
              :placeholder="$t('trimble.selectSuperproject')" style="min-width:220px;"
              @change="onSuperprojectChange" :loading="projectsLoading" />
            <small v-if="produuzitProjectsError" style="color:#ef4444;display:block;margin-top:2px;">
              ⚠ {{ produuzitProjectsError }}
            </small>
          </div>
          <div v-if="selectedSuperproject" style="flex:1;min-width:280px;">
            <label class="field-label">{{ $t('trimble.targetProjects') }}
              <span style="font-weight:400;color:#6b7280;">({{ filteredProjects.length }} found)</span>
            </label>
            <div class="project-checklist" style="max-height:180px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:6px;padding:0.4rem 0.6rem;">
              <div v-for="proj in filteredProjects" :key="proj.uuid" style="display:flex;align-items:center;gap:0.4rem;padding:0.15rem 0;">
                <Checkbox :model-value="selectedProjectUuids.has(proj.uuid)" :binary="true"
                  @change="toggleProject(proj.uuid)" :input-id="'proj_' + proj.uuid" />
                <label :for="'proj_' + proj.uuid" style="font-size:0.85rem;cursor:pointer;">{{ proj.name }}</label>
              </div>
            </div>
          </div>
          <Tag v-if="produuzitContext" severity="secondary"
            :value="$t('trimble.contextTag', { designs: produuzitContext.designs?.length || 0, batches: produuzitContext.batches?.length || 0 })" />
        </div>
        <ColumnMapper
          :detected-columns="allSelectedProps"
          :auto-mapping="initialIfcMapping"
          :preview-rows="previewRowsForMapping"
          @mapping-updated="onMappingUpdated"
        />
        <Message v-if="mappingWarnings.length" severity="warn" :closable="false" style="margin-top:0.5rem;">
          {{ mappingWarnings.join(' | ') }}
        </Message>
      </template>
    </Card>

    <Card v-if="allSelectedProps.length && hasSelectedProjects" class="mb-card">
      <template #title>{{ $t('trimble.step5') }}</template>
      <template #content>
        <div class="flex-row gap-md mb-sm" style="margin-bottom:0.75rem">
          <Button :label="$t('trimble.fetchEntities')" icon="pi pi-download" @click="fetchEntities" :loading="fetchingEntities"
            :disabled="!selectedFile" />
          <Button :label="$t('trimble.rawSample')" icon="pi pi-eye" severity="secondary" size="small" text
            @click="fetchRawSample" :loading="fetchingRawSample" :disabled="!selectedFile" />
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <Checkbox v-model="uniqueOnly" :binary="true" input-id="unique_toggle" />
            <label for="unique_toggle" style="font-size:0.85rem;cursor:pointer;">{{ $t('trimble.deduplicateOn') }}</label>
          </div>
          <Select v-if="uniqueOnly" v-model="uniqueKeyProp"
            :options="[{label:'\u2014 entity id (fallback)',value:''}, ...allSelectedProps.map(p=>({label:p.split('.').pop(),value:p}))]"
            option-label="label" option-value="value"
            :placeholder="$t('trimble.selectDedupKey')" style="min-width:200px;font-size:0.82rem;" />
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <Checkbox v-model="includeAssemblies" :binary="true" input-id="include_assemblies" />
            <label for="include_assemblies" style="font-size:0.85rem;cursor:pointer;">{{ $t('trimble.includeAssemblies') }}</label>
          </div>
          <Tag v-if="totalEntities > 0" severity="info" :value="$t('trimble.entitiesTag', { preview: previewEntities.length, total: totalEntities })" />
        </div>
        <details v-if="rawSampleEntity" class="mb-sm" style="font-size:0.78rem">
          <summary style="cursor:pointer;color:#6b7280;font-weight:600;">{{ $t('trimble.rawSampleSummary') }}</summary>
          <pre style="background:#f3f4f6;padding:0.5rem;border-radius:4px;overflow-x:auto;max-height:300px;font-size:0.72rem;white-space:pre-wrap;">{{ JSON.stringify(rawSampleEntity, null, 2) }}</pre>
        </details>
        <details v-if="previewEntities.length" class="mb-sm" style="font-size:0.78rem">
          <summary style="cursor:pointer;color:#6b7280;">{{ $t('trimble.rawFilteredSummary') }}</summary>
          <pre style="background:#f3f4f6;padding:0.5rem;border-radius:4px;overflow-x:auto;max-height:220px;font-size:0.72rem;white-space:pre-wrap;">{{ JSON.stringify(previewEntities[0], null, 2) }}</pre>
        </details>
        <Message v-if="uniqueOnly" severity="secondary" :closable="false" size="small" class="mb-sm">
          {{ $t('trimble.dedupInfo', { key: dedupLabel }) }}
        </Message>

        <div v-if="previewEntities.length">
          <div class="flex-row gap-sm" style="margin-bottom:0.25rem">
            <Button :label="$t('trimble.selectAllEntities')" icon="pi pi-check-square" size="small" text @click="selectAllEntities" />
            <Button :label="$t('trimble.deselectAll')" icon="pi pi-stop" size="small" text @click="deselectAllEntities" />
            <Tag severity="info" :value="$t('trimble.selectedCount', { count: selectedCount })" />
          </div>
          <div class="mb-sm" style="display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;">
            <template v-for="[batch, indices] in entityBatchGroups" :key="batch">
              <div style="display:flex;align-items:center;gap:0.2rem;">
                <Checkbox :model-value="batchSelectionState.get(batch) === 'all'" :binary="true" @change="toggleBatch(batch)" :input-id="'batch_cb_' + batch" />
                <label :for="'batch_cb_' + batch" style="font-size:0.82rem;cursor:pointer;">[{{ batch }}]</label>
              </div>
            </template>
          </div>
        </div>

        <SortFilterTable
          v-if="previewEntities.length"
          :rows="entityRows"
          :columns="entityColumns"
          scrollable
          scroll-height="400px"
        >
          <template #header>
            <InputText v-model="propFilter" :placeholder="$t('trimble.filterColumns')" size="small" style="width:180px;" />
          </template>
          <template #__select="{ data }">
            <Checkbox :model-value="selectedEntityIndices.has(entityIndex(data))" :binary="true" @change="toggleEntity(entityIndex(data))" />
          </template>
        </SortFilterTable>
        <div v-if="!previewEntities.length && !fetchingEntities" class="text-dim">{{ $t('trimble.clickFetch') }}</div>
      </template>
    </Card>

    <Card v-if="previewEntities.length && hasRequiredMapping" class="mb-card">
      <template #title>{{ $t('trimble.previewChanges') }}</template>
      <template #content>
        <div class="flex-row gap-md mb-sm" style="margin-bottom:0.75rem">
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <Checkbox v-model="uniqueOnlyImport" :binary="true" input-id="unique_toggle_import" />
            <label for="unique_toggle_import" style="font-size:0.85rem;cursor:pointer;">{{ $t('trimble.deduplicate') }}</label>
          </div>
          <Button :label="$t('trimble.checkChanges')" icon="pi pi-search" @click="doPreview" :loading="previewing" />
        </div>

        <div class="flex-row gap-md mb-sm" style="margin-bottom:0.75rem;align-items:center;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <Checkbox v-model="includeProductionCounts" :binary="true" input-id="include_counts_toggle" />
            <label for="include_counts_toggle" style="font-size:0.85rem;cursor:pointer;">{{ $t('trimble.includeCounts') }}</label>
          </div>
          <div style="display:flex;align-items:center;gap:0.4rem;">
            <label for="default_count_input" style="font-size:0.85rem;">{{ $t('trimble.defaultCount') }}</label>
            <InputNumber v-model="defaultCount" input-id="default_count_input" :min="1" :step="1" :disabled="!includeProductionCounts" class="num-input-sm" />
          </div>
        </div>
        <Message v-if="previewData" :severity="includeProductionCounts ? 'warn' : 'secondary'" :closable="false" size="small" style="margin-bottom:0.75rem;">
          {{ includeProductionCounts ? $t('trimble.countsIncluded', { default: defaultCount || 1 }) : $t('trimble.countsExcluded') }}
        </Message>

        <div v-if="previewing" class="text-dim mb-sm">
          <i class="pi pi-spin pi-spinner" style="margin-right:0.4rem;"></i>
          {{ $t('trimble.comparing', { count: selectedEntities.length || previewEntities.length }) }}
        </div>

        <div v-if="previewError" class="mb-sm">
          <Message severity="error" :closable="true" @close="previewError = ''">{{ previewError }}</Message>
        </div>

        <div v-if="previewData" style="margin-bottom:1rem;">
          <Message v-if="previewData.unresolved_batches?.length" severity="error" :closable="false" size="small">
            {{ $t('trimble.batchesNotMatched', { batches: previewData.unresolved_batches.join(', ') }) }}
          </Message>
          <Message v-if="previewData.unresolved_designs?.length" severity="error" :closable="false" size="small">
            {{ $t('trimble.designsNotFound', { designs: previewData.unresolved_designs.slice(0, 5).join(', ') + (previewData.unresolved_designs.length > 5 ? '\u2026' : '') }) }}
          </Message>
          <div v-for="bp in previewData.batch_previews" :key="bp.batch_uuid"
            class="batch-preview-row">
            <Tag :severity="bp.blocked ? 'danger' : 'secondary'" :value="bp.batch_name" />
            <span class="chip-new">{{ $t('trimble.newChip', { count: bp.summary.new }) }}</span>
            <span class="chip-changed">{{ $t('trimble.keptChip', { count: bp.summary.kept }) }}</span>
                        <span class="chip-identical" style="color:#9ca3af">{{ $t('trimble.identicalChip', { count: bp.summary.identical }) }}</span>
            <span v-if="bp.order_summary && (bp.order_summary.assign > 0 || bp.order_summary.identical > 0 || bp.order_summary.other > 0 || bp.order_summary.no_constructible > 0 || bp.order_summary.meta_add > 0 || bp.order_summary.meta_differs > 0)" style="color:#2563eb">{{ $t('trimble.orderChip', bp.order_summary) }}</span>
            <Tag v-if="bp.blocked" severity="danger" :value="$t('trimble.blockedChip')" />
          </div>
          <div style="border:1px solid #e5e7eb;border-radius:6px;margin-top:0.75rem;">
            <SortFilterTable
              :rows="countTableRows"
              :columns="countColumns"
              scrollable
              scroll-height="320px"
            >
              <template #status_label="{ data }">
                <Tag :severity="data.status==='new'?'success':data.status==='kept'?'info':data.status==='changed'?'warn':data.status==='identical'?'secondary':'danger'"
                  :value="statusLabel(data.status)" />
              </template>
            </SortFilterTable>
          </div>
          <Message v-if="metaDiffersCount > 0" severity="warn" :closable="false" size="small" style="margin-top:0.5rem;">
            {{ $t('trimble.metaDiffersNote', { count: metaDiffersCount }) }}
          </Message>
          <Message v-if="previewData.client_meta_unattributed > 0" severity="warn" :closable="false" size="small" style="margin-top:0.5rem;">
            {{ $t('trimble.metaUnattributed', { count: previewData.client_meta_unattributed }) }}
          </Message>
          <div v-if="orderRows.length" style="font-weight:600;margin-top:0.75rem;">{{ $t('trimble.orderTitle') }}</div>
          <div v-if="orderRows.length" style="border:1px solid #e5e7eb;border-radius:6px;margin-top:0.25rem;">
            <SortFilterTable
              :rows="orderTableRows"
              :columns="orderColumns"
              scrollable
              scroll-height="320px"
            >
              <template #status_label="{ data }">
                <Tag :severity="data.status==='assign'?'success':data.status==='identical'?'secondary':data.status==='other'?'warn':'danger'"
                  :value="orderStatusLabel(data)" />
              </template>
              <template #meta_text="{ data }">
                <span v-if="!data.meta?.length" style="color:#9ca3af;">—</span>
                <div v-for="m in data.meta" :key="m.key" style="font-size:0.82rem;">
                  <code>{{ m.key }}</code>: {{ m.proposed }}
                  <Tag v-if="m.status === 'add'" severity="success" :value="$t('trimble.metaAdd')" size="small" />
                  <Tag v-else-if="m.status === 'identical'" severity="secondary" :value="$t('trimble.metaIdentical')" size="small" />
                  <Tag v-else-if="m.status === 'differs'" severity="warn" :value="$t('trimble.metaDiffers', { existing: m.existing })" size="small" />
                </div>
              </template>
            </SortFilterTable>
          </div>
          <Message v-if="!canExecute" severity="secondary" :closable="false" size="small" style="margin-top:0.5rem;">
            {{ $t('trimble.nothingToPushDetail') }}
          </Message>
        </div>
      </template>
    </Card>

    <Card v-if="previewData?.unresolved_designs?.length" class="mb-card card-danger-border">
      <template #title>{{ $t('trimble.missingDesignsTitle') }}</template>
      <template #content>
        <Message severity="warn" :closable="false" style="margin-bottom:0.75rem;">
          {{ $t('trimble.missingDesignsBody', { designs: previewData.unresolved_designs.join(', ') }) }}
        </Message>
        <ConfirmedButton
          :label="$t('trimble.createDesignsBtn', { count: previewData.unresolved_designs.length })"
          icon="pi pi-plus"
          :confirm-label="$t('trimble.confirmCreateDesigns', { count: previewData.unresolved_designs.length })"
          :loading="creatingDesigns"
          @action="createMissingDesignsAction" />

        <div v-if="designCreateResults.length" style="margin-top:0.75rem;">
          <Message v-if="designCreateFailedCount === 0" severity="success" :closable="false" size="small">
            {{ $t('trimble.designsCreated', { count: designCreateCreatedCount }) }}
          </Message>
          <Message v-else severity="error" :closable="false" size="small">
            {{ $t('trimble.designsCreatePartial', { created: designCreateCreatedCount, failed: designCreateFailedCount }) }}
          </Message>
          <SortFilterTable
            v-if="designCreateFailedCount"
            :rows="designCreateFailedRows"
            :columns="[{ field: 'design_name', header: t('trimble.design') }, { field: 'reason', header: t('trimble.reason') }]"
            style="margin-top:0.5rem;"
          />
        </div>
      </template>
    </Card>

    <Card v-if="previewData?.unresolved_phases?.length" class="mb-card card-danger-border">
      <template #title>{{ $t('trimble.missingPhasesTitle') }}</template>
      <template #content>
        <Message severity="warn" :closable="false" style="margin-bottom:0.75rem;">
          {{ $t('trimble.missingPhasesBody', { phases: previewData.unresolved_phases.join(', ') }) }}
        </Message>
        <ConfirmedButton
          :label="$t('trimble.createPhasesBtn', { count: previewData.unresolved_phases.length })"
          icon="pi pi-plus"
          :confirm-label="$t('trimble.confirmCreatePhases', { count: previewData.unresolved_phases.length })"
          :loading="creatingPhases"
          @action="createMissingPhasesAction" />

        <div v-if="phaseCreateResults.length" style="margin-top:0.75rem;">
          <Message v-if="phaseCreateFailedCount === 0" severity="success" :closable="false" size="small">
            {{ $t('trimble.phasesCreated', { count: phaseCreateCreatedCount }) }}
          </Message>
          <Message v-else severity="error" :closable="false" size="small">
            {{ $t('trimble.phasesCreatePartial', { created: phaseCreateCreatedCount, failed: phaseCreateFailedCount }) }}
          </Message>
          <SortFilterTable
            v-if="phaseCreateFailedCount"
            :rows="phaseCreateFailedRows"
            :columns="[{ field: 'phase', header: t('trimble.phase') }, { field: 'reason', header: t('trimble.reason') }]"
            style="margin-top:0.5rem;"
          />
        </div>
      </template>
    </Card>

    <Card v-if="previewData && canExecute" class="mb-card card-warn-border">
      <template #title>{{ $t('trimble.pushToProduuzitTitle') }}</template>
      <template #content>
        <Message severity="warn" :closable="false" style="margin-bottom:1rem;">
          <strong>{{ $t('trimble.explicitConfirm') }}</strong>
        </Message>
        <div class="mb-sm" style="margin-bottom:0.75rem">
          <PushGate
            :gate="importGate"
            :show-check="false"
            :confirm-label="$t('trimble.confirmChecked')"
            :push-label="selectedCount ? $t('trimble.pushSelected') : $t('trimble.pushToProduuzit')" />
        </div>
      </template>
    </Card>

    <Card v-if="importResults.length" class="mb-card">
      <template #title>{{ $t('trimble.importResultsTitle') }}</template>
      <template #content>
        <Message v-if="importSummary.error === 0 && importSummary.blocked === 0" severity="success" :closable="false" style="margin-bottom:0.75rem;">
          <strong>{{ $t('trimble.importSuccess') }}</strong>
        </Message>
        <Message v-else severity="warn" :closable="false" style="margin-bottom:0.75rem;">
          {{ $t('trimble.importPartialSuccess') }}
        </Message>
        <div class="summary-chips" style="margin-bottom:0.75rem;">
          <span class="chip-new">{{ importSummary.designs_created }} {{ $t('trimble.designsCreated') }}</span>
          <span class="chip-new">{{ importSummary.constructibles_created }} {{ $t('trimble.constructiblesCreated') }}</span>
          <span class="chip-changed">{{ importSummary.updated }} {{ $t('trimble.updated') }}</span>
          <span class="chip-identical">{{ importSummary.skipped }} {{ $t('trimble.skipped') }}</span>
          <span v-if="importSummary.blocked" class="chip-blocked">{{ importSummary.blocked }} {{ $t('trimble.blocked') }}</span>
          <span v-if="importSummary.error" class="chip-blocked">{{ importSummary.error }} {{ $t('trimble.errors') }}</span>
        </div>
        <SortFilterTable
          v-if="importResults.some(r => r.status === 'error' || r.status === 'blocked')"
          :rows="importResults.filter(r => r.status === 'error' || r.status === 'blocked')"
          :columns="[
            { field: 'design_name', header: t('trimble.design') },
            { field: 'client_order_id', header: t('trimble.orderId') },
            { field: 'batch', header: t('trimble.batch') },
            { field: 'reason', header: t('trimble.reason') },
          ]"
          style="margin-top:0.5rem;"
        />
      </template>
    </Card>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
const { t } = useI18n()
const route = useRoute()
import { api, apiErrorMessage } from '../api.js'
import ColumnMapper from '../components/ColumnMapper.vue'
import { suggestCanonicals } from '../../../src/lib/column-match.ts'
import ConfirmedButton from '../components/ConfirmedButton.vue'
import SortFilterTable from '../components/SortFilterTable.vue'
import PushGate from '../components/PushGate.vue'
import { usePushGate } from '../composables/usePushGate.js'
import { useImportPreview } from '../composables/useImportPreview.js'
import { useProduuzitProjects } from '../composables/useProduuzitProjects.js'
import { useNotifications } from '../composables/useNotifications.js'

const { notify } = useNotifications()

const authStatus = ref(false)
const loadingStatus = ref(false)
const startingLogin = ref(false)

const trimbleProjects = ref([])
const loadingProjects = ref(false)
const projectsError = ref('')
const modelFiles = ref([])
const selectedProject = ref(null)
const selectedFile = ref(null)
const selectedFileVersionId = ref(null)
// Server-side entity text filter ('CalculatedGeometryValues' = only entities
// with geometry). Persisted in the backend settings table, not per session.
const geometryOnly = ref(false)
const loadingFiles = ref(false)

const psetDefs = ref([])
const psetFilter = ref('')
const psetExpanded = ref({})
const propChecks = ref({})

// The client's own property set is pinned above all others in the UI.
const BLITTA_PSET = 'BLITTA'

const { superprojects, loading: projectsLoading, error: produuzitProjectsError, projectsForSuperproject } = useProduuzitProjects()
const selectedSuperproject = ref('')
const selectedProjectUuids = ref(new Set())
const produuzitContext = ref(null)

const filteredProjects = computed(() =>
  selectedSuperproject.value ? projectsForSuperproject(selectedSuperproject.value) : []
)

const hasSelectedProjects = computed(() => selectedProjectUuids.value.size > 0)

const columnMapping = ref({})
const synonyms = ref({})

const allSelectedProps = computed(() => {
  const props = []
  for (const [key, checked] of Object.entries(propChecks.value))
    if (checked) props.push(key)
  return props
})

// Same matcher the CSV imports use (src/lib/column-match.ts), on the property leaf.
const initialIfcMapping = computed(() => {
  const CANONICAL_TARGET = { design: 'design_name', batch: 'batch_number' }
  const m = {}
  const found = suggestCanonicals(allSelectedProps.value, synonyms.value, (p) => p.split('.').pop())
  for (const [prop, canonical] of Object.entries(found)) m[prop] = CANONICAL_TARGET[canonical] || canonical
  return m
})

const hasRequiredMapping = computed(() => {
  const targets = Object.values(columnMapping.value).flatMap(v => Array.isArray(v) ? v : [v])
  return targets.includes('design_name') && targets.includes('batch_number')
})

const dedupLabel = computed(() => {
  if (uniqueKeyProp.value) return uniqueKeyProp.value.split('.').pop()
  return 'entity id (no key selected)'
})

const _rawEntities = ref([])
const previewEntities = computed(() =>
  includeAssemblies.value
    ? _rawEntities.value
    : _rawEntities.value.filter(e => String(e.type || '').toUpperCase() !== 'IFCELEMENTASSEMBLY')
)
const totalEntities = ref(0)
const fetchingEntities = ref(false)
const uniqueOnly = ref(false)
const uniqueKeyProp = ref('')
const includeAssemblies = ref(true)
watch(includeAssemblies, () => { selectedEntityIndices.value = new Set() })
const rawSampleEntity = ref(null)
const fetchingRawSample = ref(false)

// importing / previewing / previewError now come from importGate (declared below).
const previewData = ref(null)
const importResults = ref([])
const importSummary = ref({ designs_created: 0, constructibles_created: 0, updated: 0, skipped: 0, blocked: 0, error: 0 })
const uniqueOnlyImport = ref(true)
// Production counts are an explicit opt-in: unless the operator toggles this on,
// the import only re-checks/matches and writes nothing to Produuzit.
const includeProductionCounts = ref(false)
const defaultCount = ref(1)

const creatingDesigns = ref(false)
const designCreateResults = ref([])
const designCreateCreatedCount = computed(() => designCreateResults.value.filter(r => r.status === 'created').length)
const designCreateFailedCount = computed(() => designCreateResults.value.filter(r => r.status === 'error').length)
const designCreateFailedRows = computed(() => designCreateResults.value.filter(r => r.status === 'error'))

const creatingPhases = ref(false)
const phaseCreateResults = ref([])
const phaseCreateCreatedCount = computed(() => phaseCreateResults.value.filter(r => r.status === 'created').length)
const phaseCreateFailedCount = computed(() => phaseCreateResults.value.filter(r => r.status === 'error').length)
const phaseCreateFailedRows = computed(() => phaseCreateResults.value.filter(r => r.status === 'error'))

const selectedEntityIndices = ref(new Set())

const entityBatchGroups = computed(() => {
  const groups = new Map()
  const batchProp = resolveProp(columnMapping.value, 'batch_number')
  previewEntities.value.forEach((e, i) => {
    const batch = batchProp ? extractProp(e, batchProp) || '__no_batch__' : '__no_batch__'
    if (!groups.has(batch)) groups.set(batch, [])
    groups.get(batch).push(i)
  })
  // Sort low → high by leading number; no-batch entries last
  return new Map([...groups.entries()].sort(([a], [b]) => {
    const na = parseInt(a, 10)
    const nb = parseInt(b, 10)
    if (isNaN(na) && isNaN(nb)) return String(a).localeCompare(String(b))
    if (isNaN(na)) return 1
    if (isNaN(nb)) return -1
    return na - nb
  }))
})

const selectedCount = computed(() => selectedEntityIndices.value.size)

// Entity table column filter state
const propFilter = ref('')
const displayProps = computed(() => {
  const q = propFilter.value.trim().toLowerCase()
  const props = q ? allSelectedProps.value.filter(p => p.toLowerCase().includes(q)) : allSelectedProps.value
  return props.slice(0, 12)
})

const entityColumns = computed(() => [
  { field: '__select', header: '', sortable: false, filter: false, style: 'width:3rem;' },
  ...displayProps.value.map(p => ({ field: p, header: p.split('.').pop(), style: 'min-width:120px;' })),
])

const entityRows = computed(() => previewEntities.value.map((e, i) => {
  const row = {}
  for (const p of displayProps.value) setNested(row, p, extractProp(e, p))
  row.__entity = e
  row.__index = i
  return row
}))

const countColumns = computed(() => [
  { field: 'design_name', header: t('trimble.design') },
  { field: 'client_order_id', header: t('trimble.orderId') },
  { field: 'batch_name', header: t('trimble.batch') },
  { field: 'status_label', header: t('trimble.statusLabel'), style: 'width:110px;' },
  { field: 'count_text', header: t('trimble.countLabel') },
  { field: 'changes_text', header: t('trimble.changes') },
])

const orderColumns = computed(() => [
  { field: 'design_name', header: t('trimble.design') },
  { field: 'order', header: t('trimble.orderId') },
  { field: 'batch_name', header: t('trimble.batch') },
  { field: 'constructible', header: t('trimble.constructible') },
  { field: 'priority', header: t('trimble.priority') },
  { field: 'meta_text', header: t('trimble.clientMeta') },
  { field: 'status_label', header: t('trimble.orderStatus'), style: 'width:170px;' },
])

const selectedEntities = computed(() =>
  previewEntities.value.filter((_, i) => selectedEntityIndices.value.has(i))
)

// Map entity object → its index in previewEntities. Selection is tracked by
// index, but the DataTable's row `index` reflects the sorted/filtered view, so
// we resolve the real index from the row object itself.
const entityIndexMap = computed(() => {
  const m = new Map()
  previewEntities.value.forEach((e, i) => m.set(e, i))
  return m
})

function entityIndex(entity) {
  if (entity && '__index' in entity) return entity.__index
  return entityIndexMap.value.get(entity) ?? -1
}

function toggleEntity(index) {
  if (index < 0) return
  const s = new Set(selectedEntityIndices.value)
  s.has(index) ? s.delete(index) : s.add(index)
  selectedEntityIndices.value = s
}

function selectAllEntities() {
  selectedEntityIndices.value = new Set(previewEntities.value.map((_, i) => i))
}

function deselectAllEntities() {
  selectedEntityIndices.value = new Set()
}

const batchSelectionState = computed(() => {
  const state = new Map()
  for (const [batch, indices] of entityBatchGroups.value) {
    const count = indices.filter(i => selectedEntityIndices.value.has(i)).length
    state.set(batch, count === 0 ? 'none' : count === indices.length ? 'all' : 'some')
  }
  return state
})

function toggleBatch(batchKey) {
  const indices = entityBatchGroups.value.get(batchKey) || []
  const s = new Set(selectedEntityIndices.value)
  const allSelected = indices.every(i => s.has(i))
  if (allSelected) {
    indices.forEach(i => s.delete(i))
  } else {
    indices.forEach(i => s.add(i))
  }
  selectedEntityIndices.value = s
}

const canExecute = computed(() =>
  previewData.value?.batch_previews?.some(bp => !bp.blocked && (
    bp.summary.new > 0 ||
    (bp.order_summary?.assign ?? 0) > 0 ||
    (bp.order_summary?.meta_add ?? 0) > 0
  ))
)

const orderRows = computed(() => {
  const rows = []
  for (const bp of previewData.value?.batch_previews || []) {
    for (const row of bp.order_rows || []) {
      rows.push({ ...row, batch_name: bp.batch_name })
    }
  }
  return rows
})

const countTableRows = computed(() => previewRows.value.map(r => ({
  ...r,
  status_label: statusLabel(r.status),
  count_text: r.status === 'kept'
    ? String(r.count ?? r.count_requested ?? '') + ` (${t('trimble.keptHint', { count: r.count_requested, existing: r.count_existing })})`
    : String(r.count ?? r.count_requested ?? ''),
  changes_text: r.changed_fields?.length ? formatChanges(r) : '',
})))

const orderTableRows = computed(() => orderRows.value.map(r => ({
  ...r,
  constructible: r.assembly_uuid ? r.assembly_uuid.slice(0, 8) : '',
  status_label: orderStatusLabel(r),
  meta_text: (r.meta || []).map(m => m.key + ': ' + m.proposed).join(' | '),
})))

const metaDiffersCount = computed(() =>
  previewData.value?.batch_previews?.reduce((sum, bp) => sum + (bp.order_summary?.meta_differs ?? 0), 0) ?? 0
)

const { mappingWarnings, previewRows } = useImportPreview({
  t, ns: 'trimble', columnMapping, previewData,
})

function statusLabel(status) {
  if (status === 'new') return t('trimble.statusNew')
  if (status === 'changed') return t('trimble.statusChanged')
  if (status === 'identical') return t('trimble.statusIdentical')
  if (status === 'kept') return t('trimble.statusKept')
  if (status === 'blocked') return t('trimble.statusBlocked')
  return status
}

function orderStatusLabel(row) {
  if (row.status === 'assign') return t('trimble.orderAssign')
  if (row.status === 'identical') return t('trimble.orderIdentical')
  if (row.status === 'other') return t('trimble.orderOther', { existing: row.existing })
  if (row.status === 'no_constructible') return t('trimble.orderNoConstructible')
  return row.status
}

function formatChanges(row) {
  const fields = row.changed_fields || []
  return fields.map(f => {
    const oldVal = row.existing?.[f]
    const newVal = row.proposed?.[f]
    const fmt = v => v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    return `${f}: ${fmt(oldVal)} → ${fmt(newVal)}`
  }).join(' | ')
}


const totalSelectedProps = computed(() => allSelectedProps.value.length)

// Psets are grouped for display: BLITTA first, then Trimble-added sets from the
// PSet API, then IFC-native sets from the model API (sorted by name).
const psetGroups = computed(() => {
  const q = psetFilter.value.trim().toLowerCase()
  const matches = (pset) => !q || (pset.name || '').toLowerCase().includes(q)
  const blitta = []
  const psetApi = []
  const model = []
  for (const pset of psetDefs.value) {
    if ((pset.name || '').toUpperCase() === BLITTA_PSET) blitta.push(pset)
    else if (pset.source === 'pset') psetApi.push(pset)
    else model.push(pset)
  }
  model.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  return [
    { key: 'blitta', items: blitta.filter(matches) },
    { key: 'pset', items: psetApi.filter(matches) },
    { key: 'model', items: model.filter(matches) },
  ].filter(group => group.items.length)
})

const previewRowsForMapping = computed(() => {
  if (!previewEntities.value.length) return []
  return previewEntities.value.slice(0, 3).map(flattenEntity)
})

onMounted(async () => {
  loadSynonyms()
  loadGeometryFilter()
  if (route.query.auth === 'success') {
    await loadAuthStatus()
    if (authStatus.value) await loadTrimbleProjects()
  }
  await Promise.all([loadAuthStatus()])
  if (authStatus.value) await loadTrimbleProjects()
})

async function loadGeometryFilter() {
  try {
    const r = await api.get('/api/config/trimble-entity-filter')
    geometryOnly.value = String(r.data?.value ?? '').length > 0
  } catch { geometryOnly.value = false }
}

async function onGeometryOnlyToggle() {
  try {
    await api.put('/api/config/trimble-entity-filter', { value: geometryOnly.value ? 'CalculatedGeometryValues' : '' })
  } catch { /* keep the UI state; the next fetch still sends the override */ }
  // Entities already loaded under the other setting are stale — refetch.
  if (_rawEntities.value.length) fetchEntities()
}

async function loadSynonyms() {
  try { const r = await api.get('/api/config/synonyms'); synonyms.value = r.data || {} }
  catch { synonyms.value = {} }
}

async function loadAuthStatus() {
  loadingStatus.value = true
  try { const r = await api.get('/api/trimble/auth/status'); authStatus.value = !!r.data.authenticated }
  catch { authStatus.value = false }
  finally { loadingStatus.value = false }
}



async function startLogin() {
  startingLogin.value = true
  try {
    const r = await api.get('/api/trimble/auth/start')
    window.location.href = r.data.url
  } finally { startingLogin.value = false }
}

async function loadTrimbleProjects() {
  loadingProjects.value = true
  projectsError.value = ''
  try {
    const r = await api.get('/api/trimble/projects')
    trimbleProjects.value = Array.isArray(r.data) ? r.data : (r.data?.results || [])
  } catch (e) {
    const msg = apiErrorMessage(e)
    const isTokenError = /invalid.*(token|refresh)|token.*invalid|401/i.test(msg)
    if (isTokenError) {
      await api.post('/api/trimble/auth/disconnect').catch(() => {})
      authStatus.value = false
      projectsError.value = ''
    } else {
      projectsError.value = msg
      console.error('[trimble] loadTrimbleProjects failed:', msg)
    }
  } finally { loadingProjects.value = false }
}

async function onProjectChange() {
  modelFiles.value = []; psetDefs.value = []; _rawEntities.value = []; importResults.value = []; selectedEntityIndices.value = new Set()
  selectedFile.value = null; selectedFileVersionId.value = null
}

async function loadProjectFiles() {
  if (!selectedProject.value) return
  loadingFiles.value = true
  modelFiles.value = []; psetDefs.value = []; _rawEntities.value = []; importResults.value = []; selectedEntityIndices.value = new Set()
  selectedFile.value = null; selectedFileVersionId.value = null
  try {
    const r = await api.get(`/api/trimble/projects/${selectedProject.value}/tree`)
    modelFiles.value = (r.data?.items || []).map(f => ({
      ...f,
      _display: `${f.name || f.filename || f.id}${f._releaseName ? '  [' + f._releaseName + ']' : ''}${f._parent ? '  ' + f._parent : ''}`,
    }))
  } catch { modelFiles.value = [] }
  finally { loadingFiles.value = false }
}

function onFileSelected() {
  psetDefs.value = []; _rawEntities.value = []; importResults.value = []; selectedEntityIndices.value = new Set()
  const f = modelFiles.value.find(x => x.id === selectedFile.value)
  selectedFileVersionId.value = f?.versionId || null
  if (selectedFile.value) loadPsetDefs()
}

async function loadPsetDefs() {
  if (!selectedFile.value) return
  try {
    const params = {}
    if (selectedFileVersionId.value) params.versionId = selectedFileVersionId.value
    const r = await api.get(`/api/trimble/models/${selectedFile.value}/psetdefs`, { params })
    const data = r.data
    let raw = []
    if (data.psetdefs) raw = data.psetdefs
    else if (Array.isArray(data)) raw = data
    else if (data.results) raw = data.results
    const modelPsets = mergePsetsByName(raw)
    // Trimble-added psets live in the PSet service, not the IFC/model API.
    const projectPsets = await loadProjectPsetDefs()
    psetDefs.value = buildPsetDefs(modelPsets, projectPsets)
    psetExpanded.value = {}
    propChecks.value = {}
  } catch { psetDefs.value = [] }
}

// Project-level psets added through Trimble Connect (not present in the IFC).
async function loadProjectPsetDefs() {
  if (!selectedProject.value) return []
  try {
    const r = await api.get(`/api/trimble/projects/${selectedProject.value}/pset-catalog`)
    return (r.data?.definitions || []).map(d => ({
      name: d.name || d.def_id,
      properties: (d.properties || []).map(p => ({ name: p.name, type: p.type, label: p.label })),
    }))
  } catch { return [] }
}

// Merge model- and PSet-API definitions by name, unioning their properties
// (first occurrence wins) and tagging each entry with its origin so the UI can
// group them. A name also present in the PSet API is treated as Trimble-added.
function buildPsetDefs(modelPsets, psetApiDefs) {
  const merged = new Map()
  const add = (pset, source) => {
    const name = pset.name || ''
    if (!name) return
    let entry = merged.get(name)
    if (!entry) {
      entry = { name, properties: [], source }
      merged.set(name, entry)
    } else if (source === 'pset') {
      entry.source = 'pset'
    }
    for (const prop of propsOfPset(pset)) {
      const pname = typeof prop === 'string' ? prop : (prop?.name || '')
      if (!entry.properties.some(ex => (typeof ex === 'string' ? ex : ex?.name) === pname)) {
        entry.properties.push(prop)
      }
    }
  }
  for (const pset of modelPsets || []) add(pset, 'model')
  for (const pset of psetApiDefs || []) add(pset, 'pset')
  return [...merged.values()]
}

function mergePsetsByName(raw) {
  const merged = {}
  for (const pset of raw) {
    const name = pset.name || ''
    if (!merged[name]) {
      merged[name] = { name, properties: [] }
    }
    const props = Array.isArray(pset.properties) ? pset.properties
      : (Array.isArray(pset.props) ? pset.props : [])
    for (const prop of props) {
      const pname = typeof prop === 'string' ? prop : (prop?.name || '')
      if (!merged[name].properties.some(ex =>
        (typeof ex === 'string' ? ex : ex?.name) === pname
      )) {
        merged[name].properties.push(prop)
      }
    }
  }
  return Object.values(merged)
}

function propsOfPset(pset) {
  return Array.isArray(pset?.properties) ? pset.properties : (Array.isArray(pset?.props) ? pset.props : [])
}

function propPath(psetName, prop) {
  // PSet-API properties expose a resolved `label`, and the backend keys the
  // merged values by `label ?? name`; IFC-native properties only have `name`.
  return `psets.${psetName}.${propLabel(prop)}`
}

function propName(prop) { return typeof prop === 'string' ? prop : (prop?.name || prop?.propertyName || '') }
function propLabel(prop) { return (typeof prop === 'object' && prop?.label) || propName(prop) }
function propType(prop) { return typeof prop === 'object' ? (prop?.type || '') : '' }

function selectAllProps() {
  for (const pset of psetDefs.value) {
    for (const prop of propsOfPset(pset))
      propChecks.value[propPath(pset.name, prop)] = true
  }
}

function clearAllProps() { propChecks.value = {} }

function psetSelectedCount(pset) {
  let count = 0
  for (const prop of propsOfPset(pset))
    if (propChecks.value[propPath(pset.name, prop)]) count++
  return count
}

function psetAllChecked(pset) {
  const props = propsOfPset(pset)
  return props.length > 0 && psetSelectedCount(pset) === props.length
}

function psetPartial(pset) {
  const count = psetSelectedCount(pset)
  return count > 0 && count < propsOfPset(pset).length
}

// The pset checkbox is a select-all/none shortcut, kept separate from the
// expand/collapse state so individual properties can be cherry-picked.
function onPsetToggle(pset) {
  const target = !psetAllChecked(pset)
  for (const prop of propsOfPset(pset))
    propChecks.value[propPath(pset.name, prop)] = target
}

function isExpanded(pset) { return !!psetExpanded.value[pset.name] }
function toggleExpanded(pset) { psetExpanded.value[pset.name] = !psetExpanded.value[pset.name] }

function emitPropSelection() { /* reactive */ }

async function loadProduuzitContext(projectUuid) {
  if (!projectUuid) return
  try { const r = await api.get(`/api/assemblies/context?project_uuid=${projectUuid}`); produuzitContext.value = r.data }
  catch { /* noop */ }
}

function toggleProject(uuid) {
  const s = new Set(selectedProjectUuids.value)
  s.has(uuid) ? s.delete(uuid) : s.add(uuid)
  selectedProjectUuids.value = s
  // Load context for the last toggled-on project (or clear if none)
  const arr = [...s]
  loadProduuzitContext(arr.length ? arr[arr.length - 1] : null)
}

function onSuperprojectChange() {
  selectedProjectUuids.value = new Set()
  produuzitContext.value = null
}

function onMappingUpdated(m) { columnMapping.value = m }

function flattenEntity(e) { const f = {}; for (const p of allSelectedProps.value) f[p] = extractProp(e, p); return f }

function setNested(obj, path, value) {
  const parts = String(path).split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {}
    cur = cur[p]
  }
  cur[parts[parts.length - 1]] = value
}

function extractProp(entity, propPathStr) {
  if (!propPathStr) return ''
  const parts = propPathStr.split('.')
  let val = entity
  for (const p of parts) {
    if (val === null || val === undefined) return ''
    if (Array.isArray(val)) {
      const match = val.find(item => typeof item === 'object' && item !== null && (item.pset_name === p || item.name === p))
      if (match !== undefined) { val = match } else { return '' }
    } else if (typeof val === 'object') {
      if (p in val) {
        val = val[p]
      } else {
        const sub = val.props ?? val.properties ?? val.values
        if (sub && typeof sub === 'object') {
          if (Array.isArray(sub)) {
            const found = sub.find(pr => typeof pr === 'string' ? pr === p : (pr?.name === p || pr?.propertyName === p))
            val = found === undefined ? '' : (typeof found === 'string' ? found : (found?.value ?? found?.nominalValue ?? ''))
          } else { val = sub[p] ?? '' }
        } else { return '' }
      }
    } else { return '' }
  }
  return val !== null && val !== undefined ? String(val) : ''
}

async function fetchRawSample() {
  if (!selectedFile.value) return
  fetchingRawSample.value = true
  rawSampleEntity.value = null
  try {
    const versionId = selectedFileVersionId.value || selectedFile.value
    const r = await api.get(`/api/trimble/models/${selectedFile.value}/entities/sample`, { params: { versionId } })
    rawSampleEntity.value = r.data
  } catch (e) {
    rawSampleEntity.value = { error: e?.response?.data || e?.message || String(e) }
  } finally { fetchingRawSample.value = false }
}

async function fetchEntities() {
  if (!selectedFile.value || !allSelectedProps.value.length) return
  fetchingEntities.value = true; _rawEntities.value = []; totalEntities.value = 0; selectedEntityIndices.value = new Set()
  try {
    // Always fetch with assemblies — client-side toggle filters instantly
    const body = { versionId: selectedFileVersionId.value || selectedFile.value, fields: allSelectedProps.value, unique_only: uniqueOnly.value, unique_key_prop: uniqueKeyProp.value || undefined, include_assemblies: true, column_mapping: columnMapping.value, project_id: selectedProject.value || undefined, entity_text_filter: geometryOnly.value ? 'CalculatedGeometryValues' : undefined }
    const r = await api.post(`/api/trimble/models/${selectedFile.value}/entities`, body)
    _rawEntities.value = r.data.entities || []
    totalEntities.value = r.data.total || _rawEntities.value.length
    if (previewEntities.value.length) console.log('[trimble] sample entity structure:', JSON.stringify(previewEntities.value[0], null, 2))
  } finally { fetchingEntities.value = false }
}

// Everything the check depends on. Kept cheap — entity payloads run to
// thousands of objects, so the identity is a summary, not a serialisation.
function importInputs() {
  const ents = selectedEntities.value.length ? selectedEntities.value : previewEntities.value
  return [
    [...selectedProjectUuids.value][0] || '',
    selectedFile.value || '',
    selectedFileVersionId.value || '',
    JSON.stringify(columnMapping.value),
    uniqueOnlyImport.value ? '1' : '0',
    includeProductionCounts.value ? '1' : '0',
    String(Number(defaultCount.value) || 1),
    ents.length,
    // Guard against a same-length but different selection.
    ents.length ? String(ents[0]?.id ?? '') + '|' + String(ents[ents.length - 1]?.id ?? '') : '',
  ].join('::')
}

function importBody() {
  const ents = selectedEntities.value.length ? selectedEntities.value : previewEntities.value
  return {
    project_uuid: [...selectedProjectUuids.value][0],
    column_mapping: columnMapping.value,
    entities: ents,
    unique_only: uniqueOnlyImport.value,
    include_production_counts: includeProductionCounts.value,
    default_count: Number(defaultCount.value) || 1,
  }
}

const importGate = usePushGate({
  identity: importInputs,
  check: async () => {
    const r = await api.post('/api/trimble/preview-import', importBody())
    previewData.value = r.data
    return r.data
  },
  push: async (previewToken) => {
    const r = await api.post('/api/trimble/import', { ...importBody(), preview_token: previewToken })
    importResults.value = r.data.results || []
    importSummary.value = r.data.summary || { designs_created: 0, constructibles_created: 0, updated: 0, skipped: 0, blocked: 0, error: 0 }
    previewData.value = null
    const unmatched = importResults.value.filter(x => x.status === 'error' && /No batch named/.test(x.reason || ''))
    if (importSummary.value.error) {
      notify({ severity: 'error', summary: t('trimble.errors'), detail: t('trimble.importErrorsDetail', { count: importSummary.value.error }), life: 8000 })
    }
    if (unmatched.length) {
      notify({ severity: 'warn', summary: t('trimble.batchesNotMatched', { batches: unmatched.map(x => x.batch).join(', ') }), detail: '', life: 8000 })
    } else if (importSummary.value.designs_created || importSummary.value.constructibles_created || importSummary.value.updated) {
      notify({ severity: 'success', summary: t('trimble.pushToProduuzitTitle'), detail: t('trimble.importSuccessDetail', { designs: importSummary.value.designs_created, constructibles: importSummary.value.constructibles_created }), life: 5000 })
    }
    return r.data
  },
})

// The template and the create-missing flows still speak in these terms.
const previewing = computed(() => importGate.checking)
const previewError = computed(() => importGate.error)
const doPreview = () => importGate.runCheck()

async function createMissingDesignsAction() {
  const missing = previewData.value?.unresolved_designs || []
  if (!missing.length) return
  creatingDesigns.value = true
  designCreateResults.value = []
  try {
    const projectUuid = [...selectedProjectUuids.value][0]
    const r = await api.post('/api/trimble/create-missing-designs', {
      project_uuid: projectUuid,
      design_names: missing,
    })
    designCreateResults.value = r.data.results || []
    const summary = r.data.summary || { created: 0, failed: 0 }
    if (summary.failed) {
      notify({ severity: 'error', summary: t('trimble.designsCreatePartial', { created: summary.created, failed: summary.failed }), life: 8000 })
    } else if (summary.created) {
      notify({ severity: 'success', summary: t('trimble.designsCreated', { count: summary.created }), life: 5000 })
    }
    // Refresh the preview so the newly created designs resolve and appear in
    // the normal import confirmation step.
    if (summary.created) await doPreview()
  } catch (e) {
    const msg = apiErrorMessage(e)
    notify({ severity: 'error', summary: t('trimble.createDesignsFailed'), detail: msg, life: 8000 })
  } finally {
    creatingDesigns.value = false
  }
}

async function createMissingPhasesAction() {
  const missing = previewData.value?.unresolved_phases || []
  if (!missing.length) return
  creatingPhases.value = true
  phaseCreateResults.value = []
  try {
    const projectUuid = [...selectedProjectUuids.value][0]
    const r = await api.post('/api/trimble/create-missing-phases', {
      project_uuid: projectUuid,
      phases: missing,
    })
    phaseCreateResults.value = r.data.results || []
    const summary = r.data.summary || { created: 0, failed: 0 }
    if (summary.failed) {
      notify({ severity: 'error', summary: t('trimble.phasesCreatePartial', { created: summary.created, failed: summary.failed }), life: 8000 })
    } else if (summary.created) {
      notify({ severity: 'success', summary: t('trimble.phasesCreated', { count: summary.created }), life: 5000 })
    }
    // Refresh the preview so the newly created phases are recognized.
    if (summary.created) await doPreview()
  } catch (e) {
    const msg = apiErrorMessage(e)
    notify({ severity: 'error', summary: t('trimble.createPhasesFailed'), detail: msg, life: 8000 })
  } finally {
    creatingPhases.value = false
  }
}

function resolveProp(columnMappingObj, target) {
  for (const [ifcProp, prodTarget] of Object.entries(columnMappingObj)) {
    if (prodTarget === target) return ifcProp
    if (Array.isArray(prodTarget) && prodTarget.includes(target)) return ifcProp
  }
  return ''
}
</script>

<style scoped>
.trimble-import { max-width: 1440px; margin: 0 auto; }
.page-header { margin-bottom: 1.25rem; }
.page-subtitle { color: #6b7280; font-size: 0.9rem; margin-top: 0.25rem; }
.subtitle-dim { font-weight: 400; font-size: 0.85rem; color: #6b7280; }
.field-label { display: block; font-size: 0.8rem; font-weight: 600; color: #4b5563; margin-bottom: 0.25rem; }
.wide { width: 100%; }
.num-input-sm { width: 90px; }
.mb-card { margin-bottom: 1rem; }
.card-warn-border { border-left: 4px solid #f59e0b; }
.card-danger-border { border-left: 4px solid #ef4444; }

.pset-separator { height: 1px; background: #e5e7eb; margin: 0.6rem 0; }
.pset-block { margin-bottom: 0.5rem; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; }
.pset-header { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; background: #f9fafb; cursor: pointer; user-select: none; }
.pset-header-open { background: #f3f4f6; }
.pset-header .pi { color: #9ca3af; font-size: 0.75rem; }
.pset-check { display: inline-flex; align-items: center; }
.pset-label { font-weight: 600; font-size: 0.9rem; flex: 1; }
.pset-count { color: #9ca3af; font-size: 0.75rem; }
.pset-props { padding: 0.25rem 0.75rem 0.5rem 2rem; }
.prop-row { display: flex; align-items: center; gap: 0.4rem; padding: 0.2rem 0; }
.prop-label { font-size: 0.82rem; cursor: pointer; }
.prop-type { color: #9ca3af; font-size: 0.7rem; margin-left: auto; }

.summary-chips { display: flex; gap: 0.5rem; flex-wrap: wrap; }
</style>
