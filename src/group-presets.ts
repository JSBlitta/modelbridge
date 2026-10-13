// Group presets — the Trimble-facing half of the admin "group presets" feature.
//
// A locally stored preset (see db.ts) is resolved against a project's live
// Trimble state into a plan, and the plan is then carried out: user groups are
// created (or reused), members invited and added, folder permissions granted.
//
// The rules this file keeps:
//   - One plan. What the check shows is what the apply does; the route binds
//     the check token to planGateInput(), so a project that changed in between
//     is checked again instead of written to.
//   - Additive only. Nothing here removes a member, a group or a grant.
//   - Nothing is written from a guess. A read that fails, fails the plan.
//   - Running twice is safe. A plan lists only what is still missing, and every
//     write is read back before it is reported as done.
//
// Endpoints (Core API v2, see the Trimble Connect API spec):
//   GET    projects/{id}
//   GET    projects/{id}/users?enableFilters=false&includesRemoved=false  (paged)
//   POST   projects/{id}/users?notify=true           { email, role }
//   GET    users/me
//   GET    groups?projectId={id}
//   POST   groups                                    { name, projectId }
//   GET    groups/{groupId}/users
//   POST   groups/{groupId}/users                    [{ id }]
//   GET    folders/{folderId}/items
//   GET    folders/fs/{folderId}/permissions
//   PATCH  folders/fs/{folderId}/permissions         { acl, inheritance }

