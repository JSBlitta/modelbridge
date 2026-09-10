// Payload fingerprinting for the preview->import gate.
//
// The guarantee we need is "what you are pushing is exactly what you previewed".
// The server computes a fingerprint of the preview payload, hands back an opaque
// token bound to it, and refuses the matching import unless the payload it
// receives fingerprints to the same value. The client never computes a hash — it
// only carries the token — so there is one implementation, on the side that
// matters.

import { createHash, randomUUID } from "node:crypto";

// Deterministic JSON: object keys sorted recursively so that key order in the
// request body cannot change the fingerprint. Array order IS significant and is
// preserved — a reordered entity list is a different import.
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    out[key] = canonicalize(obj[key]);
  }
  return out;
}

export function fingerprint(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}

export function newPreviewToken(): string {
  return randomUUID();
}
