// Pure, side-effect-free helpers for the admin "group presets" feature.
//
// A preset describes Trimble user groups (name + members) and folder
// permission rules. The same preset must work across projects whose folder
// structures differ, so rules target folders via:
//   - literal paths (optionally with $TOKENS like $COMPANY_NAME), and/or
//   - regular expressions matched against the full folder path.
// Everything here is kept free of I/O so it can be unit-tested without a
// Trimble connection.

export type PermissionLevel = 'READ' | 'FULL_ACCESS' | 'NO_ACCESS';
export type MatchType = 'PATH' | 'REGEX';

export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['READ', 'FULL_ACCESS', 'NO_ACCESS'];

/** The Trimble Core API pseudo-subject that means "every project member". */
export const ALL_MEMBERS_SUBJECT = 'tc-groups:*';

export interface FolderRef {
  id: string;
  name: string;
  /** Full path from the project root, '/'-separated (root name excluded). */
  path: string;
}

export interface PresetRule {
  match_type: MatchType;
  pattern: string;
  level?: PermissionLevel | null;
}

export interface Assignment {
  subjectId: string;
  level: PermissionLevel;
}

export type Acl = Partial<Record<PermissionLevel, string[]>>;

// Trimble's own vocabulary is only READ / FULL_ACCESS / NO_ACCESS, but accept
// the spellings other tooling uses so a hand-written preset cannot silently
// produce an empty ACL.
const LEVEL_ALIASES: Record<string, PermissionLevel> = {
  VIEW: 'READ',
  READ_ONLY: 'READ',
  EDIT: 'FULL_ACCESS',
  WRITE: 'FULL_ACCESS',
  FULL: 'FULL_ACCESS',
};

export function normalizeLevel(value: unknown): PermissionLevel {
  const key = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '_');
  const mapped = (LEVEL_ALIASES[key] ?? key) as PermissionLevel;
  if (!PERMISSION_LEVELS.includes(mapped)) {
    throw new Error(`Unknown permission level: ${String(value)} (use ${PERMISSION_LEVELS.join(', ')})`);
  }
  return mapped;
}

/** Expand $TOKEN and ${TOKEN} placeholders. Unknown tokens are left as-is. */
export function expandTokens(pattern: string, vars: Record<string, string>): string {
  return String(pattern ?? '').replace(/\$\{?([A-Z_]+)\}?/g, (match, name: string) => {
    const value = vars[name];
    return value !== undefined ? value : match;
  });
}

/**
 * Normalise an ACL object coming from Trimble to `{LEVEL: [subjectId, ...]}`.
 * Unknown levels are dropped and duplicate subjects de-duplicated. Accepts
 * both Trimble's return shape and a hand-authored preset.
 */
export function normalizeAcl(input: unknown): Acl {
  const out: Acl = {};
  if (!input || typeof input !== 'object') return out;
  for (const [level, subjects] of Object.entries(input as Record<string, unknown>)) {
    let key: PermissionLevel;
    try {
      key = normalizeLevel(level);
    } catch {
      continue;
    }
    if (!Array.isArray(subjects)) continue;
    const list = out[key] ?? (out[key] = []);
    for (const s of subjects) {
      const id = String(s ?? '').trim();
      if (id && !list.includes(id)) list.push(id);
    }
  }
  return pruneEmpty(out);
}

/** Build an ACL from scratch: later assignments win, one level per subject. */
export function aclFromAssignments(assignments: Assignment[]): Acl {
  const out: Acl = {};
  for (const { subjectId, level } of assignments) {
    const id = String(subjectId ?? '').trim();
    if (!id) continue;
    moveSubject(out, id, level);
  }
  return pruneEmpty(out);
}

/** Merge assignments into an existing ACL, leaving untouched subjects as-is. */
export function mergeAssignments(current: Acl, assignments: Assignment[]): Acl {
  const out = normalizeAcl(current);
  for (const { subjectId, level } of assignments) {
    const id = String(subjectId ?? '').trim();
    if (!id) continue;
    moveSubject(out, id, level);
  }
  return pruneEmpty(out);
}

function moveSubject(acl: Acl, id: string, level: PermissionLevel): void {
  for (const lvl of PERMISSION_LEVELS) {
    const list = acl[lvl];
    if (list) acl[lvl] = list.filter((x) => x !== id);
  }
  const target = acl[level] ?? (acl[level] = []);
  if (!target.includes(id)) target.push(id);
}

function pruneEmpty(acl: Acl): Acl {
  const out: Acl = {};
  for (const lvl of PERMISSION_LEVELS) {
    const list = acl[lvl]?.filter(Boolean);
    if (list && list.length) out[lvl] = list;
  }
  return out;
}

export interface FolderMatch {
  matched: FolderRef[];
  /** For literal PATH selectors with no wildcard: the path that was not found. */
  missing?: string;
  /** Set when a REGEX selector failed to compile. */
  invalid?: string;
}

/**
 * Resolve a rule against a project's folder tree.
 *
 * PATH: exact match by default; `*` matches one path segment and `**` matches
 * across segments (e.g. `$COMPANY_NAME/*`, `01-WIP/**`).
 * REGEX: JavaScript regular expression (case-insensitive) tested against the
 * full folder path.
 */
export function matchFolders(
  rule: PresetRule,
  folders: FolderRef[],
  vars: Record<string, string>,
): FolderMatch {
  const expanded = expandTokens(String(rule.pattern ?? '').trim(), vars);
  if (!expanded) return { matched: [], missing: '' };

  if (rule.match_type === 'REGEX') {
    let re: RegExp;
    try {
      re = new RegExp(expanded, 'i');
    } catch (e) {
      return { matched: [], invalid: (e as Error).message };
    }
    return { matched: folders.filter((f) => re.test(f.path)) };
  }

  const norm = expanded.replace(/^\/+|\/+$/g, '');
  if (!/[*?]/.test(norm)) {
    const want = norm.toLowerCase();
    const hit = folders.filter((f) => f.path.toLowerCase() === want);
    return { matched: hit, missing: hit.length ? undefined : norm };
  }
  const re = globToRegExp(norm);
  return { matched: folders.filter((f) => re.test(f.path)) };
}

function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
    }
  }
  return new RegExp(out + '$', 'i');
}
