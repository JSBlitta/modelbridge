import { Hono } from "hono";
import * as db from "../db.ts";
import { getConfig } from "../config.ts";
import { getSettings, saveSettings } from "../settings.ts";

const app = new Hono();

// Column mapping presets (stored in local SQLite, not config.yaml)
app.get("/presets", (c) => c.json(db.getPresets()));

// Column/property synonyms from config.yaml — used by the frontend to
// auto-map Trimble IFC properties (and CSV columns) to Produuzit fields.
app.get("/synonyms", (c) => c.json(getConfig().synonyms));

app.post("/presets", async (c) => {
  const body = await c.req.json<{ name: string; mapping: Record<string, string> }>();
  if (!body.name) return c.json({ error: "Missing name" }, 400);
  db.savePreset(body.name, body.mapping);
  return c.json({ status: "saved", name: body.name });
});

// The entity text filter for the Trimble import ('CalculatedGeometryValues'
// keeps only geometry-carrying entities; empty = no filter). Persisted in the
// settings table; a per-request entity_text_filter still overrides it.
app.get("/trimble-entity-filter", (c) =>
  c.json({ value: String(getSettings().trimble_entity_text_filter ?? "") }),
);

app.put("/trimble-entity-filter", async (c) => {
  const body = await c.req.json<{ value?: string }>();
  saveSettings({ trimble_entity_text_filter: String(body.value ?? "").trim() });
  return c.json({ ok: true, value: String(getSettings().trimble_entity_text_filter ?? "") });
});

export default app;
