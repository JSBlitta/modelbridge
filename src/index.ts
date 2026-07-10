import "./env.js";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { env } from "./env.js";
import { loadConfig } from "./config.js";
import { initDb, pruneExpiredSessions } from "./db.js";

import health from "./routes/health.js";
import auth from "./routes/auth.js";
import projects from "./routes/projects.js";
import batches from "./routes/batches.js";
import assemblies from "./routes/assemblies.js";
import cloudstorage from "./routes/cloudstorage.js";
import csv from "./routes/csv.js";
import trimble from "./routes/trimble.js";
import config from "./routes/config.js";

const app = new Hono();

// Strip trailing slashes from API routes so /api/projects/ matches /api/projects
app.use("/api/*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname.endsWith("/") && url.pathname !== "/api/") {
    url.pathname = url.pathname.replace(/\/+$/, "");
    return c.redirect(url.toString(), 308);
  }
  await next();
});

// Public routes — no session gate; Produuzit API calls use the company service token
app.route("/api/health", health);
app.route("/api/auth", auth);
app.route("/api/projects", projects);
app.route("/api/batches", batches);
app.route("/api/assemblies", assemblies);
app.route("/api/cloudstorage", cloudstorage);
app.route("/api/csv", csv);
app.route("/api/trimble", trimble);
app.route("/api/config", config);

app.onError((err, c) => {
  console.error(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path}:`, err.message);
  if (err.message.includes("No active session") || err.message.includes("service token")) {
    return c.json({ error: err.message, code: "UNAUTHENTICATED" }, 401);
  }
  return c.json({ error: err.constructor.name, detail: err.message }, 500);
});

// Serve static frontend assets (JS, CSS, images)
app.get("/assets/*", serveStatic({ root: "./frontend-dist" }));
// SPA fallback — serve index.html for any non-API, non-asset route
app.get("/*", serveStatic({ root: "./frontend-dist", path: "index.html" }));

loadConfig();
initDb();
pruneExpiredSessions();
setInterval(pruneExpiredSessions, 60 * 60 * 1000);

console.log(`API Coupler starting on port ${env.PORT}`);
console.log(`  Produuzit: ${env.PRODUUZIT_BASE_URL}`);
if (env.PRODUUZIT_REFRESH_TOKEN) {
  console.log(`  Service token: configured via PRODUUZIT_REFRESH_TOKEN`);
} else if (env.PRODUUZIT_ADMIN_USERNAME) {
  console.log(`  Service token: will bootstrap from admin credentials on first API call`);
} else {
  console.log(`  ⚠ No service token configured — set PRODUUZIT_REFRESH_TOKEN in .env`);
}

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API Coupler listening on http://localhost:${info.port}`);
});
