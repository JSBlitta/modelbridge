// Group presets — the Trimble-facing half of the admin "group presets" feature.
//
// A locally stored preset (see db.ts) is resolved against a project's live
// Trimble state and then applied: user groups are created (or reused) and
// folder permissions are granted. Everything here uses the Connect Core API
// v2 client in trimble-client.ts; the region is the EU pod the rest of the app
// already uses.
//
// Endpoints (Core API v2):
//   GET    projects/{id}/users?enableFilters=false&includesRemoved=false
//   POST   projects/{id}/users?notify=true           { email, role }
//   GET    groups?projectId={id}
//   POST   groups                                    { name, projectId }
//   GET    groups/{groupId}/users
//   POST   groups/{groupId}/users                    [{ id }]
//   GET    folders/fs/{folderId}/permissions
//   PATCH  folders/fs/{folderId}/permissions         { acl, inheritance }

import type { GroupPreset } from './db.ts';
import * as db from './db.ts';
import { logger } from './logger.ts';
import {
  expandTokens,
  matchFolders,
  aclFromAssignments,
  mergeAssignments,
  normalizeAcl,
  type Acl,
  type Assignment,
  type FolderRef,
  type MatchType,
  type PermissionLevel,
} from './lib/group-preset-rules.ts';
import {
  getRegionEndpoints,
  trimbleGet,
  trimblePatch,
  trimblePost,
} from './trimble-client.ts';

interface CoreUser {
  id: string;
  email: string;
  role: string;
  status: string;
}

interface CoreGroup {
  id: string;
  name: string;
  usersCount?: number;
}

function core(path: string): string {
  return getRegionEndpoints().Core + path;
}

function asList(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === 'object') {
    const p = raw as Record<string, unknown>;
    const list = p.results ?? p.items ?? p.entities;
    if (Array.isArray(list)) return list as Record<string, unknown>[];
  }
  return [];
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const MAX_FOLDERS = 5000;

async function fetchProject(projectId: string): Promise<Record<string, unknown>> {
  return (await trimbleGet(core(`projects/${encodeURIComponent(projectId)}`))) as Record<string, unknown>;
}

/** Walk the whole folder tree and return every folder with its full path. */
export async function fetchFolderTree(projectId: string): Promise<FolderRef[]> {
  const project = await fetchProject(projectId);
  const rootId = String(project.rootId ?? project.id ?? '');
  if (!rootId) throw new Error(`Project ${projectId} has no rootId`);

  const out: FolderRef[] = [];
  const visited = new Set<string>();
  const queue: { id: string; path: string }[] = [{ id: rootId, path: '' }];

  while (queue.length && out.length < MAX_FOLDERS) {
    const { id, path } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    let raw: unknown;
    try {
      raw = await trimbleGet(core(`folders/${encodeURIComponent(id)}/items`));
    } catch {
      continue;
    }
    for (const item of asList(raw)) {
      if (String(item.type ?? '').toLowerCase() !== 'folder') continue;
      const childId = String(item.id ?? '');
      if (!childId) continue;
      const name = String(item.name ?? '');
      const childPath = path ? `${path}/${name}` : name;
      out.push({ id: childId, name, path: childPath });
      queue.push({ id: childId, path: childPath });
    }
  }
  return out;
}

/** Project members keyed by lower-cased e-mail. */
export async function fetchProjectUsers(projectId: string): Promise<Map<string, CoreUser>> {
  // enableFilters=false: the caller's saved Team filters otherwise hide members.
  const raw = await trimbleGet(core(`projects/${encodeURIComponent(projectId)}/users`), {
    enableFilters: 'false',
    includesRemoved: 'false',
  });
  const map = new Map<string, CoreUser>();
  for (const u of asList(raw)) {
    const email = String(u.email ?? '').toLowerCase();
    if (!email) continue;
    map.set(email, {
      id: String(u.id ?? ''),
      email,
      role: String(u.role ?? ''),
      status: String(u.status ?? ''),
    });
  }
  return map;
}

export async function fetchGroups(projectId: string): Promise<CoreGroup[]> {
  const raw = await trimbleGet(core('groups'), { projectId });
  return asList(raw)
    .map((g) => ({ id: String(g.id ?? ''), name: String(g.name ?? ''), usersCount: g.usersCount as number }))
    .filter((g) => g.id);
}

