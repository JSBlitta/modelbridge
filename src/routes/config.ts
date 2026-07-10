import { Hono } from "hono";
import * as db from "../db.js";

const app = new Hono();

// Column mapping presets (stored in local SQLite, not config.yaml)
app.get("/presets", (c) => c.json(db.getPresets()));

app.post("/presets", async (c) => {
  const body = await c.req.json<{ name: string; mapping: Record<string, string> }>();
  if (!body.name) return c.json({ error: "Missing name" }, 400);
  db.savePreset(body.name, body.mapping);
  return c.json({ status: "saved", name: body.name });
});

export default app;
