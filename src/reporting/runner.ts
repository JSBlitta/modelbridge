// Reporting scheduler — the TypeScript replacement for the "Produuzit data"
// (daily recurrence) and "GET Endpoint to sharepoint" Power Automate flows.
//
// Every cycle:
//   1. Refresh the reporting account's access token (was the "GET Access token" child flow)
//   2. Load the schedule (SharePoint list "Produuzit_API_frequentie", now a CSV)
//   3. For each active row whose frequency matches today:
//        fetch the endpoint (all pages) → write JSON to the output store →
//        update the last-run state
//
// Every action is recorded in the persistent event history (category
// "reporting") so the notification bell shows what has been done.

import { env } from "../env.js";
import { recordEvent } from "../db.js";
import { logger } from "../logger.js";
import { CsvScheduleSource, type ScheduleSource } from "./config.js";
import { fetchAllReporting, refreshReportingAccessToken } from "./client.js";
import { JsonLastRunStore, LocalFileStore, type LastRunStore, type OutputStore } from "./storage.js";
import { amsterdamNow, filenameFor, matchesToday } from "./dates.js";
import type { CycleResult, EndpointRunResult, ScheduleEntry } from "./types.js";

export interface ReportingDeps {
  source?: ScheduleSource;
  output?: OutputStore;
  lastRun?: LastRunStore;
}

export function defaultDeps(): Required<ReportingDeps> {
  return {
    source: new CsvScheduleSource(env.REPORTING_CONFIG_CSV),
    output: new LocalFileStore(env.REPORTING_OUTPUT_DIR),
    lastRun: new JsonLastRunStore(env.REPORTING_LAST_RUN_FILE),
  };
}

function displayPath(store: OutputStore, file: string): string {
  return store instanceof LocalFileStore ? store.displayPath(file) : file;
}

export async function runOneEndpoint(
  entry: ScheduleEntry,
  now: Date,
  deps: Required<ReportingDeps>,
): Promise<EndpointRunResult> {
  try {
    const items = await fetchAllReporting(entry.endpoint);
    const filename = filenameFor(entry, now);
    const { path, created } = await deps.output.write(entry.storagePath, filename, JSON.stringify(items), entry.overwrite);
    const rel = displayPath(deps.output, path);
    await deps.lastRun.set(entry.endpoint, new Date().toISOString());

    recordEvent({
      category: "reporting",
      level: "info",
      summary: entry.endpoint,
      detail: created ? `${items.length} items → ${rel}` : `${items.length} items · ${rel} already exists (skipped)`,
    });
    return { endpoint: entry.endpoint, matched: true, status: "ok", file: rel, itemCount: items.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    recordEvent({ category: "reporting", level: "error", summary: `${entry.endpoint} failed`, detail: message });
    return { endpoint: entry.endpoint, matched: true, status: "error", reason: message };
  }
}

export async function runReportingCycle(
  now: Date = amsterdamNow(env.REPORTING_TIMEZONE),
  depsOverride?: ReportingDeps,
): Promise<CycleResult> {
  const deps: Required<ReportingDeps> = { ...defaultDeps(), ...depsOverride };
  const startedAt = new Date().toISOString();

  recordEvent({ category: "reporting", level: "info", summary: "Reporting cycle started" });
  logger.info(`[reporting] Cycle started (${now.toISOString()})`);

  const runs: EndpointRunResult[] = [];

  try {
    // Fresh access token for this cycle — mirrors the child flow that ran first
    await refreshReportingAccessToken();

    const entries = await deps.source.load();
    logger.info(`[reporting] ${entries.length} schedule entries loaded`);

    for (const entry of entries) {
      if (!entry.active) {
        runs.push({ endpoint: entry.endpoint, matched: false, status: "skipped", reason: "disabled" });
        continue;
      }
      if (!matchesToday(entry, now)) {
        runs.push({ endpoint: entry.endpoint, matched: false, status: "skipped" });
        continue;
      }
      runs.push(await runOneEndpoint(entry, now, deps));
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    recordEvent({ category: "reporting", level: "error", summary: "Reporting cycle failed", detail: message });
    logger.error(`[reporting] Cycle failed: ${message}`);
    throw e; // propagate so the CLI exits non-zero and the scheduler logs it
  }

  const matched = runs.filter((r) => r.matched);
  const result: CycleResult = {
    startedAt,
    finishedAt: new Date().toISOString(),
    entriesMatched: matched.length,
    entriesSucceeded: runs.filter((r) => r.status === "ok").length,
    entriesFailed: runs.filter((r) => r.status === "error").length,
    runs,
  };

  recordEvent({
    category: "reporting",
    level: result.entriesFailed ? "warn" : "info",
    summary: "Reporting cycle finished",
    detail: `${result.entriesSucceeded} ok, ${result.entriesFailed} failed, ${result.entriesMatched} matched`,
  });
  logger.info(
    `[reporting] Cycle finished — ${result.entriesSucceeded} ok, ${result.entriesFailed} failed ` +
    `(${runs.length - matched.length} scheduled entries skipped for today)`,
  );
  return result;
}

// Start the in-server daily scheduler (REPORTING_ENABLED=true). Runs the cycle
// once per day when the clock hits REPORTING_TIME in REPORTING_TIMEZONE.
export function startReportingScheduler(intervalMs = 30_000): NodeJS.Timeout {
  let lastRunDay: string | null = null;

  const pad = (n: number) => String(n).padStart(2, "0");
  const dayKey = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

  const tick = () => {
    const now = amsterdamNow(env.REPORTING_TIMEZONE);
    const hhmm = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
    const today = dayKey(now);
    if (hhmm === env.REPORTING_TIME && lastRunDay !== today) {
      lastRunDay = today; // set first so a slow cycle never double-fires
      logger.info(`[reporting] Scheduled run triggered (${env.REPORTING_TIME} ${env.REPORTING_TIMEZONE})`);
      runReportingCycle(now).catch((e) => {
        logger.error(`[reporting] Scheduled run failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  };

  tick(); // catch the exact minute if the server starts inside it
  return setInterval(tick, intervalMs);
}
