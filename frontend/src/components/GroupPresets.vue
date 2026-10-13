<template>
  <div class="gp">
    <!-- 1. The presets themselves: stored locally, nothing here touches Trimble. -->
    <Card class="mb-card">
      <template #title>{{ $t('groupPresets.presetsTitle') }}</template>
      <template #content>
        <p class="text-dim">{{ $t('groupPresets.presetsHint') }}</p>
        <div class="flex-row gap-sm">
          <Select
            v-model="selectedId"
            :options="presets"
            option-label="name"
            option-value="id"
            :placeholder="$t('groupPresets.choosePreset')"
            class="gp-select"
            data-test="preset-select" />
          <Button :label="$t('groupPresets.newPreset')" icon="pi pi-plus" text data-test="preset-new" @click="newPreset" />
          <Button
            v-if="draft?.id"
            :label="$t('groupPresets.deletePreset')"
            icon="pi pi-trash"
            severity="danger"
            text
            data-test="preset-delete"
            @click="removePreset" />
        </div>

        <div v-if="draft" class="gp-editor">
          <div class="form-grid">
            <div class="field">
              <label class="field-label" for="gp-name">{{ $t('groupPresets.name') }}</label>
              <InputText id="gp-name" v-model="draft.name" class="wide" data-test="preset-name" />
            </div>
            <div class="field">
              <label class="field-label" for="gp-desc">{{ $t('groupPresets.description') }}</label>
              <InputText id="gp-desc" v-model="draft.description" class="wide" />
            </div>
            <div class="field">
              <label class="field-label" for="gp-level">{{ $t('groupPresets.defaultPermission') }}</label>
              <Select v-model="draft.default_permission" input-id="gp-level" :options="levels" option-label="label" option-value="value" class="wide" />
            </div>
          </div>
          <div class="checkbox-row">
            <Checkbox v-model="draft.apply_permissions_default" :binary="true" input-id="gp-perm-default" />
            <label for="gp-perm-default">{{ $t('groupPresets.applyPermissionsDefault') }}</label>
          </div>
          <div class="checkbox-row">
            <Checkbox v-model="draft.auto_invite_default" :binary="true" input-id="gp-invite-default" />
            <label for="gp-invite-default">{{ $t('groupPresets.autoInviteDefault') }}</label>
          </div>

          <fieldset v-for="(group, gi) in draft.groups" :key="gi" class="gp-group" :data-test="`group-${gi}`">
            <legend>{{ $t('groupPresets.group') }} {{ gi + 1 }}</legend>
            <div class="flex-row gap-sm">
              <InputText
                v-model="group.name"
                class="gp-grow"
                :placeholder="$t('groupPresets.groupName')"
                :aria-label="$t('groupPresets.groupName')"
                :data-test="`group-${gi}-name`" />
              <Button :label="$t('groupPresets.removeGroup')" severity="danger" size="small" text @click="draft.groups.splice(gi, 1)" />
            </div>

            <h4 class="gp-sub">{{ $t('groupPresets.members') }}</h4>
            <div v-for="(member, mi) in group.members" :key="mi" class="gp-row">
              <InputText
                v-model="member.email"
                class="gp-grow"
                placeholder="naam@bedrijf.nl"
                :aria-label="$t('groupPresets.email')"
                :data-test="`group-${gi}-member-${mi}`" />
              <Select v-model="member.role" :options="roles" option-label="label" option-value="value" :aria-label="$t('groupPresets.role')" class="gp-narrow" />
              <Select v-model="member.invite" :options="inviteChoices" option-label="label" option-value="value" :aria-label="$t('groupPresets.invite')" class="gp-mid" />
              <Button icon="pi pi-times" severity="secondary" size="small" text :aria-label="$t('groupPresets.remove')" @click="group.members.splice(mi, 1)" />
            </div>
            <Button :label="$t('groupPresets.addMember')" icon="pi pi-plus" size="small" text :data-test="`group-${gi}-add-member`" @click="group.members.push(blankMember())" />

            <h4 class="gp-sub">{{ $t('groupPresets.rules') }}</h4>
            <div v-for="(rule, ri) in group.rules" :key="ri" class="gp-row">
              <Select v-model="rule.match_type" :options="matchTypes" option-label="label" option-value="value" :aria-label="$t('groupPresets.matchType')" class="gp-narrow" />
              <InputText
                v-model="rule.pattern"
                class="gp-grow"
                placeholder="01-WIP/**"
                :aria-label="$t('groupPresets.pattern')"
                :data-test="`group-${gi}-rule-${ri}`" />
              <Select v-model="rule.level" :options="ruleLevels" option-label="label" option-value="value" :aria-label="$t('groupPresets.level')" class="gp-mid" />
              <Button icon="pi pi-times" severity="secondary" size="small" text :aria-label="$t('groupPresets.remove')" @click="group.rules.splice(ri, 1)" />
            </div>
            <Button :label="$t('groupPresets.addRule')" icon="pi pi-plus" size="small" text :data-test="`group-${gi}-add-rule`" @click="group.rules.push(blankRule())" />
          </fieldset>

          <p class="text-dim">
            {{ $t('groupPresets.patternHint') }}
            <code>*</code> <code>**</code> <code>$COMPANY_NAME</code> <code>$GROUP_NAME</code> <code>$PROJECT_NAME</code>
          </p>

          <div class="actions-row">
            <Button :label="$t('groupPresets.addGroup')" icon="pi pi-plus" text data-test="group-add" @click="draft.groups.push(blankGroup())" />
            <Button :label="$t('groupPresets.save')" :disabled="!dirty || !draft.name.trim()" :loading="saving" data-test="preset-save" @click="savePreset" />
          </div>
        </div>
      </template>
    </Card>

    <!-- 2. Apply to a project: check first, confirm, then write. -->
    <Card>
      <template #title>{{ $t('groupPresets.applyTitle') }}</template>
      <template #content>
        <p class="text-dim">{{ $t('groupPresets.applyHint') }}</p>

        <Message v-if="!draft?.id || dirty" severity="info" :closable="false" size="small">
          {{ $t('groupPresets.saveFirst') }}
        </Message>
        <template v-else>
          <div class="form-grid">
            <div class="field">
              <label class="field-label" for="gp-project">{{ $t('groupPresets.project') }}</label>
              <Select
                v-model="projectId"
                input-id="gp-project"
                :options="projects"
                option-label="name"
                option-value="project_id"
                filter
                :placeholder="$t('groupPresets.chooseProject')"
                class="wide"
                data-test="project-select" />
              <p v-if="projectsLoaded && !projects.length" class="text-dim">{{ $t('groupPresets.noProjects') }}</p>
            </div>
          </div>
          <div class="checkbox-row">
            <Checkbox v-model="applyPermissions" :binary="true" input-id="gp-run-perm" />
            <label for="gp-run-perm">{{ $t('groupPresets.runPermissions') }}</label>
          </div>
          <div class="checkbox-row">
            <Checkbox v-model="autoInvite" :binary="true" input-id="gp-run-invite" />
            <label for="gp-run-invite">{{ $t('groupPresets.runInvite') }}</label>
          </div>

          <PushGate
            :gate="gate"
            :check-label="$t('groupPresets.check')"
            :check-disabled="!projectId"
            :show-push="Boolean(plan && plan.changes)"
            :confirm-label="$t('groupPresets.confirm', { project: plan?.project_name ?? '', count: plan?.changes ?? 0 })"
            :push-label="$t('groupPresets.apply')"
            push-icon="pi pi-users" />
          <p v-if="/: 401/.test(gate.error)" class="text-dim">{{ $t('groupPresets.notConnected') }}</p>
        </template>

        <!-- The plan: what an apply would do, as read from Trimble just now. -->
        <div v-if="plan" class="gp-plan" data-test="plan">
          <Message v-for="(b, i) in plan.blockers" :key="`b${i}`" severity="error" :closable="false" size="small">
            {{ $t(`groupPresets.issue.${b.code}`, b) }}
          </Message>
          <Message v-for="(w, i) in plan.warnings" :key="`w${i}`" severity="warn" :closable="false" size="small">
            {{ $t(`groupPresets.issue.${w.code}`, w) }}
          </Message>
          <Message v-if="!plan.blockers.length && !plan.changes" severity="success" :closable="false" data-test="plan-nothing">
            {{ $t('groupPresets.nothingToDo', { project: plan.project_name }) }}
          </Message>
          <Message v-if="plan.invites.length" severity="warn" :closable="false" data-test="plan-invites">
            {{ $t('groupPresets.invitesWarning', { count: plan.invites.length }) }}
            <strong>{{ plan.invites.join(', ') }}</strong>
          </Message>

          <div v-for="g in plan.groups" :key="g.name" class="gp-plan-group">
            <h4 class="gp-sub">
              {{ g.name }}
              <span :class="g.create ? 'chip-new' : 'chip-identical'">{{ $t(g.create ? 'groupPresets.groupNew' : 'groupPresets.groupExists') }}</span>
            </h4>
            <div v-for="m in g.members" :key="m.email" class="gp-line">
              <span>{{ m.email }}</span>
              <span :class="actionChip[m.action]">{{ $t(`groupPresets.action.${m.action}`) }}</span>
            </div>
            <div v-for="(r, i) in g.rules" :key="i" class="gp-line text-dim">
              <code>{{ r.expanded }}</code>
              <span>{{ $t(`groupPresets.levels.${r.level}`) }} · {{ $t('groupPresets.foldersMatched', { count: r.matched.length }) }}</span>
            </div>
          </div>

          <template v-if="plan.folders.length">
            <h4 class="gp-sub">{{ $t('groupPresets.folders') }}</h4>
            <div class="gp-scroll">
              <div v-for="f in plan.folders" :key="f.id" class="gp-line">
                <code>{{ f.path }}</code>
                <span>{{ f.grants.map((x) => `${x.group}: ${$t(`groupPresets.levels.${x.level}`)}`).join(', ') }}</span>
                <span class="text-dim">{{ $t('groupPresets.kept', { count: keptCount(f) }) }}</span>
                <span :class="f.change ? 'chip-new' : 'chip-identical'">{{ $t(f.change ? 'groupPresets.folderChange' : 'groupPresets.folderSame') }}</span>
              </div>
            </div>
          </template>
        </div>

        <!-- The report: what the apply did, each line read back from Trimble. -->
        <div v-if="report" class="gp-plan" data-test="report">
          <Message :severity="report.ok ? 'success' : 'error'" :closable="false">
            {{ $t(report.ok ? 'groupPresets.reportOk' : 'groupPresets.reportFailed', { count: report.writes, project: report.project_name }) }}
          </Message>
          <div v-for="g in report.groups" :key="g.name" class="gp-plan-group">
            <h4 class="gp-sub">
              {{ g.name }}
              <span v-if="g.created" class="chip-new">{{ $t('groupPresets.groupCreated') }}</span>
            </h4>
            <div v-if="g.invited.length" class="gp-line"><span>{{ $t('groupPresets.invited') }}</span><span>{{ g.invited.join(', ') }}</span></div>
            <div v-if="g.added.length" class="gp-line"><span>{{ $t('groupPresets.added') }}</span><span>{{ g.added.join(', ') }}</span></div>
            <div v-for="(e, i) in g.errors" :key="i" class="gp-line text-blocked">{{ e }}</div>
          </div>
          <template v-if="report.folders.length">
            <h4 class="gp-sub">{{ $t('groupPresets.folders') }}</h4>
            <div class="gp-scroll">
              <div v-for="f in report.folders" :key="f.path" class="gp-line">
                <code>{{ f.path }}</code>
                <span v-if="f.ok" class="chip-new">{{ $t('groupPresets.folderDone') }}</span>
                <span v-else class="text-blocked">{{ f.error }}</span>
              </div>
            </div>
          </template>
          <p class="text-dim">{{ $t('groupPresets.reportHint') }}</p>
        </div>
      </template>
    </Card>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfirm } from 'primevue/useconfirm'
