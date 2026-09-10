import { Hono } from "hono";
import { env } from "../env.js";

const app = new Hono();

// The only unauthenticated endpoint in the app. Deliberately says nothing else.
app.get("/", (c) => c.json({ status: "ok" }));

// Config check. Session-gated by the app-wide middleware (only the exact path
// "/api/health" is public), because even the masked form names the bootstrap
// admin account and the upstream URLs.
app.get("/config", async (c) => {
  const produuzitReachable = await fetch(`${env.PRODUUZIT_BASE_URL}/my_user/`, {
    signal: AbortSignal.timeout(4000),
  })
    .then((r) => (r.status === 401 ? "reachable (401 = no token, expected)" : `reachable (${r.status})`))
    .catch((e) => `unreachable: ${String(e)}`);

  return c.json({
    produuzit_base_url: env.PRODUUZIT_BASE_URL,
    produuzit_reachable: produuzitReachable,
    service_token:
      env.PRODUUZIT_REFRESH_TOKEN
        ? "configured"
        : env.PRODUUZIT_ADMIN_USERNAME
        ? "bootstrap mode"
        : "NOT CONFIGURED",
    trimble_client_id: env.TRIMBLE_CLIENT_ID ? "configured" : "not configured",
    port: env.PORT,
  });
});

export default app;
