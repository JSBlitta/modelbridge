import { Hono } from "hono";
import { parseProjectCsv } from "../csv-parser.ts";
import { getConfig } from "../config.ts";
import { readUploadedText } from "../lib/upload-limits.ts";

const app = new Hono();

app.post("/parse", async (c) => {
  const read = await readUploadedText(c);
  if (read instanceof Response) return read;

  const cfg = getConfig();
  return c.json(parseProjectCsv(read.text, cfg.synonyms, cfg.description_to_suffix));
});

export default app;
