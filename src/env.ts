import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadDotenv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotenv();

function optional(key: string, fallback = ""): string {
  return process.env[key] || fallback;
}

export const env = {
  PORT: parseInt(optional("PORT", "3000"), 10),

  // Produuzit API
  PRODUUZIT_BASE_URL: optional("PRODUUZIT_BASE_URL", "https://back.produuz.it/api/v2"),

  // Service account — priority 1: long-lived refresh token
  PRODUUZIT_REFRESH_TOKEN: optional("PRODUUZIT_REFRESH_TOKEN"),

  // Service account — priority 2: admin credentials + account ID for one-time bootstrap
  PRODUUZIT_ADMIN_USERNAME: optional("PRODUUZIT_ADMIN_USERNAME"),
  PRODUUZIT_ADMIN_PASSWORD: optional("PRODUUZIT_ADMIN_PASSWORD"),
  PRODUUZIT_API_ACCOUNT_ID: optional("PRODUUZIT_API_ACCOUNT_ID"),

  // Trimble Connect OAuth
  TRIMBLE_CLIENT_ID: optional("TRIMBLE_CLIENT_ID"),
  TRIMBLE_CLIENT_SECRET: optional("TRIMBLE_CLIENT_SECRET"),
  TRIMBLE_SCOPE: optional("TRIMBLE_SCOPE", "openid Datatable_extractor"),
  TRIMBLE_AUTHORIZE_URI: optional("TRIMBLE_AUTHORIZE_URI", "https://id.trimble.com/oauth/authorize"),
  TRIMBLE_TOKEN_URI: optional("TRIMBLE_TOKEN_URI", "https://id.trimble.com/oauth/token"),
  TRIMBLE_CALLBACK_URLS: optional("TRIMBLE_CALLBACK_URLS", "http://localhost/api/trimble/auth/callback")
    .split(",").map((u) => u.trim()).filter(Boolean),
};
