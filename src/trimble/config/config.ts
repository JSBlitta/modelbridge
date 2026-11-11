import { z } from 'zod';
import { readFile } from 'node:fs/promises';

const connectorSettingsSchema = z.object({
  companyName: z.string().default('Blitta'),
  companyFolderOnly: z.boolean().default(true),
  standardFields: z.array(z.string()).default(['id', 'product', 'psets', 'psets.name']),
  decimalPlaces: z.number().int().min(0).default(2),
  batchChunkSize: z.number().int().min(1).default(5000),
  expandAllFields: z.boolean().default(true),
  propertysetToKeep: z.array(z.string()).default(['BLITTA']),
  propertySetsDiscard: z.array(z.string()).default([]),
  entityTextFilter: z.string().default(''),
});

const authorizationSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  scope: z.string(),
});

const urlsSchema = z.object({
  authorizeUri: z.string().url(),
  tokenUri: z.string().url(),
  redirectUri: z.string().url(),
  regionsUri: z.string().url(),
});

const tableColumnsSchema = z.object({
  projectsColumns: z.array(z.string()).default(['id', 'rootId', 'name', 'description']),
  folderColumns: z.array(z.string()).default(['id', 'name', 'type', 'versionId', 'projectId']),
  versionColumns: z.array(z.string()).default([
    'id',
    'name',
    'type',
    'versionId',
    'projectId',
    'path',
    'createdOn',
    'modifiedOn',
  ]),
  releaseColumns: z.array(z.string()).default([
    'id',
    'name',
    'status',
    'projectId',
    'dueDate',
    'notes',
    'modifiedOn',
    'createdOn',
  ]),
});

const rawConfigSchema = z.object({
  connectorSettings: connectorSettingsSchema.default({}),
  trimbleConnectAuthorization: authorizationSchema,
  trimbleConnectURLs: urlsSchema,
  tableColumns: tableColumnsSchema.default({}),
});

export type Config = z.infer<typeof rawConfigSchema>;

// The client id and secret come from the environment (TRIMBLE_CLIENT_ID,
// TRIMBLE_CLIENT_SECRET, the same variables the server reads from .env), so the
// secret never sits in Configuration.json, which is in git.
function withEnvCredentials(config: Config): Config {
  const auth = config.trimbleConnectAuthorization;
  auth.clientId = process.env.TRIMBLE_CLIENT_ID || auth.clientId;
  auth.clientSecret = process.env.TRIMBLE_CLIENT_SECRET || auth.clientSecret;
  if (!auth.clientSecret) throw new Error('TRIMBLE_CLIENT_SECRET is not set (in .env or the environment)');
  return config;
}

export async function loadConfig(path = 'Configuration.json'): Promise<Config> {
  try { process.loadEnvFile(); } catch { /* no .env: the environment alone counts */ }
  const content = await readFile(path, 'utf-8');
  const parsed = JSON.parse(content) as unknown;
  return withEnvCredentials(rawConfigSchema.parse(parsed));
}

export function loadConfigSync(content: string): Config {
  const parsed = JSON.parse(content) as unknown;
  return withEnvCredentials(rawConfigSchema.parse(parsed));
}
