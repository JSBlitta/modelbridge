// Central settings store — the single source of truth for admin-editable
// configuration. Values seed from environment variables on first read and can
// then be overridden via the admin page (stored in the `settings` table).

import * as db from "./db.js";
import { env } from "./env.js";

export interface ReportingSettings {
  enabled: boolean;
  refreshToken: string;
  baseUrl: string;
  time: string;
  timezone: string;
  pageSize: number;
  maxPages: number;
  outputDir: string;
}

export interface AppSettings {
  adminUsernames: string[];
  reporting: ReportingSettings;
}

// key -> env-seeded default. Values stored in DB override these once saved.
const SETTING_DEFAULTS: Record<string, unknown> = {
  admin_usernames: env.ADMIN_USERNAMES.split(",").map((s) => s.trim()).filter(Boolean),
  reporting_enabled: env.REPORTING_ENABLED,
  reporting_refresh_token: env.REPORTING_REFRESH_TOKEN,
  reporting_base_url: env.REPORTING_BASE_URL,
  reporting_time: env.REPORTING_TIME,
  reporting_timezone: env.REPORTING_TIMEZONE,
  reporting_page_size: env.REPORTING_PAGE_SIZE,
  reporting_max_pages: env.REPORTING_MAX_PAGES,
  reporting_output_dir: env.REPORTING_OUTPUT_DIR,
};

let _cache: Record<string, unknown> | null = null;

function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function getSettings(): Record<string, unknown> {
  if (_cache) return _cache;
  const raw = db.getAllSettings();
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    const stored = raw[key];
    result[key] = stored !== undefined ? parse(stored) : SETTING_DEFAULTS[key];
  }
  _cache = result;
  return result;
}

export function saveSettings(partial: Record<string, unknown>): void {
  const known = new Set(Object.keys(SETTING_DEFAULTS));
  const toStore: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(partial)) {
    if (!known.has(k)) continue; // ignore unknown keys
    toStore[k] = v;
  }
  db.setSettings(toStore);
  _cache = null;
}

export function getReportingSettings(): ReportingSettings {
  const s = getSettings();
  return {
    enabled: Boolean(s.reporting_enabled),
    refreshToken: String(s.reporting_refresh_token ?? ""),
    baseUrl: String(s.reporting_base_url ?? env.PRODUUZIT_BASE_URL),
    time: String(s.reporting_time ?? "18:15"),
    timezone: String(s.reporting_timezone ?? "Europe/Amsterdam"),
    pageSize: Number(s.reporting_page_size ?? 1000),
    maxPages: Number(s.reporting_max_pages ?? 60),
    outputDir: String(s.reporting_output_dir ?? "data/reporting"),
  };
}

export function getAdminUsernames(): string[] {
  const v = getSettings().admin_usernames;
  return Array.isArray(v) ? (v as string[]) : [];
}

export function isAdmin(username: string): boolean {
  const u = (username ?? "").trim().toLowerCase();
  return getAdminUsernames().some((a) => String(a).trim().toLowerCase() === u);
}
