import { Hono } from "hono";
import * as db from "../db.ts";
import { boundedInt } from "../lib/validate.ts";

// Read-only access to the persistent action log (events table).
// The frontend notification bell hydrates from this on load.
const app = new Hono();

app.get("/", (c) => {
  const limit = boundedInt(c.req.query("limit"), 100, 1, 1000);
  const category = c.req.query("category") || undefined;
  const level = c.req.query("level") || undefined;
  return c.json({ events: db.listEvents({ limit, category, level }) });
});

app.delete("/", (c) => {
  const category = c.req.query("category") || undefined;
  db.clearEvents(category);
  return c.json({ ok: true });
});

export default app;