import type { GroupPreset } from './db.ts';
import * as db from './db.ts';
import { logger } from './logger.ts';
import {
  PERMISSION_LEVELS,
  expandTokens,
  groupSubject,
  matchFolders,
  mergeAssignments,
  normalizeAcl,
  sameAcl,
  subjectsAt,
  type Acl,
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

const key = (s: string): string => s.trim().toLowerCase();

const MAX_FOLDERS = 5000;
const MAX_USERS = 20000;

async function fetchProject(projectId: string): Promise<Record<string, unknown>> {
  return (await trimbleGet(core(`projects/${encodeURIComponent(projectId)}`))) as Record<string, unknown>;
}

/**
 * Walk the whole folder tree and return every folder with its full path.
 *
 * A listing that fails, or a tree past MAX_FOLDERS, throws. Returning what was
 * read so far would look like a complete tree, and rules would then report
 * existing folders as missing.
 */
export async function fetchFolderTree(projectId: string): Promise<FolderRef[]> {
  const project = await fetchProject(projectId);
  const rootId = String(project.rootId ?? project.id ?? '');
  if (!rootId) throw new Error(`Project ${projectId} has no rootId`);

  const out: FolderRef[] = [];
  const visited = new Set<string>();
  const queue: { id: string; path: string }[] = [{ id: rootId, path: '' }];

  // ponytail: one request per folder, in turn. Fetch a level at a time in
  // parallel if large projects make the check slow.
  while (queue.length) {
    const { id, path } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const raw = await trimbleGet(core(`folders/${encodeURIComponent(id)}/items`));
    for (const item of asList(raw)) {
      if (String(item.type ?? '').toLowerCase() !== 'folder') continue;
      const childId = String(item.id ?? '');
      if (!childId) continue;
      const name = String(item.name ?? '');
      const childPath = path ? `${path}/${name}` : name;
      out.push({ id: childId, name, path: childPath });
      queue.push({ id: childId, path: childPath });
    }
    if (out.length > MAX_FOLDERS) {
      throw new Error(`Project has more than ${MAX_FOLDERS} folders; not working from a partial folder list`);
    }
  }
  return out;
}

/**
 * Project members keyed by lower-cased e-mail.
 *
 * The list is paged (Range header, answer 206). The first request takes
 * whatever page the server gives by itself; later ones ask for the next range
 * of that size, until a request brings nobody new. A member missed here would
 * be taken for a stranger and invited again.
 */
export async function fetchProjectUsers(projectId: string): Promise<Map<string, CoreUser>> {
  const url = core(`projects/${encodeURIComponent(projectId)}/users`);
  // enableFilters=false: the caller's saved Team filters otherwise hide members.
  const params = { enableFilters: 'false', includesRemoved: 'false' };
  const map = new Map<string, CoreUser>();
  const seen = new Set<string>();
  let pageSize = 0;

  for (let start = 0; start < MAX_USERS; ) {
    let page: Record<string, unknown>[];
    try {
      const range = start ? { Range: `items=${start}-${start + pageSize - 1}` } : undefined;
      page = asList(await trimbleGet(url, params, range));
    } catch (e) {
      if (start && /: 416$/.test(errMsg(e))) break; // asked past the end
      throw e;
    }
    const before = seen.size;
    for (const u of page) {
      const email = String(u.email ?? '').toLowerCase();
      const id = String(u.id ?? '');
      seen.add(id || email);
      if (!email) continue;
      map.set(email, { id, email, role: String(u.role ?? ''), status: String(u.status ?? '') });
    }
    // Nobody new: an empty page, or a server that ignores Range and sent the
    // first page again.
    if (seen.size === before) break;
    pageSize ||= page.length;
    start += page.length;
  }
  return map;
}

export async function fetchGroups(projectId: string): Promise<CoreGroup[]> {
  const raw = await trimbleGet(core('groups'), { projectId });
  return asList(raw)
    .map((g) => ({ id: String(g.id ?? ''), name: String(g.name ?? '') }))
    .filter((g) => g.id);
}

async function fetchGroupUserIds(groupId: string): Promise<Set<string>> {
  const raw = await trimbleGet(core(`groups/${encodeURIComponent(groupId)}/users`));
  return new Set(asList(raw).map((u) => String(u.id ?? '')).filter(Boolean));
}

/** Permissions set on the folder itself. A 404 (none set yet) yields an empty ACL. */
async function getFolderAcl(folderId: string): Promise<{ acl: Acl; inheritance: boolean | null }> {
  try {
    const raw = (await trimbleGet(core(`folders/fs/${encodeURIComponent(folderId)}/permissions`))) as Record<string, unknown>;
    if (raw && typeof raw === 'object') {
      return {
        acl: normalizeAcl(raw.acl),
        inheritance: typeof raw.inheritance === 'boolean' ? raw.inheritance : null,
      };
    }
  } catch (e) {
    // Only a 404 means "no explicit ACL yet". Any other failure has to stop the
    // plan: the PATCH replaces the folder's permissions, so a write built on an
    // ACL we could not read would drop every grant already on it.
    if (!/: 404$/.test(errMsg(e))) throw e;
  }
  return { acl: {}, inheritance: null };
}

/** The caller's role in the project, or null when it cannot be told. */
async function callerRole(users: Map<string, CoreUser>): Promise<string | null> {
  try {
    const me = (await trimbleGet(core('users/me'))) as Record<string, unknown> | null;
    const id = String(me?.id ?? '');
    const hit = users.get(String(me?.email ?? '').toLowerCase()) ?? [...users.values()].find((u) => id && u.id === id);
    return hit?.role ? hit.role.toUpperCase() : null;
  } catch {
    // Not knowing is a warning, not a stop: Trimble refuses the writes of a
    // non-admin by itself.
    return null;
  }
}

// --- The plan ----------------------------------------------------------------

/** A reason the plan cannot be applied (blocker) or deserves a look (warning). */
export interface PlanIssue {
  code: 'invalid_regex' | 'not_project_admin' | 'role_unknown' | 'no_folder_match';
  group?: string;
  pattern?: string;
  detail?: string;
}

export interface PlanMember {
  email: string;
  role: 'USER' | 'ADMIN';
  /**
   * in_group  already a member of the group: nothing to do
   * add       project member, will be added to the group
   * invite    not in the project: gets an invitation mail, then joins the group
   * skipped   not in the project and not invited
   */
  action: 'in_group' | 'add' | 'invite' | 'skipped';
  user_id: string | null;
}

export interface PlanRule {
  match_type: MatchType;
  pattern: string;
  expanded: string;
  level: PermissionLevel;
  matched: { id: string; path: string }[];
}

export interface PlanGroup {
  name: string;
  group_id: string | null;
  /** The group does not exist in the project yet. */
  create: boolean;
  members: PlanMember[];
  rules: PlanRule[];
}

export interface PlanFolder {
  id: string;
  path: string;
  /** What the preset wants on this folder, by preset group name. */
  grants: { group: string; level: PermissionLevel }[];
  /** The folder's own permissions as read for this plan; they are kept. */
  current: Acl;
  inheritance: boolean | null;
  /** False when the folder already carries every grant. */
  change: boolean;
}

export interface Plan {
  project_id: string;
  project_name: string;
  folder_count: number;
  blockers: PlanIssue[];
  warnings: PlanIssue[];
  groups: PlanGroup[];
  folders: PlanFolder[];
  /** E-mail addresses that get an invitation. */
  invites: string[];
  /** Number of writes the plan implies; 0 means the project already matches. */
  changes: number;
}

export interface PlanOptions {
  applyPermissions: boolean;
  autoInvite: boolean;
}

/** Read the project and work out what applying the preset would still change. Reads only. */
export async function buildPlan(projectId: string, preset: GroupPreset, options: PlanOptions): Promise<Plan> {
  const project = await fetchProject(projectId);
  const projectName = String(project.name ?? projectId);

  const [folders, users, groups] = await Promise.all([
    options.applyPermissions ? fetchFolderTree(projectId) : Promise.resolve([]),
    fetchProjectUsers(projectId),
    fetchGroups(projectId),
  ]);

  const blockers: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];

  const role = await callerRole(users);
  if (role === null) warnings.push({ code: 'role_unknown' });
  else if (role !== 'ADMIN') blockers.push({ code: 'not_project_admin', detail: role });

  const groupsByName = new Map<string, CoreGroup>();
  for (const g of groups) if (g.name) groupsByName.set(key(g.name), g);

  const planGroups: PlanGroup[] = [];
  const byFolder = new Map<string, PlanFolder>();
  const invites = new Set<string>();
  let changes = 0;

  for (const g of preset.groups) {
    const existing = groupsByName.get(key(g.name)) ?? null;
    const inGroup = existing ? await fetchGroupUserIds(existing.id) : new Set<string>();
    if (!existing) changes++;

    const members: PlanMember[] = g.members.map((m) => {
      const email = m.email.trim();
      const memberRole = m.role ?? 'USER';
      const user = users.get(email.toLowerCase());
      if (user) {
        const action = inGroup.has(user.id) ? 'in_group' : 'add';
        if (action === 'add') changes++;
        return { email, role: memberRole, action, user_id: user.id };
      }
      const allowed = m.auto_invite === null ? preset.auto_invite_default : m.auto_invite;
      if (options.autoInvite && allowed) {
        if (!invites.has(email.toLowerCase())) changes++; // the invitation itself, once per person
        invites.add(email.toLowerCase());
        changes++; // joining this group
        return { email, role: memberRole, action: 'invite', user_id: null };
      }
      return { email, role: memberRole, action: 'skipped', user_id: null };
    });

    // $COMPANY_NAME / $GROUP_NAME both expand to this group's name: presets
    // commonly model one company or discipline per group.
    const vars = { PROJECT_NAME: projectName, COMPANY_NAME: g.name, GROUP_NAME: g.name };
    const rules: PlanRule[] = [];
    for (const r of options.applyPermissions ? g.rules : []) {
      const level = (r.level ?? preset.default_permission) as PermissionLevel;
      const m = matchFolders({ match_type: r.match_type, pattern: r.pattern, level }, folders, vars);
      const expanded = expandTokens(r.pattern, vars);
      if (m.invalid) blockers.push({ code: 'invalid_regex', group: g.name, pattern: r.pattern, detail: m.invalid });
      else if (!m.matched.length) warnings.push({ code: 'no_folder_match', group: g.name, pattern: expanded });
      rules.push({
        match_type: r.match_type,
        pattern: r.pattern,
        expanded,
        level,
        matched: m.matched.map((f) => ({ id: f.id, path: f.path })),
      });
      for (const f of m.matched) {
        let entry = byFolder.get(f.id);
        if (!entry) {
          entry = { id: f.id, path: f.path, grants: [], current: {}, inheritance: null, change: false };
          byFolder.set(f.id, entry);
        }
        // One level per group and folder: a later rule replaces an earlier one.
        entry.grants = entry.grants.filter((x) => x.group !== g.name);
        entry.grants.push({ group: g.name, level });
      }
    }

    planGroups.push({ name: g.name, group_id: existing?.id ?? null, create: !existing, members, rules });
  }

  // Sorted so that the same project state always gives the same plan.
  const planFolders = [...byFolder.values()].sort((a, b) => a.path.localeCompare(b.path));
  const idOf = new Map(planGroups.map((g) => [g.name, g.group_id]));
  for (const f of planFolders) {
    const now = await getFolderAcl(f.id);
    f.current = now.acl;
    f.inheritance = now.inheritance;
    // A group that still has to be created cannot be on the folder yet.
    f.change =
      f.grants.some((x) => !idOf.get(x.group)) ||
      !sameAcl(now.acl, mergeAssignments(now.acl, f.grants.map((x) => ({ subjectId: groupSubject(idOf.get(x.group)!), level: x.level }))));
    if (f.change) changes++;
  }

  return {
    project_id: projectId,
    project_name: projectName,
    folder_count: folders.length,
    blockers,
    warnings,
    groups: planGroups,
    folders: planFolders,
    invites: [...invites].sort(),
    changes,
  };
}

