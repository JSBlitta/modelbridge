#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { loadConfig, type Config } from './config/config.js';
import { getRegionEndpoints } from './config/regions.js';
import { OAuthClient, createOAuthConfig } from './auth/oauth.js';
import { FileTokenStore } from './auth/fileTokenStore.js';
import { InMemoryDownstreamSink } from './output/downstreamApi.js';
import { createCoreApi } from './apis/core.js';
import { HttpClient } from './http/client.js';
import { walkFolders } from './pipeline/folderWalker.js';
import { run } from './run.js';
import type { Tokens } from './types/index.js';
import type { FolderItem } from './apis/core.js';

interface CliOptions {
  help: boolean;
  verbose: boolean;
  configPath: string;
  tokenPath: string;
  region: string;
  redirectUri: string;
  skipPropertyset: boolean;
  projectId?: string;
  modelId?: string;
  versionId?: string;
}

interface ModelChoice {
  modelId: string;
  fileId: string;
  name: string;
  versionId: string;
  path: string;
}

async function main(): Promise<void> {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }
  const config = await loadConfig(options.configPath);
  const tokenStore = new FileTokenStore(options.tokenPath);

  const existingTokens = await tokenStore.getTokens();
  if (!existingTokens?.access_token) {
    await authenticate(options, config, tokenStore);
  } else {
    console.log('Using existing tokens from', options.tokenPath);
  }

  const endpoints = getRegionEndpoints(options.region);
  const oauthClient = new OAuthClient(createOAuthConfig(config));
  const httpClient = new HttpClient({
    endpoints,
    tokenStore,
    oauthClient,
  });
  const coreApi = createCoreApi(httpClient, endpoints);

  let projectId = options.projectId;
  if (!projectId) {
    projectId = await selectProject(coreApi);
  }

  let modelId = options.modelId;
  let versionId = options.versionId;
  if (!modelId) {
    const model = await selectModel(coreApi, projectId, options.verbose);
    modelId = model.modelId;
    versionId = model.versionId;
  }

  console.log('\nRunning pipeline...');
  console.log('  projectId:', projectId);
  console.log('  modelId:', modelId);
  console.log('  versionId:', versionId);

  const sink = new InMemoryDownstreamSink();
  const result = await run(
    {
      region: options.region,
      projectId,
      modelId,
      versionId,
    },
    { config, tokenStore, sink, skipPropertyset: options.skipPropertyset },
  );

  console.log('\nResult:');
  console.log('  entityCount:', result.entityCount);

  if (sink.batches.length > 0) {
    console.log('\nDownstream batches:');
    for (const batch of sink.batches) {
      console.log(`  ${batch.tableName}: ${batch.rows.length} rows`);
    }
    console.log('\nFirst row sample:');
    console.log(JSON.stringify(sink.batches[0]?.rows[0], null, 2));
  }
}

async function selectProject(coreApi: ReturnType<typeof createCoreApi>): Promise<string> {
  console.log('\nFetching projects...');
  const projects = await coreApi.getProjects();

  if (projects.length === 0) {
    throw new Error('No projects found');
  }

  console.log('\nProjects:');
  projects.forEach((project, index) => {
    console.log(`  [${index + 1}] ${project.name} (${project.id})`);
  });

  const input = await ask(`\nSelect a project (1-${projects.length}): `);
  const selectedIndex = Number(input) - 1;

  if (Number.isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= projects.length) {
    throw new Error('Invalid project selection');
  }

  const selected = projects[selectedIndex];
  if (!selected) {
    throw new Error('Invalid project selection');
  }

  console.log(`Selected: ${selected.name}`);
  return selected.id;
}

async function selectModel(
  coreApi: ReturnType<typeof createCoreApi>,
  projectId: string,
  verbose: boolean,
): Promise<ModelChoice> {
  console.log('\nFetching project root and walking folders for model files...');
  const projects = await coreApi.getProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const models: ModelChoice[] = [];
  const pathMap = new Map<string, string>();

  for await (const item of walkFolders(coreApi, project.rootId, { recursive: true })) {
    if (item.type === 'Folder') {
      const parentPath = item.parentId ? pathMap.get(item.parentId) ?? '' : '';
      pathMap.set(item.id, parentPath ? `${parentPath}/${item.name}` : item.name);
      continue;
    }

    if (item.type === 'File' && isValidModelFileType(item.name)) {
      const path = buildPath(pathMap, item);
      try {
        const versions = await coreApi.getFileVersions(item.id);
        const version = pickLatestVersion(versions);
        if (verbose) {
          console.log(`  ${path}/${item.name}: ${versions.length} version(s)`);
          versions.forEach((v) => {
            const marker = v.versionId === version?.versionId ? ' <-- latest' : '';
            console.log(`    - id=${v.id}, versionId=${v.versionId}, name=${v.name}, modifiedOn=${v.modifiedOn ?? 'n/a'}${marker}`);
          });
        }
        if (version) {
          models.push({
            modelId: version.id,
            fileId: item.id,
            name: item.name,
            versionId: version.versionId,
            path,
          });
        }
      } catch (error) {
        console.warn(`  Could not fetch versions for ${item.name}:`, error instanceof Error ? error.message : error);
      }
    }
  }

  if (models.length === 0) {
    throw new Error(`No valid model files found in project ${projectId}`);
  }

  console.log('\nModel files:');
  models.forEach((model, index) => {
    console.log(`  [${index + 1}] ${model.path}/${model.name} (modelId=${model.modelId}, fileId=${model.fileId}, version=${model.versionId})`);
  });

  const input = await ask(`\nSelect a model (1-${models.length}): `);
  const selectedIndex = Number(input) - 1;

  if (Number.isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= models.length) {
    throw new Error('Invalid model selection');
  }

  const selected = models[selectedIndex];
  if (!selected) {
    throw new Error('Invalid model selection');
  }

  console.log(`Selected: ${selected.name}`);
  return selected;
}

