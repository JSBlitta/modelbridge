// Admin-only API for group presets. Mounted under /api/admin/group-presets,
// so the parent admin app's requireAdmin already guards every route here.

import { Hono } from 'hono';
import { z } from 'zod';
import * as db from '../db.ts';
import type { GroupPreset, GroupPresetInput } from '../db.ts';
import { applyPreset, fetchFolderTree, previewPreset } from '../group-presets.ts';
import type { PermissionLevel } from '../lib/group-preset-rules.ts';
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

const presetSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  default_permission: level.optional(),
  apply_permissions_default: z.boolean().optional(),
  auto_invite_default: z.boolean().optional(),
  groups: z.array(groupSchema).optional(),
});

const runSchema = z.object({
  project_id: z.string().min(1),
  preset_id: z.number().int().positive().optional(),
  preset: presetSchema.optional(),
  apply_permissions: z.boolean().optional(),
  auto_invite: z.boolean().optional(),
  replace_acl: z.boolean().optional(),
});

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
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
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
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
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
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

// --- Preview & apply ---

app.post('/preview', async (c) => {
  let body: z.infer<typeof runSchema>;
  try {
    body = runSchema.parse(await c.req.json());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  const preset = presetFromRun(body);
  if (!preset) return c.json({ error: 'Unknown preset' }, 404);
  try {
    const resolution = await previewPreset(body.project_id, preset, {
      applyPermissions: body.apply_permissions ?? preset.apply_permissions_default,
      autoInvite: body.auto_invite ?? preset.auto_invite_default,
    });
    return c.json(resolution);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

app.post('/apply', async (c) => {
  let body: z.infer<typeof runSchema>;
  try {
    body = runSchema.parse(await c.req.json());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  const preset = presetFromRun(body);
  if (!preset) return c.json({ error: 'Unknown preset' }, 404);
  try {
    const report = await applyPreset(body.project_id, preset, {
      applyPermissions: body.apply_permissions ?? preset.apply_permissions_default,
      autoInvite: body.auto_invite ?? preset.auto_invite_default,
      replaceAcl: body.replace_acl ?? false,
    });
    return c.json(report);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

export default app;
