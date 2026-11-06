// Shared Produuzit project-topology loaders used by the assembly import and
// the Trimble import. Both flows need the project's designs and batches and
// match batches by their printed number.

import { fetchAllPages } from "../produuzit-client.ts";

// Design name -> uuid. `fuzzy` additionally indexes the dash/underscore-swapped
// variant so A20-EL020 and A20_EL020 resolve to the same design.
export async function loadDesigns(
  projectUuid: string,
  opts?: { fuzzy?: boolean },
): Promise<Map<string, string>> {
  const all = (await fetchAllPages("/constructibles/assembly_designs/", { project: projectUuid })) as Record<string, unknown>[];
  const m = new Map<string, string>();
  for (const d of all) {
    const name = d.name as string;
    m.set(name, d.uuid as string);
    if (opts?.fuzzy) {
      const alt = normalizeDesignName(name);
      if (alt !== name) m.set(alt, d.uuid as string);
    }
  }
  return m;
}

export async function loadBatches(projectUuid: string): Promise<Record<string, unknown>[]> {
  return (await fetchAllPages("/constructibles/batches/", { project: projectUuid })) as Record<string, unknown>[];
}

// Normalize only the 4th character: swap dash/underscore at position 3 (0-indexed).
// This allows A20-EL020 to match A20_EL020, but only at position 3.
export function normalizeDesignName(name: string): string {
  if (name.length < 4) return name;
  const chars = name.split('');
  if (chars[3] === '-') { chars[3] = '_'; return chars.join(''); }
  if (chars[3] === '_') { chars[3] = '-'; return chars.join(''); }
  return name;
}

export function fuzzyDesignLookup(designsMap: Map<string, string>, name: string): string | null {
  const exact = designsMap.get(name);
  if (exact) return exact;
  const alt = normalizeDesignName(name);
  if (alt !== name) return designsMap.get(alt) ?? null;
  return null;
}

// Pre-index batches once so a per-row lookup is O(1) instead of scanning the
// whole list (and re-normalizing every name) for every row. Exact match on the
// batch name; when a phase is supplied the match is also scoped to that phase,
// tying the batch number definitively to the phase it belongs to. First match
// wins.
export function buildBatchMatcher(batches: Record<string, unknown>[]) {
  const byName = new Map<string, Record<string, unknown>>();
  const byNamePhase = new Map<string, Record<string, unknown>>();
  for (const b of batches) {
    const name = String(b.name ?? "").trim().toLowerCase();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, b);
    const phase = String(b.phase ?? "").trim().toLowerCase();
    const key = `${name}\u0000${phase}`;
    if (!byNamePhase.has(key)) byNamePhase.set(key, b);
  }

  return (batchRaw: string, phase = ""): Record<string, unknown> | null => {
    const raw = String(batchRaw ?? "").trim().toLowerCase();
    if (!raw) return null;
    const phaseNorm = String(phase ?? "").trim().toLowerCase();
    if (!phaseNorm) return byName.get(raw) ?? null;
    return byNamePhase.get(`${raw}\u0000${phaseNorm}`) ?? null;
  };
}

// A project under a superproject is named <5 digits>-<category letter>[-<rest>].
// Those first 7 characters identify it: 12654-A resolves to 12654-A-NorthEast Wing.
// The letter must end the token, so 12654-AB is not 12654-A.
export function projectPrefix(name: unknown): string | null {
  const m = /^(\d{5}-[A-Za-z])(?![A-Za-z0-9])/.exec(String(name ?? "").trim());
  return m ? m[1].toUpperCase() : null;
}

export type ProjectMatch =
  | { project: Record<string, unknown> }
  | { ambiguous: string[] }
  | null;

// Exact name (or project_number) first; then the 7-character prefix. Two existing
// projects sharing a prefix resolve to neither: the caller must not guess, and
// must not create a third.
export function buildProjectMatcher(projects: Record<string, unknown>[]) {
  const exact = new Map<string, Record<string, unknown>>();
  const byPrefix = new Map<string, Record<string, unknown>[]>();
  for (const p of projects) {
    const name = String(p.name ?? "").trim();
    const pnum = String(p.project_number ?? "").trim();
    if (name && !exact.has(name)) exact.set(name, p);
    if (pnum && !exact.has(pnum)) exact.set(pnum, p);
    const pre = projectPrefix(name);
    if (pre) byPrefix.set(pre, [...(byPrefix.get(pre) ?? []), p]);
  }
  return (...keys: unknown[]): ProjectMatch => {
    for (const k of keys) {
      const hit = exact.get(String(k ?? "").trim());
      if (hit) return { project: hit };
    }
    for (const k of keys) {
      const pre = projectPrefix(k);
      const hits = pre ? byPrefix.get(pre) ?? [] : [];
      if (hits.length === 1) return { project: hits[0] };
      if (hits.length > 1) return { ambiguous: hits.map((h) => String(h.name ?? h.uuid)) };
    }
    return null;
  };
}
