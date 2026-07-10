import { Hono } from "hono";
import { env } from "../env.js";

const app = new Hono();

app.get("/", (c) => c.json({ status: "ok" }));

// Config check — masks secrets, confirms what URLs the backend is actually using
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
        ? `configured (***${env.PRODUUZIT_REFRESH_TOKEN.slice(-6)})`
        : env.PRODUUZIT_ADMIN_USERNAME
        ? `bootstrap mode (admin: ${env.PRODUUZIT_ADMIN_USERNAME})`
        : "NOT CONFIGURED",
    trimble_client_id: env.TRIMBLE_CLIENT_ID ? `configured (***${env.TRIMBLE_CLIENT_ID.slice(-4)})` : "not configured",
    port: env.PORT,
  });
});

export default app;
