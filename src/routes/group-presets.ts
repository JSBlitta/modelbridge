// Admin-only API for group presets. Mounted under /api/admin/group-presets,
// so the parent admin app's requireAdmin already guards every route here.

import { Hono } from 'hono';
import { z } from 'zod';
import * as db from '../db.ts';
import type { GroupPreset, GroupPresetInput } from '../db.ts';
import { buildPlan, executePlan, fetchFolderTree, planGateInput } from '../group-presets.ts';
import type { PermissionLevel } from '../lib/group-preset-rules.ts';
import { GATE, issuePreviewToken, requirePreviewToken } from '../lib/push-gate.ts';
import { runAsUser } from '../trimble-client.ts';

const app = new Hono();

// Trimble calls below use the admin's own connection. routes/trimble.ts does the
// same for its router; this one is mounted elsewhere, so it has to do it itself.
app.use('/*', (c, next) => runAsUser(c.get('session').username, next));

const level = z.enum(['READ', 'FULL_ACCESS', 'NO_ACCESS']);

const memberSchema = z.object({
  email: z.string().min(1),
  auto_invite: z.boolean().nullish(),
  role: z.enum(['USER', 'ADMIN']).optional(),
});

const ruleSchema = z.object({
  match_type: z.enum(['PATH', 'REGEX']).optional(),
  pattern: z.string().min(1),
  level: level.nullish(),
});

const groupSchema = z.object({
  name: z.string().min(1),
  members: z.array(memberSchema).optional(),
  rules: z.array(ruleSchema).optional(),
});

const presetSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    default_permission: level.optional(),
    apply_permissions_default: z.boolean().optional(),
    auto_invite_default: z.boolean().optional(),
    groups: z.array(groupSchema).optional(),
  })
  // Groups are found in Trimble by name. Two with one name would be created
  // twice on the first apply and reused as one on the next.
  .refine(
    (p) => {
      const names = (p.groups ?? []).map((g) => g.name.trim().toLowerCase());
      return new Set(names).size === names.length;
    },
    { message: 'Group names must be unique within a preset' },
  );

const runSchema = z.object({
  project_id: z.string().min(1),
  preset_id: z.number().int().positive().optional(),
  preset: presetSchema.optional(),
  apply_permissions: z.boolean().optional(),
  auto_invite: z.boolean().optional(),
  preview_token: z.string().optional(),
});

/** A zod error as one line instead of its JSON dump. */
function msg(e: unknown): string {
  if (e instanceof z.ZodError) return e.issues.map((i) => [i.path.join('.'), i.message].filter(Boolean).join(': ')).join('; ');
  return e instanceof Error ? e.message : String(e);
}

function parsePreset(body: unknown): GroupPresetInput {
  return presetSchema.parse(body) as GroupPresetInput;
}

/** Build a GroupPreset from an inline body when no preset_id is given. */
function presetFromRun(body: z.infer<typeof runSchema>): GroupPreset | null {
  if (body.preset_id) return db.getGroupPreset(body.preset_id);
  if (!body.preset) return null;
  const p = body.preset;
  return {
    id: 0,
    name: p.name,
    description: p.description ?? '',
    default_permission: (p.default_permission ?? 'READ') as PermissionLevel,
    apply_permissions_default: p.apply_permissions_default !== false,
    auto_invite_default: p.auto_invite_default !== false,
    groups: (p.groups ?? []).map((g) => ({
      name: g.name,
      members: (g.members ?? []).map((m) => ({
        email: m.email,
        auto_invite: m.auto_invite ?? null,
        role: m.role === 'ADMIN' ? 'ADMIN' : 'USER',
      })),
      rules: (g.rules ?? []).map((r) => ({
        match_type: r.match_type === 'REGEX' ? 'REGEX' : 'PATH',
        pattern: r.pattern,
        level: (r.level ?? null) as PermissionLevel | null,
      })),
    })),
  };
}

// --- Preset CRUD ---

app.get('/', (c) => c.json(db.listGroupPresets()));

app.post('/', async (c) => {
  try {
    const input = parsePreset(await c.req.json());
    const id = db.createGroupPreset(input);
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ error: msg(e) }, 400);
  }
});

app.put('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (!db.getGroupPreset(id)) return c.json({ error: 'Not found' }, 404);
  try {
    const input = parsePreset(await c.req.json());
    db.updateGroupPreset(id, input);
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ error: msg(e) }, 400);
  }
});

app.delete('/:id', (c) => {
  db.deleteGroupPreset(parseInt(c.req.param('id'), 10));
  return c.json({ ok: true });
});

// --- Project helpers (for the apply panel) ---

app.get('/projects', (c) => {
  return c.json(db.getTrimbleProjects().map((p) => ({ project_id: p.project_id, name: p.name })));
});

app.get('/projects/:projectId/folders', async (c) => {
  try {
    return c.json(await fetchFolderTree(c.req.param('projectId')));
  } catch (e) {
    return c.json({ error: msg(e) }, 502);
  }
});

// --- Check & apply ---
//
// Same contract as the Produuzit pushes (lib/push-gate.ts): the check hands out
// a single-use token, the apply refuses to run without it. Here the token is
// bound to the plan itself, so it also stops an apply when the project changed
// in Trimble after the check.

async function planFor(body: z.infer<typeof runSchema>, preset: GroupPreset) {
  return buildPlan(body.project_id, preset, {
    applyPermissions: body.apply_permissions ?? preset.apply_permissions_default,
    autoInvite: body.auto_invite ?? preset.auto_invite_default,
  });
}

app.post('/preview', async (c) => {
  let body: z.infer<typeof runSchema>;
  try {
    body = runSchema.parse(await c.req.json());
  } catch (e) {
    return c.json({ error: msg(e) }, 400);
  }
  const preset = presetFromRun(body);
  if (!preset) return c.json({ error: 'Unknown preset' }, 404);
  try {
    const plan = await planFor(body, preset);
    // No token while something blocks: the apply cannot be reached.
    const preview_token = plan.blockers.length
      ? undefined
      : issuePreviewToken(GATE.groupPresetApply, planGateInput(plan));
    return c.json({ ...plan, preview_token });
  } catch (e) {
    return c.json({ error: msg(e) }, 502);
  }
});

app.post('/apply', async (c) => {
  let body: z.infer<typeof runSchema>;
  try {
    body = runSchema.parse(await c.req.json());
  } catch (e) {
    return c.json({ error: msg(e) }, 400);
  }
  const preset = presetFromRun(body);
  if (!preset) return c.json({ error: 'Unknown preset' }, 404);
  try {
    // Reads only up to here; the first write happens in executePlan.
    const plan = await planFor(body, preset);
    if (plan.blockers.length) {
      return c.json({ error: 'The check found problems. Resolve them and run the check again.', code: 'PREVIEW_REQUIRED' }, 409);
    }
    const blocked = requirePreviewToken(c, GATE.groupPresetApply, body.preview_token, planGateInput(plan));
    if (blocked) return blocked;
    return c.json(await executePlan(plan, preset.name));
  } catch (e) {
    return c.json({ error: msg(e) }, 502);
  }
});

export default app;