import { api } from '../api.js'
import { useNotifications } from '../composables/useNotifications.js'
import { usePushGate } from '../composables/usePushGate.js'
import PushGate from './PushGate.vue'

const BASE = '/api/admin/group-presets'

const { t } = useI18n()
const { notify } = useNotifications()
const confirm = useConfirm()

const LEVELS = ['READ', 'FULL_ACCESS', 'NO_ACCESS']
const levels = LEVELS.map((value) => ({ value, label: t(`groupPresets.levels.${value}`) }))
// The editor uses plain strings where the API uses null for "follow the preset".
const ruleLevels = [{ value: 'DEFAULT', label: t('groupPresets.presetDefault') }, ...levels]
const inviteChoices = ['default', 'yes', 'no'].map((value) => ({ value, label: t(`groupPresets.inviteChoice.${value}`) }))
const roles = ['USER', 'ADMIN'].map((value) => ({ value, label: t(`groupPresets.roles.${value}`) }))
const matchTypes = ['PATH', 'REGEX'].map((value) => ({ value, label: t(`groupPresets.matchTypes.${value}`) }))
const actionChip = { in_group: 'chip-identical', add: 'chip-new', invite: 'chip-changed', skipped: 'chip-blocked' }

const blankMember = () => ({ email: '', role: 'USER', invite: 'default' })
const blankRule = () => ({ match_type: 'PATH', pattern: '', level: 'DEFAULT' })
const blankGroup = () => ({ name: '', members: [blankMember()], rules: [blankRule()] })