function buildPath(pathMap: Map<string, string>, item: FolderItem): string {
  if (!item.parentId) return '';
  const parentPath = pathMap.get(item.parentId) ?? '';
  return parentPath;
}

function isValidModelFileType(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.ifc') || lower.endsWith('.ifczip') || lower.endsWith('.trb');
}

function pickLatestVersion(versions: Array<{ id: string; modifiedOn?: string; createdOn?: string; versionId: string }>) {
  if (versions.length === 0) return undefined;
  return [...versions].sort((a, b) => {
    const aDate = new Date(a.modifiedOn ?? a.createdOn ?? 0).getTime();
    const bDate = new Date(b.modifiedOn ?? b.createdOn ?? 0).getTime();
    return bDate - aDate;
  })[0];
}

async function authenticate(
  options: CliOptions,
  config: Config,
  tokenStore: FileTokenStore,
): Promise<Tokens> {
  const redirectUri = options.redirectUri;
  const configWithRedirect = {
    ...config,
    trimbleConnectURLs: {
      ...config.trimbleConnectURLs,
      redirectUri,
    },
  };

  const oauthClient = new OAuthClient(createOAuthConfig(configWithRedirect));
  const state = generateState();
  const { loginUri } = oauthClient.startLogin(state);

  const redirectUrl = new URL(redirectUri);
  const port = Number(redirectUrl.port || (redirectUrl.protocol === 'https:' ? 443 : 80));
  const pathname = redirectUrl.pathname || '/';

  const tokens = await new Promise<Tokens>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url ?? '/', `http://localhost:${port}`);

        if (reqUrl.pathname === pathname) {
          const callbackState = reqUrl.searchParams.get('state');
          if (callbackState !== state) {
            throw new Error('OAuth state mismatch');
          }

          const callbackUri = reqUrl.toString();
          const received = await oauthClient.finishLogin(callbackUri, tokenStore);

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Authentication successful</h1><p>You can close this window.</p></body></html>');

          server.close();
          resolve(received);
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(error instanceof Error ? error.message : 'Authentication failed');
        server.close();
        reject(error);
      }
    });

    server.listen(port, 'localhost', () => {
      console.log(`Listening for OAuth callback on ${redirectUri}`);
      console.log('Opening browser for login...\n');
      console.log('If the browser does not open, visit this URL manually:');
      console.log(loginUri, '\n');
      openBrowser(loginUri);
    });

    server.on('error', reject);
  });

  console.log('Authenticated successfully.\n');
  return tokens;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const getValue = (flag: string, fallback: string): string => {
    const index = args.indexOf(flag);
    return index !== -1 && args[index + 1] ? args[index + 1]! : fallback;
  };

  const hasFlag = (flag: string): boolean => args.includes(flag);

  return {
    help: hasFlag('--help') || hasFlag('-h'),
    verbose: hasFlag('--verbose') || hasFlag('-v'),
    configPath: getValue('--config', 'Configuration.json'),
    tokenPath: getValue('--tokens', '.tokens.json'),
    region: getValue('--region', 'Europe'),
    redirectUri: getValue('--redirect-uri', 'http://localhost:80'),
    skipPropertyset: hasFlag('--skip-propertyset'),
    projectId: hasFlag('--project-id') ? getValue('--project-id', '') || undefined : undefined,
    modelId: hasFlag('--model-id') ? getValue('--model-id', '') || undefined : undefined,
    versionId: hasFlag('--version-id') ? getValue('--version-id', '') || undefined : undefined,
  };
}

function printHelp(): void {
  console.log(`
Usage: npm run cli -- [options]

Options:
  --config <path>         Path to Configuration.json (default: Configuration.json)
  --tokens <path>         Path to token cache file (default: .tokens.json)
  --region <region>       Region to use (default: Europe)
  --redirect-uri <uri>    OAuth redirect URI (default: http://localhost:80)
  --skip-propertyset      Skip Trimble propertyset enrichment
  --verbose, -v           Print extra diagnostic info
  --project-id <id>       Skip project selection
  --model-id <id>         Skip model selection (requires --project-id)
  --version-id <id>       Model version to use (requires --model-id)
  --help, -h              Show this help message

Examples:
  npm run cli
  npm run cli -- --project-id NSsMIBkk2vM
  npm run cli -- --project-id NSsMIBkk2vM --model-id file-1 --version-id v1
  npm run cli -- --skip-propertyset
  npm run cli -- --redirect-uri http://localhost:8080/callback
`);
}

function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const command = platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
