// One-shot reporting run — the manual/test entry point for the reporting
// scheduler. Run with: npm run reporting
//
// Suitable for Windows Task Scheduler when the in-server scheduler
// (REPORTING_ENABLED=true) is not used.

import "./env.js";
import { env } from "./env.ts";
import { initLogger, logger } from "./logger.ts";
import { initDb } from "./db.ts";
import { runReportingCycle } from "./reporting/runner.ts";

initLogger(env.LOG_LEVEL, env.LOG_FILE);
initDb();

runReportingCycle()
  .then((result) => {
    if (result.entriesFailed > 0) {
      logger.error(
        `[reporting] ${result.entriesSucceeded} ok, ${result.entriesFailed} failed ` +
        `(${result.entriesMatched} endpoints matched today)`,
      );
      process.exit(1);
    }
    logger.info(
      `[reporting] ${result.entriesSucceeded} ok, 0 failed ` +
      `(${result.entriesMatched} endpoints matched today)`,
    );
    process.exit(0);
  })
  .catch((e) => {
    logger.error(`[reporting] Fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