// --- Presets ---------------------------------------------------------------

const presets = ref([])
const selectedId = ref(null)
const draft = ref(null)
const savedJson = ref('')
const saving = ref(false)
const dirty = computed(() => Boolean(draft.value) && JSON.stringify(draft.value) !== savedJson.value)

function toDraft(p) {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? '',
    default_permission: p.default_permission ?? 'READ',
    apply_permissions_default: p.apply_permissions_default !== false,
    auto_invite_default: p.auto_invite_default !== false,
    groups: (p.groups ?? []).map((g) => ({
      name: g.name,
      members: (g.members ?? []).map((m) => ({
        email: m.email,
        role: m.role ?? 'USER',
        invite: m.auto_invite === true ? 'yes' : m.auto_invite === false ? 'no' : 'default',
      })),
      rules: (g.rules ?? []).map((r) => ({ match_type: r.match_type ?? 'PATH', pattern: r.pattern, level: r.level ?? 'DEFAULT' })),
    })),
  }
}

// Empty rows are a convenience of the editor, not part of the preset.
function toPayload(d) {
  return {
    name: d.name.trim(),
    description: d.description.trim(),
    default_permission: d.default_permission,
    apply_permissions_default: d.apply_permissions_default,
    auto_invite_default: d.auto_invite_default,
    groups: d.groups
      .filter((g) => g.name.trim())
      .map((g) => ({
        name: g.name.trim(),
        members: g.members
          .filter((m) => m.email.trim())
          .map((m) => ({ email: m.email.trim(), role: m.role, auto_invite: m.invite === 'yes' ? true : m.invite === 'no' ? false : null })),
        rules: g.rules
          .filter((r) => r.pattern.trim())
          .map((r) => ({ match_type: r.match_type, pattern: r.pattern.trim(), level: r.level === 'DEFAULT' ? null : r.level })),
      })),
  }
}

