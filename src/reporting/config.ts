// Schedule configuration.
//
// The schedule now lives in the `reporting_schedule` SQLite table (editable via
// the admin page). On first use it is seeded from the SharePoint list CSV export
// (REPORTING_CONFIG_CSV). A SharePoint-backed source can still be added later by
// implementing ScheduleSource.

import { existsSync, readFileSync } from "node:fs";
import { detectDelimiter, splitCsvLine } from "../csv-parser.js";
import * as db from "../db.js";
import { logger } from "../logger.js";
import type { Frequency, ScheduleEntry } from "./types.js";

export interface ScheduleSource {
  load(): Promise<ScheduleEntry[]>;
}

const FREQUENCIES: Frequency[] = ["Dagelijks", "Wekelijks", "Maandelijks"];

function parseDutchBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (["waar", "true", "ja", "yes", "1"].includes(v)) return true;
  return false; // "Niet waar", "false", "nee", "" — anything else is false
}

function parseWeekdays(value: string): string[] {
  const v = value.trim();
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed.map((d) => String(d).trim()).filter(Boolean);
  } catch { /* fall through to comma split */ }
  return v.split(",").map((d) => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

export function parseScheduleCsv(text: string): ScheduleEntry[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const delim = detectDelimiter(lines[0]);
  const headers = lines[0].split(delim).map((h) => h.trim().replace(/^"|"$/g, ""));
  const col = (names: string[]): number => {
    const idx = headers.findIndex((h) => names.some((n) => n.toLowerCase() === h.toLowerCase()));
    return idx;
  };

  const iEndpoint = col(["Endpoint", "Title"]);
  const iActive = col(["In werking", "InWerking"]);
  const iFrequency = col(["Type frequentie", "Periodiek"]);
  const iWeekdays = col(["Dag van de week", "Dagvandeweek"]);
  const iDayOfMonth = col(["Dag van de maand", "DagvandeMaand"]);
  const iConditions = col(["Voorwaarden"]);
  const iLastRun = col(["Laatste run", "Laatsterun"]);
  const iStorage = col(["Opslaglocatie"]);
  const iOverwrite = col(["Overschrijven"]);

  if (iEndpoint < 0) {
    logger.warn("[reporting] Schedule CSV has no Endpoint column — no endpoints scheduled");
    return [];
  }

  const entries: ScheduleEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i], delim);
    const get = (idx: number): string => (idx >= 0 && idx < values.length ? values[idx] ?? "" : "").trim();

    const endpoint = get(iEndpoint);
    if (!endpoint) continue;

    const frequency = get(iFrequency) as Frequency;
    if (!FREQUENCIES.includes(frequency)) {
      logger.warn(`[reporting] Unknown frequency "${frequency}" for ${endpoint} — row skipped`);
      continue;
    }

    const dayOfMonthRaw = get(iDayOfMonth);
    const dayOfMonth = dayOfMonthRaw ? parseInt(dayOfMonthRaw, 10) : null;

    entries.push({
      endpoint,
      active: iActive < 0 ? true : parseDutchBool(get(iActive)),
      frequency,
      weekdays: iWeekdays < 0 ? [] : parseWeekdays(get(iWeekdays)),
      dayOfMonth: dayOfMonth && !isNaN(dayOfMonth) ? dayOfMonth : null,
      conditions: iConditions >= 0 ? get(iConditions) : "",
      lastRun: iLastRun >= 0 ? get(iLastRun) : "",
      storagePath: iStorage >= 0 ? get(iStorage) : "",
      overwrite: iOverwrite >= 0 ? parseDutchBool(get(iOverwrite)) : false,
    });
  }
  return entries;
}

// Loads the schedule from a local CSV file (the SharePoint list export).
export class CsvScheduleSource implements ScheduleSource {
  constructor(private readonly path: string) {}

  async load(): Promise<ScheduleEntry[]> {
    const text = readFileSync(this.path, "utf-8");
    return parseScheduleCsv(text);
  }
}

function rowToEntry(r: db.ReportingScheduleRow): ScheduleEntry {
  return {
    endpoint: r.endpoint,
    active: Boolean(r.active),
    frequency: r.frequency as Frequency,
    weekdays: parseWeekdays(r.weekdays),
    dayOfMonth: r.day_of_month,
    conditions: r.conditions,
    lastRun: "",
    storagePath: r.storage_path,
    overwrite: Boolean(r.overwrite),
  };
}

// Loads the schedule from SQLite, seeding from the CSV on the first run.
export class DbScheduleSource implements ScheduleSource {
  constructor(private readonly seedCsvPath: string) {}

  async load(): Promise<ScheduleEntry[]> {
    let rows = db.listReportingSchedule();
    if (!rows.length && this.seedCsvPath && existsSync(this.seedCsvPath)) {
      logger.info(`[reporting] Seeding schedule from ${this.seedCsvPath}`);
      const entries = parseScheduleCsv(readFileSync(this.seedCsvPath, "utf-8"));
      for (const e of entries) {
        db.upsertReportingSchedule({
          endpoint: e.endpoint,
          active: e.active,
          frequency: e.frequency,
          weekdays: e.weekdays,
          day_of_month: e.dayOfMonth,
          conditions: e.conditions,
          storage_path: e.storagePath,
          overwrite: e.overwrite,
        });
      }
      rows = db.listReportingSchedule();
    }
    return rows.map(rowToEntry);
  }
}
