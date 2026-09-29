// Date/weekday helpers for the reporting scheduler.
//
// Conventions (mirrors the Power Automate solution):
// - Weekdays are Dutch names, indexed like JS Date.getDay(): 0 = Zondag (Sunday).
// - All "today" decisions are computed in the configured time zone
//   (REPORTING_TIMEZONE, default Europe/Amsterdam). The helper returns a Date
//   whose UTC fields represent the wall-clock time in that zone, so callers use
//   getUTC*() accessors.
// - The non-overwrite filename carries the ISO 8601 week number, computed with
//   the same formula Power Automate used (week containing Thursday).

import type { ScheduleEntry } from "./types.ts";

export const DUTCH_WEEKDAYS = [
  "Zondag",
  "Maandag",
  "Dinsdag",
  "Woensdag",
  "Donderdag",
  "Vrijdag",
  "Zaterdag",
];

export function amsterdamNow(timeZone = "Europe/Amsterdam"): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const v: Record<string, string> = {};
  for (const p of parts) v[p.type] = p.value;
  const hour = v.hour === "24" ? 0 : Number(v.hour);
  return new Date(
    Date.UTC(Number(v.year), Number(v.month) - 1, Number(v.day), hour, Number(v.minute), Number(v.second)),
  );
}

// ISO 8601 week number (1..53) of a date already expressed in UTC fields.
export function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of the same week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

// Does this schedule entry fire "today" (in the given zone)?
export function matchesToday(entry: ScheduleEntry, now: Date): boolean {
  const weekday = DUTCH_WEEKDAYS[now.getUTCDay()];
  switch (entry.frequency) {
    case "Dagelijks":
      return entry.weekdays.includes(weekday);
    case "Wekelijks":
      return (entry.weekdays[0] ?? "") === weekday;
    case "Maandelijks":
      return entry.dayOfMonth === now.getUTCDate();
    default:
      return false;
  }
}

// Build the output filename to match the Power Automate convention exactly.
// The existing Power BI report filters on the literal filename
// (e.g. "constructibles - batches - .json"), so we keep PA's replace('/', ' - ')
// output — including the trailing " - " on endpoints that end in a slash —
// rather than cleaning it up.
export function filenameFor(entry: ScheduleEntry, now: Date): string {
  const base = entry.endpoint.replace(/\//g, " - ");
  if (entry.overwrite) return `${base}.json`;
  const weekday = DUTCH_WEEKDAYS[now.getUTCDay()];
  return `${base} ${weekday} - Week ${isoWeek(now)}.json`;
}
