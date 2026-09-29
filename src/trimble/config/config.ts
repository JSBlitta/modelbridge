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

export async function loadConfig(path = 'Configuration.json'): Promise<Config> {
  const content = await readFile(path, 'utf-8');
  const parsed = JSON.parse(content) as unknown;
  return rawConfigSchema.parse(parsed);
}

export function loadConfigSync(content: string): Config {
  const parsed = JSON.parse(content) as unknown;
  return rawConfigSchema.parse(parsed);
}
