import { Hono } from "hono";
import { apiGet, apiPostFormData } from "../produuzit-client.js";

const app = new Hono();

app.post("/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) return c.json({ error: "No file" }, 400);

  const batchUuid = formData.get("batch_uuid") as string | null;
  const projectUuid = formData.get("project_uuid") as string | null;

  const fd = new FormData();
  fd.append("file", file, file.name);
  if (batchUuid) fd.append("batch", batchUuid);
  if (projectUuid) fd.append("project", projectUuid);

  return c.json(await apiPostFormData("/cloudstorage/files/", fd));
});

app.get("/files", async (c) => {
  const batchUuid = c.req.query("batch_uuid");
  const projectUuid = c.req.query("project_uuid");
  const limit = c.req.query("limit") ?? "100";
  const offset = c.req.query("offset") ?? "0";
  const params: Record<string, string | number> = { limit: parseInt(limit), offset: parseInt(offset) };
  if (batchUuid) params.batch = batchUuid;
  if (projectUuid) params.project = projectUuid;
  return c.json(await apiGet("/cloudstorage/files/", params));
});

export default app;
