import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import { loginWithCredentials, fetchMyUser } from "../produuzit-client.js";
import * as db from "../db.js";
import { isAdmin, getAdminUsernames } from "../settings.js";
import { logger } from "../logger.js";

const app = new Hono();

const COOKIE_NAME = "session_id";
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "Strict" as const,
  path: "/",
  maxAge: 8 * 60 * 60,
};

app.post("/login", async (c) => {
  const body = await c.req.json<{ username: string; password: string }>();
  const username = (body.username ?? "").trim();
  const password = (body.password ?? "").trim();
  if (!username || !password) return c.json({ error: "Username and password required" }, 400);

  // Verify the user is a valid Produuzit account — tokens are discarded after identity check
  let accessToken: string;
  try {
    const tokens = await loginWithCredentials(username, password);
    accessToken = tokens.access;
  } catch {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  let profile: { username: string; email: string };
  try {
    profile = await fetchMyUser(accessToken);
  } catch {
    profile = { username, email: "" };
  }

  const sessionId = randomUUID();
  db.createSession(sessionId, profile.username, profile.email);

  setCookie(c, COOKIE_NAME, sessionId, COOKIE_OPTS);
  return c.json({ ok: true, username: profile.username, email: profile.email });
});

app.post("/logout", (c) => {
  const sessionId = getCookie(c, COOKIE_NAME);
  if (sessionId) db.deleteSession(sessionId);
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.json({ ok: true });
});

app.get("/status", (c) => {
  const sessionId = getCookie(c, COOKIE_NAME);
  if (!sessionId) return c.json({ authenticated: false }, 401);
  const session = db.getSession(sessionId);
  if (!session) return c.json({ authenticated: false }, 401);
  const admin = isAdmin(session.username);
  logger.debug(
    `[auth] status username="${session.username}" isAdmin=${admin} ` +
    `admins=[${getAdminUsernames().join(",")}]`,
  );
  return c.json({
    authenticated: true,
    username: session.username,
    email: session.email,
    isAdmin: admin,
  });
});

export default app;
