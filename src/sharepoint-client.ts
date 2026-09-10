// SharePoint integration for the reporting output — replaces the
// "Post in Sharepoint" Power Automate flow (site "Produuzit-APIdata",
// folder "Shared Documents/API data/{Opslaglocatie}").
//
// Uses the SharePoint REST API (`/_api`) with an Azure AD app-only token
// (OAuth2 client credentials). Configure via env vars:
//   SHAREPOINT_SITE_URL      e.g. https://blittanl.sharepoint.com/sites/Produuzit-APIdata
//   SHAREPOINT_TENANT_ID     Azure AD tenant GUID
//   SHAREPOINT_CLIENT_ID     Azure AD app registration client id
//   SHAREPOINT_CLIENT_SECRET Azure AD app registration client secret
//   SHAREPOINT_BASE_FOLDER   folder under the document library (default "Shared Documents/API data")
//
// The Azure AD app needs the SharePoint permission Sites.ReadWrite.All.

import { env } from "./env.js";
import { logger } from "./logger.js";

let accessToken: string | null = null;
let tokenExpiresAt = 0;

export function isSharePointConfigured(): boolean {
  return Boolean(
    env.SHAREPOINT_SITE_URL &&
    env.SHAREPOINT_TENANT_ID &&
    env.SHAREPOINT_CLIENT_ID &&
    env.SHAREPOINT_CLIENT_SECRET,
  );
}

function siteUrl(): string {
  return env.SHAREPOINT_SITE_URL.replace(/\/+$/, "");
}

function parseSite(): { hostname: string; sitePath: string } {
  const url = new URL(siteUrl());
  return { hostname: url.hostname, sitePath: url.pathname.replace(/\/+$/, "") };
}

// Encode each path segment, keeping the "/" separators intact so SharePoint
// resolves the server-relative path correctly.
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  const { hostname } = parseSite();
  const res = await fetch(`https://login.microsoftonline.com/${env.SHAREPOINT_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.SHAREPOINT_CLIENT_ID,
      client_secret: env.SHAREPOINT_CLIENT_SECRET,
      grant_type: "client_credentials",
      scope: `https://${hostname}/.default`,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SharePoint token request failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
  logger.debug("[sharepoint] Access token refreshed");
  return accessToken;
}

function serverRelativeFolder(relativeFolder: string): string {
  const { sitePath } = parseSite();
  const segments = [sitePath, env.SHAREPOINT_BASE_FOLDER, relativeFolder].filter(Boolean);
  return "/" + segments.join("/").replace(/\/+/g, "/");
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`${siteUrl()}/_api${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json;odata=verbose",
      ...(init.headers ?? {}),
    },
  });
}

export async function sharepointFileExists(relativeFolder: string, filename: string): Promise<boolean> {
  const rel = `${serverRelativeFolder(relativeFolder)}/${filename}`;
  const res = await api(`/web/GetFileByServerRelativeUrl('${encodePath(rel)}')`);
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  const body = await res.text();
  throw new Error(`SharePoint file check failed (${rel}): ${res.status} ${body.slice(0, 200)}`);
}

export async function sharepointUpload(relativeFolder: string, filename: string, content: string, overwrite: boolean): Promise<void> {
  const folder = serverRelativeFolder(relativeFolder);
  const res = await api(
    `/web/GetFolderByServerRelativeUrl('${encodePath(folder)}')/Files/add(overwrite=${overwrite},url='${encodeURIComponent(filename)}')`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: content,
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SharePoint upload failed (${relativeFolder}/${filename}): ${res.status} ${body.slice(0, 300)}`);
  }
}

export async function sharepointRead(relativeFolder: string, filename: string): Promise<string | null> {
  if (!(await sharepointFileExists(relativeFolder, filename))) return null;
  const rel = `${serverRelativeFolder(relativeFolder)}/${filename}`;
  const res = await api(`/web/GetFileByServerRelativeUrl('${encodePath(rel)}')/$value`);
  if (!res.ok) return null;
  return res.text();
}