/**
 * What a check token is bound to: every write the plan implies and every folder
 * ACL it was worked out from. If any of it differs when the apply builds its own
 * plan, the token does not match and nothing is written.
 */
export function planGateInput(plan: Plan): unknown {
  return {
    project: plan.project_id,
    groups: plan.groups.map((g) => [g.name, g.group_id, g.members.map((m) => [m.email.toLowerCase(), m.role, m.action])]),
    folders: plan.folders.map((f) => [f.id, f.grants, PERMISSION_LEVELS.map((l) => subjectsAt(f.current, l)), f.inheritance]),
  };
}

// --- Apply -------------------------------------------------------------------

export interface ApplyGroupResult {
  name: string;
  group_id: string;
  created: boolean;
  invited: string[];
  added: string[];
  errors: string[];
}

export interface ApplyFolderResult {
  path: string;
  /** Written, and read back as written. */
  ok: boolean;
  error?: string;
}

export interface ApplyReport {
  project_id: string;
  project_name: string;
  /** True when every write was made and read back. */
  ok: boolean;
  /** Requests that changed something in Trimble. */
  writes: number;
  groups: ApplyGroupResult[];
  folders: ApplyFolderResult[];
}

/**
 * Carry out a plan. Each step is read back before it counts: a group must be
 * listed, a member must be in the group, a folder must show the permissions
 * that were sent. There is no undo (an invitation cannot be unsent); a run that
 * stops half way is finished by checking and applying again.
 */