async function fetchGroupUserIds(groupId: string): Promise<Set<string>> {
  try {
    const raw = await trimbleGet(core(`groups/${encodeURIComponent(groupId)}/users`));
    return new Set(asList(raw).map((u) => String(u.id ?? '')).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Current ACL of a folder. A 404 (no explicit ACL yet) yields an empty ACL. */
async function getFolderAcl(folderId: string): Promise<{ acl: Acl; inheritance: boolean | null }> {
  try {
    const raw = (await trimbleGet(core(`folders/fs/${encodeURIComponent(folderId)}/permissions`))) as Record<string, unknown>;
    if (raw && typeof raw === 'object') {
      return {
        acl: normalizeAcl(raw.acl),
        inheritance: typeof raw.inheritance === 'boolean' ? raw.inheritance : null,
      };
    }
  } catch {
    /* no explicit ACL yet */
  }
  return { acl: {}, inheritance: null };
}

// --- Resolution (dry run) --------------------------------------------------

export interface ResolvedMember {
  email: string;
  role: 'USER' | 'ADMIN';
  /** member = already in the project; to_invite = will be invited; skipped = not a member and invites are off. */
  status: 'member' | 'to_invite' | 'skipped';
  user_id: string | null;
}

export interface ResolvedRule {
  match_type: MatchType;
  pattern: string;
  expanded: string;
  level: PermissionLevel;
  matched: { id: string; path: string }[];
  missing?: string;
  invalid?: string;
}

export interface ResolvedGroup {
  name: string;
  existing: boolean;
  group_id: string | null;
  members: ResolvedMember[];
  rules: ResolvedRule[];
}

export interface Resolution {
  project_id: string;
  project_name: string;
  folder_count: number;
  groups: ResolvedGroup[];
}

export interface PlanOptions {
  applyPermissions: boolean;
  autoInvite: boolean;
}

async function buildPlan(projectId: string, preset: GroupPreset, options: PlanOptions): Promise<Resolution> {
  const project = await fetchProject(projectId);
  const projectName = String(project.name ?? projectId);

  const [folders, users, groups] = await Promise.all([
    fetchFolderTree(projectId),
    fetchProjectUsers(projectId),
    fetchGroups(projectId),
  ]);

  const groupsByName = new Map<string, CoreGroup>();
  for (const g of groups) if (g.name) groupsByName.set(g.name.trim().toLowerCase(), g);

  const baseVars = { PROJECT_NAME: projectName };
  const resolvedGroups: ResolvedGroup[] = [];

  for (const g of preset.groups) {
    const existingGroup = groupsByName.get(g.name.trim().toLowerCase()) ?? null;
    // $COMPANY_NAME / $GROUP_NAME both expand to this group's name: presets
    // commonly model one company or discipline per group.
    const vars = { ...baseVars, COMPANY_NAME: g.name, GROUP_NAME: g.name };

    const members: ResolvedMember[] = g.members.map((m) => {
      const email = m.email.trim();
      const user = users.get(email.toLowerCase());
      if (user) return { email, role: m.role ?? 'USER', status: 'member', user_id: user.id };
      const effectiveAuto = m.auto_invite === null ? preset.auto_invite_default : m.auto_invite;
      if (options.autoInvite && effectiveAuto) {
        return { email, role: m.role ?? 'USER', status: 'to_invite', user_id: null };
      }
      return { email, role: m.role ?? 'USER', status: 'skipped', user_id: null };
    });

    const rules: ResolvedRule[] = g.rules.map((r) => {
      const level = (r.level ?? preset.default_permission) as PermissionLevel;
      const m = matchFolders({ match_type: r.match_type, pattern: r.pattern, level }, folders, vars);
      return {
        match_type: r.match_type,
        pattern: r.pattern,
        expanded: expandTokens(r.pattern, vars),
        level,
        matched: m.matched.map((f) => ({ id: f.id, path: f.path })),
        missing: m.missing,
        invalid: m.invalid,
      };
    });

    resolvedGroups.push({
      name: g.name,
      existing: Boolean(existingGroup),
      group_id: existingGroup ? existingGroup.id : null,
      members,
      rules,
    });
  }

  return {
    project_id: projectId,
    project_name: projectName,
    folder_count: folders.length,
    groups: resolvedGroups,
  };
}

/** Read-only dry run: what would happen if the preset were applied. */
export async function previewPreset(
  projectId: string,
  preset: GroupPreset,
  options: PlanOptions,
): Promise<Resolution> {
  return buildPlan(projectId, preset, options);
}

// --- Apply -----------------------------------------------------------------

export interface ApplyGroupResult {
  name: string;
  group_id: string;
  created: boolean;
  invited: string[];
  added: string[];
  skipped: { email: string; reason: string }[];
  errors: string[];
  grants: { pattern: string; level: PermissionLevel; folders: number; note?: string }[];
}

export interface ApplyFolderResult {
  path: string;
  ok: boolean;
  error?: string;
}

export interface ApplyReport {
  project_id: string;
  project_name: string;
  apply_permissions: boolean;
  replace_acl: boolean;
  groups: ApplyGroupResult[];
  folders: ApplyFolderResult[];
}

export interface ApplyOptions extends PlanOptions {
  /** Replace each folder's ACL instead of merging into it. */
  replaceAcl: boolean;
}

export async function applyPreset(
  projectId: string,
  preset: GroupPreset,
  options: ApplyOptions,
): Promise<ApplyReport> {
  const plan = await buildPlan(projectId, preset, options);
  const report: ApplyReport = {
    project_id: projectId,
    project_name: plan.project_name,
    apply_permissions: options.applyPermissions,
    replace_acl: options.replaceAcl,
    groups: [],
    folders: [],
  };

  // folderId -> intended assignments (union across all groups).
  const folderAssignments = new Map<string, { path: string; assignments: Assignment[] }>();

  for (const rg of plan.groups) {
    const result: ApplyGroupResult = {
      name: rg.name,
      group_id: rg.group_id ?? '',
      created: false,
      invited: [],
      added: [],
      skipped: [],
      errors: [],
      grants: [],
    };

    // 1. Resolve the Trimble group (create or reuse).
    let groupId = rg.group_id;
    if (!groupId) {
      try {
        const created = (await trimblePost(core('groups'), { name: rg.name, projectId })) as Record<string, unknown>;
        groupId = String(created?.id ?? '');
        if (!groupId) throw new Error('create group returned no id');
        result.created = true;
      } catch (e) {
        result.errors.push(`create group: ${errMsg(e)}`);
        report.groups.push(result);
        continue;
      }
    }
    result.group_id = groupId;

    // 2. Members — invite when needed, then add the ones not already in the group.
    const memberIds = await fetchGroupUserIds(groupId);
    const toAdd: string[] = [];
    for (const m of rg.members) {
      if (m.status === 'skipped') {
        result.skipped.push({ email: m.email, reason: 'not a project member' });
        continue;
      }
      let userId = m.user_id;
      if (m.status === 'to_invite') {
        try {
          const invited = (await trimblePost(
            `${core(`projects/${encodeURIComponent(projectId)}/users`)}?notify=true`,
            { email: m.email, role: m.role },
          )) as Record<string, unknown>;
          userId = String(invited?.id ?? '');
          result.invited.push(m.email);
        } catch (e) {
          result.errors.push(`invite ${m.email}: ${errMsg(e)}`);
          continue;
        }
      }
      if (userId && !memberIds.has(userId)) {
        toAdd.push(userId);
        memberIds.add(userId);
      }
    }
    if (toAdd.length) {
      try {
        await trimblePost(
          core(`groups/${encodeURIComponent(groupId)}/users`),
          toAdd.map((id) => ({ id })),
        );
        result.added.push(...toAdd);
      } catch (e) {
        result.errors.push(`add members: ${errMsg(e)}`);
      }
    }

    // 3. Collect folder grants (applied after every group exists).
    if (options.applyPermissions) {
      for (const rule of rg.rules) {
        if (rule.invalid) {
          result.grants.push({ pattern: rule.pattern, level: rule.level, folders: 0, note: `invalid regex: ${rule.invalid}` });
          continue;
        }
        if (!rule.matched.length) {
          result.grants.push({
            pattern: rule.pattern,
            level: rule.level,
            folders: 0,
            note: rule.missing ? `folder not found: ${rule.missing}` : 'no folders matched',
          });
          continue;
        }
        result.grants.push({ pattern: rule.pattern, level: rule.level, folders: rule.matched.length });
        for (const f of rule.matched) {
          let entry = folderAssignments.get(f.id);
          if (!entry) {
            entry = { path: f.path, assignments: [] };
            folderAssignments.set(f.id, entry);
          }
          entry.assignments.push({ subjectId: groupId, level: rule.level });
        }
      }
    }

    report.groups.push(result);
  }

  // 4. Apply the folder ACLs.
  if (options.applyPermissions) {
    for (const [folderId, entry] of folderAssignments) {
      try {
        const current = await getFolderAcl(folderId);
        const acl = options.replaceAcl
          ? aclFromAssignments(entry.assignments)
          : mergeAssignments(current.acl, entry.assignments);
        // An explicit per-folder ACL only takes effect once the folder stops
        // inheriting; preserve whatever inheritance flag the folder already
        // reports rather than forcing it (mirrors the reference Core client).
        const body: Record<string, unknown> = { acl };
        if (current.inheritance !== null) body.inheritance = current.inheritance;
        await trimblePatch(core(`folders/fs/${encodeURIComponent(folderId)}/permissions`), body);
        report.folders.push({ path: entry.path, ok: true });
      } catch (e) {
        report.folders.push({ path: entry.path, ok: false, error: errMsg(e) });
      }
    }
  }

  db.recordEvent({
    category: 'trimble',
    level: report.folders.some((f) => !f.ok) || report.groups.some((g) => g.errors.length) ? 'warn' : 'info',
    summary: `Group preset "${preset.name}" applied to ${plan.project_name}`,
    detail: `${report.groups.length} group(s) · ${report.groups.reduce((n, g) => n + g.added.length, 0)} member(s) added · ${report.folders.filter((f) => f.ok).length} folder ACL(s) set`,
  });
  logger.info(`Group preset "${preset.name}" applied to project ${projectId}`);

  return report;
}
