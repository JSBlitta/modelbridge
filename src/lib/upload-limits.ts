// Upload size ceiling.
//
// Both upload routes read the whole file into memory via arrayBuffer()/FormData
// with no bound, so a single large POST could exhaust the process heap.

import type { Context } from "hono";
import { env } from "../env.js";

export const MAX_UPLOAD_BYTES = env.MAX_UPLOAD_MB * 1024 * 1024;

export function tooLarge(c: Context, actualBytes: number): Response {
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  return c.json(
    {
      error: `File is ${mb(actualBytes)} MB; the limit is ${mb(MAX_UPLOAD_BYTES)} MB.`,
      code: "PAYLOAD_TOO_LARGE",
    },
    413,
  );
}
