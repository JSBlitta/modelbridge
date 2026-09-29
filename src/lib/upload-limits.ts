// Upload size ceiling.
//
// Every upload route reads the whole file into memory via arrayBuffer()/FormData
// with no bound, so a single large POST could exhaust the process heap.

import type { Context } from "hono";

const DEFAULT_MAX_MB = 25;

export const MAX_UPLOAD_BYTES =
  (Number.parseInt(process.env.MAX_UPLOAD_MB ?? "", 10) || DEFAULT_MAX_MB) * 1024 * 1024;

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

// Read a single uploaded text file: enforce the size ceiling, decode UTF-8 and
// strip a leading BOM. Returns a ready-to-return 400/413 Response on failure.
export async function readUploadedText(c: Context, field = "file"): Promise<{ text: string } | Response> {
  const formData = await c.req.formData();
  const file = formData.get(field);
  if (!file || !(file instanceof File)) return c.json({ error: "No file uploaded" }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return tooLarge(c, file.size);

  const decoder = new TextDecoder("utf-8");
  const text = decoder.decode(await file.arrayBuffer());
  return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
}