export async function executePlan(plan: Plan, presetName: string): Promise<ApplyReport> {
  const projectId = plan.project_id;
  const report: ApplyReport = {
    project_id: projectId,
    project_name: plan.project_name,
    ok: true,
    writes: 0,
    groups: [],
    folders: [],
  };
  const results = new Map<string, ApplyGroupResult>();
  const groupIds = new Map<string, string>(); // preset group name -> Trimble group id

  // 1. Groups. The id comes from listing the groups afterwards, not from the
  //    answer to the create call, so a created group is also a confirmed one.
  for (const g of plan.groups) {
    const r: ApplyGroupResult = { name: g.name, group_id: g.group_id ?? '', created: false, invited: [], added: [], errors: [] };
    results.set(g.name, r);
    report.groups.push(r);
    if (g.group_id) {
      groupIds.set(g.name, g.group_id);
      continue;
    }
    try {
      await trimblePost(core('groups'), { name: g.name, projectId });
      report.writes++;
      r.created = true;
    } catch (e) {
      r.errors.push(`create group: ${errMsg(e)}`);
    }
  }
  if (report.groups.some((r) => r.created)) {
    let listed = new Map<string, string>();
    try {
      listed = new Map((await fetchGroups(projectId)).map((g) => [key(g.name), g.id]));
    } catch (e) {
      for (const r of report.groups) if (r.created) r.errors.push(`list groups after creating: ${errMsg(e)}`);
    }
    for (const r of report.groups) {
      if (!r.created) continue;
      const id = listed.get(key(r.name));
      if (id) {
        r.group_id = id;
        groupIds.set(r.name, id);
      } else if (!r.errors.length) {
        r.errors.push('group is not listed after creating it');
      }
    }
  }

  // 2. Invitations, once per person, then one fresh member list: the answer to
  //    an invitation carries no user id for someone new to Trimble.
  const toInvite = new Map<string, PlanMember>();
  for (const g of plan.groups) {
    if (!groupIds.has(g.name)) continue;
    for (const m of g.members) if (m.action === 'invite' && !toInvite.has(key(m.email))) toInvite.set(key(m.email), m);
  }
  const inviteFailed = new Map<string, string>();
  for (const [email, m] of toInvite) {
    try {
      await trimblePost(`${core(`projects/${encodeURIComponent(projectId)}/users`)}?notify=true`, { email: m.email, role: m.role });
      report.writes++;
    } catch (e) {
      inviteFailed.set(email, errMsg(e));
    }
  }
  let users = new Map<string, CoreUser>();
  let usersError = '';
  if (toInvite.size) {
    try {
      users = await fetchProjectUsers(projectId);
    } catch (e) {
      usersError = errMsg(e);
    }
  }

  // 3. Group members.
  for (const g of plan.groups) {
    const groupId = groupIds.get(g.name);
    const r = results.get(g.name)!;
    if (!groupId) continue;

    const want: { email: string; id: string }[] = [];
    for (const m of g.members) {
      if (m.action === 'in_group' || m.action === 'skipped') continue;
      let id = m.user_id ?? '';
      if (m.action === 'invite') {
        const failed = inviteFailed.get(key(m.email));
        if (failed) {
          r.errors.push(`invite ${m.email}: ${failed}`);
          continue;
        }
        r.invited.push(m.email);
        id = users.get(key(m.email))?.id ?? '';
        if (!id) {
          r.errors.push(
            usersError
              ? `${m.email}: invited, but the member list could not be read (${usersError})`
              : `${m.email}: invited, but not in the member list yet`,
          );
          continue;
        }
      }
      if (!want.some((w) => w.id === id)) want.push({ email: m.email, id });
    }
    if (!want.length) continue;
    try {
      await trimblePost(core(`groups/${encodeURIComponent(groupId)}/users`), want.map((w) => ({ id: w.id })));
      report.writes++;
      const now = await fetchGroupUserIds(groupId);
      for (const w of want) {
        if (now.has(w.id)) r.added.push(w.email);
        else r.errors.push(`${w.email}: not in the group after adding`);
      }
    } catch (e) {
      r.errors.push(`add members: ${errMsg(e)}`);
    }
  }

  // 4. Folder permissions. The PATCH replaces what is on the folder, so the body
  //    is always the ACL read for this plan with the grants merged into it.
  for (const f of plan.folders) {
    if (!f.change) continue;
    const assignments = f.grants
      .filter((x) => groupIds.has(x.group))
      .map((x) => ({ subjectId: groupSubject(groupIds.get(x.group)!), level: x.level }));
    if (!assignments.length) {
      report.folders.push({ path: f.path, ok: false, error: 'none of its groups exist' });
      continue;
    }
    const acl = mergeAssignments(f.current, assignments);
    try {
      // An explicit ACL only takes effect once the folder stops inheriting; keep
      // whatever inheritance flag the folder reports instead of forcing one.
      const body: Record<string, unknown> = { acl };
      if (f.inheritance !== null) body.inheritance = f.inheritance;
      await trimblePatch(core(`folders/fs/${encodeURIComponent(f.id)}/permissions`), body);
      report.writes++;
      const now = await getFolderAcl(f.id);
      const kept = sameAcl(now.acl, acl) && (f.inheritance === null || now.inheritance === f.inheritance);
      report.folders.push(
        kept ? { path: f.path, ok: true } : { path: f.path, ok: false, error: 'permissions read back differ from what was sent' },
      );
    } catch (e) {
      report.folders.push({ path: f.path, ok: false, error: errMsg(e) });
    }
  }

  report.ok = report.groups.every((g) => !g.errors.length) && report.folders.every((f) => f.ok);
  db.recordEvent({
    category: 'trimble',
    level: report.ok ? 'info' : 'warn',
    summary: `Group preset "${presetName}" applied to ${plan.project_name}`,
    detail: `${report.writes} write(s) · ${report.groups.filter((g) => g.created).length} group(s) created · ${report.groups.reduce((n, g) => n + g.added.length, 0)} member(s) added · ${report.folders.filter((f) => f.ok).length} folder ACL(s) set`,
  });
  logger.info(`Group preset "${presetName}" applied to project ${projectId}: ${report.writes} write(s), ok=${report.ok}`);

  return report;
}
