import "./env.js";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { env } from "./env.ts";
import { loadConfig } from "./config.ts";
import { initLogger, logger } from "./logger.ts";
import { initDb, pruneExpiredSessions, pruneExpiredPreviewTokens } from "./db.ts";
import { requireSession } from "./middleware/session.ts";

import health from "./routes/health.ts";
import auth from "./routes/auth.ts";
import projects from "./routes/projects.ts";
import batches from "./routes/batches.ts";
import assemblies from "./routes/assemblies.ts";
import cloudstorage from "./routes/cloudstorage.ts";
import csv from "./routes/csv.ts";
import trimble from "./routes/trimble.ts";
import config from "./routes/config.ts";
import history from "./routes/history.ts";
import admin from "./routes/admin.ts";
import { startReportingScheduler } from "./reporting/runner.ts";
import { getReportingSettings } from "./settings.ts";
import { isSharePointConfigured } from "./sharepoint-client.ts";

const app = new Hono();

// Every /api route is session-gated. The middleware exempts only the handful of
// paths that must work before a session exists (see middleware/session.ts).
app.use("/api/*", requireSession);

app.route("/api/health", health);
app.route("/api/auth", auth);
app.route("/api/projects", projects);
app.route("/api/batches", batches);
app.route("/api/assemblies", assemblies);
app.route("/api/cloudstorage", cloudstorage);
app.route("/api/csv", csv);
app.route("/api/trimble", trimble);
app.route("/api/config", config);
app.route("/api/history", history);
app.route("/api/admin", admin);

app.onError((err, c) => {
  logger.error(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path}:`, err.message);
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
initLogger(env.LOG_LEVEL, env.LOG_FILE);
initDb();
pruneExpiredSessions();
setInterval(pruneExpiredSessions, 60 * 60 * 1000);
pruneExpiredPreviewTokens();
setInterval(pruneExpiredPreviewTokens, 15 * 60 * 1000);

logger.info(`ModelBridge starting on port ${env.PORT}`);
logger.info(`  Produuzit: ${env.PRODUUZIT_BASE_URL}`);
if (env.PRODUUZIT_REFRESH_TOKEN) {
  logger.info(`  Service token: configured via PRODUUZIT_REFRESH_TOKEN`);
} else if (env.PRODUUZIT_ADMIN_USERNAME) {
  logger.info(`  Service token: will bootstrap from admin credentials on first API call`);
} else {
  logger.warn(`  No service token configured — set PRODUUZIT_REFRESH_TOKEN in .env`);
}

// Reporting scheduler (replaces the ProduuzitAPI Power Automate solution).
// Always armed — the tick checks the `reporting_enabled` setting so it can be
// toggled from the admin page without a restart.
startReportingScheduler();
const reportingCfg = getReportingSettings();
logger.info(`  Reporting scheduler: ${reportingCfg.enabled ? `daily at ${reportingCfg.time} (${reportingCfg.timezone})` : "disabled"}`);
if (reportingCfg.enabled && !reportingCfg.refreshToken) {
  logger.warn(`  Reporting: no refresh token configured — set REPORTING_REFRESH_TOKEN or the admin page`);
}
if (isSharePointConfigured()) {
  logger.info(`  Reporting output: SharePoint (${env.SHAREPOINT_SITE_URL})`);
} else {
  logger.info(`  Reporting output: local (${reportingCfg.outputDir})`);
}

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info(`ModelBridge listening on http://localhost:${info.port}`);
});
