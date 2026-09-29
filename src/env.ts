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

const produuzitBaseUrl = optional("PRODUUZIT_BASE_URL", "https://back.produuz.it/api/v2");

export const env = {
  PORT: parseInt(optional("PORT", "3000"), 10),

  // Produuzit API
  PRODUUZIT_BASE_URL: produuzitBaseUrl,

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

  // Server-side free-text filter for model entities (entity class, product
  // name, pset names/values). 'CalculatedGeometryValues' keeps only entities
  // that carry geometry — the fallback for models polluted with geometry-less
  // catalog/type entities. Default: off (schematic models need no filter).
  // A per-request entity_text_filter overrides this.
  TRIMBLE_ENTITY_TEXT_FILTER: optional("TRIMBLE_ENTITY_TEXT_FILTER"),

  // Logging: error | warn | info | debug (default: info)
  LOG_LEVEL: optional("LOG_LEVEL", "info"),
  // Optional log file — when set, all log lines are also appended here
  LOG_FILE: optional("LOG_FILE", ""),

  // Admin usernames (comma-separated). These users see the admin page and can
  // configure ModelBridge. Everyone else who can log in is a default user.
  ADMIN_USERNAMES: optional("ADMIN_USERNAMES", ""),

  // Reporting scheduler — TypeScript replacement for the ProduuzitAPI
  // Power Automate solution. Uses a SEPARATE Produuzit API account.
  REPORTING_ENABLED: optional("REPORTING_ENABLED", "false") === "true",
  REPORTING_REFRESH_TOKEN: optional("REPORTING_REFRESH_TOKEN"),
  REPORTING_BASE_URL: optional("REPORTING_BASE_URL") || produuzitBaseUrl,
  REPORTING_TIME: optional("REPORTING_TIME", "18:15"),
  REPORTING_TIMEZONE: optional("REPORTING_TIMEZONE", "Europe/Amsterdam"),
  REPORTING_CONFIG_CSV: optional("REPORTING_CONFIG_CSV", "data/produuzit_api_frequentie.csv"),
  REPORTING_OUTPUT_DIR: optional("REPORTING_OUTPUT_DIR", "data/reporting"),
  REPORTING_LAST_RUN_FILE: optional("REPORTING_LAST_RUN_FILE", "data/reporting_last_run.json"),
  REPORTING_PAGE_SIZE: parseInt(optional("REPORTING_PAGE_SIZE", "1000"), 10),
  REPORTING_MAX_PAGES: parseInt(optional("REPORTING_MAX_PAGES", "60"), 10),

  // SharePoint (reporting output). When all four connection vars are set, the
  // reporting module writes its JSON snapshots to SharePoint instead of the
  // local output dir (see REPORTING.md for the Azure AD app registration).
  SHAREPOINT_SITE_URL: optional("SHAREPOINT_SITE_URL"),
  SHAREPOINT_TENANT_ID: optional("SHAREPOINT_TENANT_ID"),
  SHAREPOINT_CLIENT_ID: optional("SHAREPOINT_CLIENT_ID"),
  SHAREPOINT_CLIENT_SECRET: optional("SHAREPOINT_CLIENT_SECRET"),
  SHAREPOINT_BASE_FOLDER: optional("SHAREPOINT_BASE_FOLDER", "Shared Documents/API data"),
};
