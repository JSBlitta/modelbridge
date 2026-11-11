# ModelBridge

Web app that moves model data from Trimble Connect (IFC entities and property sets) and from CSV files into Produuzit: superprojects, projects, phases, batches, designs, assemblies and production counts. Users sign in with their own Produuzit account; the server talks to Produuzit with one service token from `.env`.

Runs on a Windows server (Node, behind IIS as a Windows service, see `HOSTING.md`). Development happens on Linux with git; the Windows target gets a 7z release and has no git.

## Layout

| Path | What |
|------|------|
| `src/index.ts` | Hono server: `/api/*` routes plus the built frontend from `frontend-dist/` (port `PORT`, default 3000) |
| `src/routes/` | One file per API area: `projects`, `batches`, `assemblies`, `csv`, `trimble`, `admin`, `auth`, ... |
| `src/lib/` | Shared logic. `push-gate.ts` and `produuzit-topology.ts` matter most (below) |
| `src/trimble/` | Trimble Connect client, OAuth, entity/pset pipeline, and a CLI (`npm run trimble-connect`) |
| `src/db.ts` | SQLite (better-sqlite3) at `DB_PATH`, default `state.db`; created on first start |
| `frontend/` | Vue 3 + PrimeVue + vue-i18n. Views in `src/views/` (`/import`, `/trimble`, `/batches`, `/update`, `/pdf`, `/admin`) |
| `config.yaml` | Column synonyms for CSV and Trimble auto-mapping, description-to-suffix rules |
| `Configuration.json` | Trimble Connect settings for the CLI |
| `scripts/pack-release.ts` | Builds the release 7z |
| `scripts/prune-stale.ts` | Run by `setup.bat`: moves code files a release no longer contains to `_attic/stale/` |
| `_attic/` | Reference material (API specs, old code); ignored by git, not used at runtime |
| `HOSTING.md`, `REPORTING.md` | IIS/NSSM hosting, and the reporting scheduler |

## Rules the code relies on

- **Check, confirm, then push.** The imports (assemblies, Trimble, batch counts, group presets) go through a preview endpoint first. The preview returns a single-use `preview_token` bound to a fingerprint of the exact inputs; the push endpoint refuses without a matching token (`src/lib/push-gate.ts`). In the UI this is `components/PushGate.vue` plus `composables/usePushGate.js`. Creating projects, phases and batches (`/api/projects/create`, `/api/batches/create`, `/api/batches/add-for-projects`) is guarded only in the UI: a read-only check (`/api/projects/find-or-create`, which despite its name creates nothing), then a confirm tick (`components/ConfirmedButton.vue`). A check never writes anything.
- **Projects resolve by name, project number, then the 7-character prefix** (`12654-A`). Two projects sharing a prefix resolve to neither; the code never guesses (`buildProjectMatcher` in `src/lib/produuzit-topology.ts`).
- **Production counts are written once.** An existing count is kept, never overwritten.
- **Every UI string exists in English and Dutch**: `frontend/src/i18n/en.js` and `nl.js`, same keys.
- **One column matcher** for CSV and Trimble auto-mapping: `src/lib/column-match.ts`. The frontend imports it from `../src/lib`, which is why `frontend/vite.config.js` sets `fs.allow: ['..']`.

## Develop

Node 22 or newer (`package.json` engines).

```bash
npm run setup          # backend + frontend dependencies
cp .env.example .env   # fill in Produuzit and Trimble credentials
npm run dev            # backend with reload, :3000
npm run dev:frontend   # Vite on :5173, proxies /api to :3000
```

Checks, all three must pass before a commit:

```bash
npx tsc --noEmit                 # backend typecheck (all of src/**)
npm test                         # node:test (src/*.test.ts) + vitest (src/trimble/**)
cd frontend && npm test          # node:test on frontend/src/**/*.test.mjs
```

## Release to the Windows target

1. Commit. `pack-release.ts` refuses a dirty tree, so the archive always matches a commit.
2. `bun scripts/pack-release.ts` (needs `7z` on PATH) writes `modelbridge-<commit>.7z`. It contains every file git tracks plus `release-manifest.txt`.
3. On the target: stop the service, unpack the 7z over the app folder, run `setup.bat`, start the service.

`setup.bat` does, in order: check Node, `npm install`, prune files that left the release, frontend install and build (fails if `frontend-dist\index.html` is missing), typecheck and tests, then check `.env` (copies `.env.example` if absent and lists what to fill in). `tests.bat` reruns only the checks.

Target constraints:
- **Node 22, 24, 25 or 26 only.** better-sqlite3 has prebuilt Windows binaries only for those; any other version tries to compile from source, and the target has no Python or build tools. `setup.bat` refuses other versions.
- **Unpacking never deletes.** That is why the manifest and `prune-stale.ts` exist: a leftover `.ts` file would otherwise break the typecheck.
- `.env`, `state.db` and `data/` live only on the target and are never in a release.
- The "Updating" section in `HOSTING.md` (xcopy) predates the 7z release; use the steps above.

## Git

- Remote `github`: `JSBlitta/modelbridge` (private). `main` is the released line.
- Development copy on a Linux host; a laptop can track it over SSH as well as through GitHub.
- `.gitignore` ignores `*.md` except the docs listed in it. Add a new doc there, or git will not see it.
