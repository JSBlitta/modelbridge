import { Hono } from "hono";
import * as db from "../db.js";
import { getRedactedSettings, saveSettings } from "../settings.js";
import { requireAdmin } from "../middleware/session.js";

// Admin-only API. The session cookie identifies the user; an admin is a session
// whose username is in the `admin_usernames` setting. Everything else in the
// repo is open to any logged-in user.

const app = new Hono();

// requireSession has already run app-wide; this only adds the admin check.
app.use("*", requireAdmin);

// --- Settings ---

// Secrets come back redacted — the reporting refresh token used to be returned in full.
app.get("/settings", (c) => c.json(getRedactedSettings()));

app.put("/settings", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  saveSettings(body);
  return c.json({ ok: true, settings: getRedactedSettings() });
});

// --- Reporting schedule (replaces the SharePoint list CSV) ---

app.get("/schedule", (c) => c.json(db.listReportingSchedule()));

app.post("/schedule", async (c) => {
  const body = await c.req.json<{
    endpoint: string;
    active?: boolean;
    frequency?: string;
    weekdays?: string[];
    day_of_month?: number | null;
    conditions?: string;
    storage_path?: string;
    overwrite?: boolean;
    position?: number;
  }>();
  if (!body.endpoint) return c.json({ error: "Missing endpoint" }, 400);
  const id = db.upsertReportingSchedule({
    endpoint: body.endpoint,
    active: body.active ?? true,
    frequency: body.frequency ?? "Dagelijks",
    weekdays: body.weekdays ?? [],
    day_of_month: body.day_of_month ?? null,
    conditions: body.conditions ?? "",
    storage_path: body.storage_path ?? "",
    overwrite: body.overwrite ?? false,
    position: body.position,
  });
  return c.json({ ok: true, id });
});

app.patch("/schedule/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json<Record<string, unknown>>();
  const existing = db.listReportingSchedule().find((r) => r.id === id);
  if (!existing) return c.json({ error: "Not found" }, 404);
  db.upsertReportingSchedule({
    id,
    endpoint: (body.endpoint as string) ?? existing.endpoint,
    active: (body.active as boolean) ?? Boolean(existing.active),
    frequency: (body.frequency as string) ?? existing.frequency,
    weekdays: (body.weekdays as string[]) ?? JSON.parse(existing.weekdays || "[]"),
    day_of_month: "day_of_month" in body ? (body.day_of_month as number | null) : existing.day_of_month,
    conditions: (body.conditions as string) ?? existing.conditions,
    storage_path: (body.storage_path as string) ?? existing.storage_path,
    overwrite: (body.overwrite as boolean) ?? Boolean(existing.overwrite),
    position: (body.position as number) ?? existing.position,
  });
  return c.json({ ok: true, id });
});

app.delete("/schedule/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  db.deleteReportingSchedule(id);
  return c.json({ ok: true });
});

export default app;