function edit(d) {
  draft.value = d
  savedJson.value = d.id ? JSON.stringify(d) : ''
}

async function loadPresets() {
  presets.value = (await api.get(BASE)).data ?? []
}

watch(selectedId, (id) => {
  const p = presets.value.find((x) => x.id === id)
  if (p) edit(toDraft(p))
})

function newPreset() {
  selectedId.value = null
  edit({ id: null, name: '', description: '', default_permission: 'READ', apply_permissions_default: true, auto_invite_default: true, groups: [blankGroup()] })
}

async function savePreset() {
  saving.value = true
  try {
    const d = draft.value
    const res = d.id ? await api.put(`${BASE}/${d.id}`, toPayload(d)) : await api.post(BASE, toPayload(d))
    await loadPresets()
    // Show what was stored, not what was typed: empty rows are gone.
    edit(toDraft(presets.value.find((x) => x.id === res.data.id)))
    selectedId.value = res.data.id
    notify({ severity: 'success', summary: t('groupPresets.saved') })
  } catch {
    /* the API layer already reported it */
  } finally {
    saving.value = false
  }
}

function removePreset() {
  const d = draft.value
  confirm.require({
    header: t('groupPresets.deletePreset'),
    message: t('groupPresets.confirmDelete', { name: d.name }),
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: t('groupPresets.cancel'),
    acceptLabel: t('groupPresets.deletePreset'),
    accept: async () => {
      await api.delete(`${BASE}/${d.id}`)
      draft.value = null
      selectedId.value = null
      await loadPresets()
    },
  })
}

