// Input validation for values that are interpolated into upstream API URLs.
//
// Route params reached the Produuzit and Trimble clients unchecked, so a param
// like `..%2f..%2fcompany%2fapi_accounts` could steer a request carrying the
// company service token at an endpoint the caller was never meant to reach.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined | null): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// Trimble ids are not all RFC-4122 UUIDs (project and model ids are opaque
// tokens), so the rule there is a character allowlist that cannot express a path
// segment, a scheme, or a query.
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isOpaqueId(value: string | undefined | null): value is string {
  return typeof value === "string" && OPAQUE_ID_RE.test(value);
}

// Bounded integer parse for limit/offset query params, which previously went
// through a bare parseInt and could reach the upstream API as NaN.
export function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
