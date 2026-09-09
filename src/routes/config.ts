import { Hono } from "hono";
import * as db from "../db.js";
import { getConfig } from "../config.js";

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

export default app;
