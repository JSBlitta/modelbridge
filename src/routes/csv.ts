import { Hono } from "hono";
import { parseProjectCsv } from "../csv-parser.js";
import { getConfig } from "../config.js";
import { MAX_UPLOAD_BYTES, tooLarge } from "../lib/upload-limits.js";

const app = new Hono();

app.post("/parse", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) return c.json({ error: "No file" }, 400);

  if (file.size > MAX_UPLOAD_BYTES) return tooLarge(c, file.size);

  const buffer = await file.arrayBuffer();
  const decoder = new TextDecoder("utf-8");
  let text = decoder.decode(buffer);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const cfg = getConfig();
  return c.json(parseProjectCsv(text, cfg.synonyms, cfg.description_to_suffix));
});

export default app;
