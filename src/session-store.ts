import { AsyncLocalStorage } from "node:async_hooks";

// Session only carries identity — API calls use the company service token, not per-user tokens
export interface SessionContext {
  sessionId: string;
  username: string;
  email: string;
}

export const sessionStore = new AsyncLocalStorage<SessionContext>();

export function currentSession(): SessionContext {
  const s = sessionStore.getStore();
  if (!s) throw new Error("No active session — user must log in");
  return s;
}
