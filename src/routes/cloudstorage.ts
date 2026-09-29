import { Hono } from "hono";
import { apiGet, apiPostFormData } from "../produuzit-client.ts";
import { boundedInt, isUuid } from "../lib/validate.ts";
import { MAX_UPLOAD_BYTES, tooLarge } from "../lib/upload-limits.ts";

const app = new Hono();

app.post("/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) return c.json({ error: "No file" }, 400);

  if (file.size > MAX_UPLOAD_BYTES) return tooLarge(c, file.size);

  const batchUuid = formData.get("batch_uuid") as string | null;
  const projectUuid = formData.get("project_uuid") as string | null;
  const assemblyUuid = formData.get("assembly_uuid") as string | null;
  for (const [name, val] of [["batch_uuid", batchUuid], ["project_uuid", projectUuid], ["assembly_uuid", assemblyUuid]] as const) {
    if (val && !isUuid(val)) return c.json({ error: `Invalid ${name}` }, 400);
  }

  const fd = new FormData();
  fd.append("file", file, file.name);
  if (batchUuid) fd.append("batch", batchUuid);
  if (projectUuid) fd.append("project", projectUuid);
  if (assemblyUuid) fd.append("assembly", assemblyUuid);

  return c.json(await apiPostFormData("/cloudstorage/files/", fd));
});

app.get("/files", async (c) => {
  const batchUuid = c.req.query("batch_uuid");
  const projectUuid = c.req.query("project_uuid");
  const params: Record<string, string | number> = {
    limit: boundedInt(c.req.query("limit"), 100, 1, 1000),
    offset: boundedInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
  };
  if (batchUuid) params.batch = batchUuid;
  if (projectUuid) params.project = projectUuid;
  return c.json(await apiGet("/cloudstorage/files/", params));
});

export default app;
