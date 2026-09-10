// Server side of the define -> check -> confirm -> push contract.
//
// The UI hides the push button until the operator has run a check and ticked a
// box. That is an affordance, not a boundary — a direct HTTP call skips it
// entirely. This module makes the same rule enforceable on the server:
//
//   1. a /preview* endpoint calls issuePreviewToken() with the exact inputs it
//      previewed, and returns the token to the client;
//   2. the matching execute endpoint calls requirePreviewToken() with the inputs
//      it was asked to write.
//
// The token is bound to a fingerprint of those inputs and is single-use, so an
// import can only ever apply the payload that was actually previewed, once.

import type { Context } from "hono";
import * as db from "../db.js";
import type { PreviewTokenFailure } from "../db.js";
import { fingerprint, newPreviewToken } from "./fingerprint.js";
import { logger } from "../logger.js";

// Scope names keep a token minted for one flow from being spent on another.
export const GATE = {
  trimbleImport: "trimble:import",
  assemblyImport: "assembly:import",
  batchCreate: "batch:create",
  projectCreate: "project:create",
  countCreate: "count:create",
  phaseCreate: "phase:create",
  assemblyUpdate: "assembly:update",
} as const;

export type GateScope = (typeof GATE)[keyof typeof GATE];

export function issuePreviewToken(scope: GateScope, gateInput: unknown): string {
  const token = newPreviewToken();
  db.createPreviewToken(token, fingerprint(gateInput), scope);
  return token;
}

const REASONS: Record<PreviewTokenFailure, string> = {
  missing:
    "This action requires a completed check. Run the check, review the result, then confirm.",
  unknown:
    "That check is no longer valid — it may already have been used. Run the check again.",
  expired: "That check has expired. Run the check again and confirm the fresh result.",
  scope: "That check belongs to a different action. Run the check for this action.",
  mismatch:
    "The data changed after the check was run. Run the check again so you are confirming what will actually be sent.",
};

// Returns a ready-to-return 409 Response when the gate rejects, or null when it
// passes. Callers use: `const blocked = requirePreviewToken(...); if (blocked) return blocked;`
export function requirePreviewToken(
  c: Context,
  scope: GateScope,
  token: string | undefined,
  gateInput: unknown,
): Response | null {
  const failure = db.consumePreviewToken(token, fingerprint(gateInput), scope);
  if (!failure) return null;

  logger.warn(`[push-gate] rejected ${scope}: ${failure}`);
  db.recordEvent({
    category: "produuzit",
    level: "warn",
    summary: `Push blocked (${scope})`,
    detail: failure,
  });
  return c.json({ error: REASONS[failure], code: "PREVIEW_REQUIRED", reason: failure }, 409);
}