// --- Apply -----------------------------------------------------------------

const projects = ref([])
const projectsLoaded = ref(false)
const projectId = ref(null)
const applyPermissions = ref(true)
const autoInvite = ref(true)
const plan = ref(null)
const report = ref(null)

// A run starts from what the preset says; the operator may switch either off.
watch(savedJson, () => {
  if (!draft.value?.id) return
  applyPermissions.value = draft.value.apply_permissions_default
  autoInvite.value = draft.value.auto_invite_default
})

const runBody = () => ({
  project_id: projectId.value,
  preset_id: draft.value.id,
  apply_permissions: applyPermissions.value,
  auto_invite: autoInvite.value,
})

const gate = usePushGate({
  // savedJson stands for the stored preset: saving a change is a new check.
  identity: () => [savedJson.value, projectId.value ?? '', applyPermissions.value, autoInvite.value].join('::'),
  check: async () => {
    report.value = null
    plan.value = null
    plan.value = (await api.post(`${BASE}/preview`, runBody())).data
    return plan.value
  },
  push: async (previewToken) => {
    const res = await api.post(`${BASE}/apply`, { ...runBody(), preview_token: previewToken })
    report.value = res.data
    plan.value = null
    return res.data
  },
})

// The gate drops its check when an input changes; drop what is on screen with it.
watch(
  () => gate.checkResult,
  (result) => {
    if (!result) plan.value = null
  },
)

const keptCount = (f) => Object.values(f.current ?? {}).reduce((n, list) => n + list.length, 0)

onMounted(async () => {
  try {
    await loadPresets()
    projects.value = (await api.get(`${BASE}/projects`)).data ?? []
  } catch {
    /* 403 is handled by the admin page around this tab */
  } finally {
    projectsLoaded.value = true
  }
})
</script>

<style scoped>
.gp-select { min-width: 280px; }
.gp-editor { margin-top: 1rem; }
.gp-group { border: 1px solid #e5e7eb; border-radius: 8px; padding: 0.75rem; margin: 0.75rem 0; }
.gp-group legend { font-size: 0.8rem; font-weight: 600; color: #4b5563; padding: 0 0.4rem; }
.gp-sub { font-size: 0.85rem; font-weight: 600; color: #374151; margin: 0.85rem 0 0.35rem; display: flex; align-items: center; gap: 0.5rem; }
.gp-row { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.35rem; }
.gp-grow { flex: 1; min-width: 0; }
.gp-narrow { width: 150px; }
.gp-mid { width: 210px; }
.gp-plan { margin-top: 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
.gp-plan-group { border-left: 3px solid #e5e7eb; padding-left: 0.75rem; }
.gp-line { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; padding: 0.2rem 0; font-size: 0.85rem; }
.gp-scroll { max-height: 320px; overflow-y: auto; border: 1px solid #f3f4f6; border-radius: 6px; padding: 0.25rem 0.6rem; }
.field { margin-bottom: 0.75rem; }
.field-label { display: block; font-size: 0.8rem; font-weight: 600; color: #4b5563; margin-bottom: 0.25rem; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 0.75rem; }
.checkbox-row { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem; }
.actions-row { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
code { background: #f3f4f6; padding: 0.05rem 0.3rem; border-radius: 4px; font-size: 0.8rem; }
</style>
