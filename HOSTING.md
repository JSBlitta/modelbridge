# ModelBridge - Windows VM Hosting Guide

## Architecture

```
Internet / LAN
      |
      v
IIS (port 80/443)  ──  produuzit.blitta.nl
      |
      |  URL Rewrite + ARR
      v
Node.js (port 3000)  ──  API + static frontend
      |
      ├── /api/*          → Produuzit API / Trimble Connect API
      └── /*              → Vue frontend (static files)
```

The app runs as a Windows Service behind IIS reverse proxy.
IIS handles SSL, domain routing, and the Trimble OAuth callback.

## Prerequisites

### 1. Install Node.js LTS

Download the `.msi` installer from https://nodejs.org (v22+).
Check "Add to PATH" during install. Verify:

```powershell
node --version
```

### 2. Install NSSM

Download from https://nssm.cc/download.
Extract to `C:\Tools\nssm\`.
Add `C:\Tools\nssm\win64\` to system PATH.

### 3. IIS Modules

Install via Server Manager or PowerShell:

- URL Rewrite Module: https://www.iis.net/downloads/microsoft/url-rewrite
- Application Request Routing (ARR): https://www.iis.net/downloads/microsoft/application-request-routing

Enable ARR proxy in IIS Manager:
1. Open IIS Manager
2. Select the server node (not a site)
3. Double-click "Application Request Routing Cache"
4. Click "Server Proxy Settings" in the Actions pane
5. Check "Enable proxy" and click Apply

## Deploy the App

```powershell
# 1. Copy to permanent location
Copy-Item -Recurse .\webapp-ts C:\Apps\modelbridge

# 2. Install dependencies
cd C:\Apps\modelbridge
npm install --production

# 3. Create logs directory
New-Item -ItemType Directory -Force -Path logs

# 4. Configure environment
Copy-Item .env.example .env
notepad .env
# Fill in:
#   PRODUUZIT_REFRESH_TOKEN=<your token>
#   TRIMBLE_CLIENT_ID=<from Configuration.json>
#   TRIMBLE_CLIENT_SECRET=<from Configuration.json>
#   TRIMBLE_CALLBACK_URLS=https://produuzit.blitta.nl/api/trimble/auth/callback,http://localhost/api/trimble/auth/callback
#   REPORTING_REFRESH_TOKEN=<reporting account token>  (optional — reporting scheduler)

# 5. Build the Vue frontend (one-time, or after frontend changes)
cd ..\webapp\frontend
npm install
npm run build
xcopy /E /I /Y dist ..\..\webapp-ts\frontend-dist
cd ..\..\webapp-ts

# 6. Test it runs
npx tsx src/index.ts
# Should print: ModelBridge listening on http://localhost:3000
# Ctrl+C to stop
```

## Configure as Windows Service

```powershell
nssm install ModelBridge "C:\Program Files\nodejs\node.exe"
nssm set ModelBridge AppDirectory "C:\Apps\modelbridge"
nssm set ModelBridge AppParameters "node_modules\.bin\tsx" "src\index.ts"
nssm set ModelBridge Description "ModelBridge - Produuzit and Trimble Connect bridge"

# Auto-restart on crash
nssm set ModelBridge AppRestartDelay 5000

# Logging
nssm set ModelBridge AppStdout "C:\Apps\modelbridge\logs\stdout.log"
nssm set ModelBridge AppStderr "C:\Apps\modelbridge\logs\stderr.log"
nssm set ModelBridge AppRotateFiles 1
nssm set ModelBridge AppRotateBytes 1048576

# App-level logging (optional) — set in .env:
#   LOG_LEVEL=info                 # error | warn | info | debug
#   LOG_FILE=logs\app.log           # also append every log line to this file

# Auto-start with Windows
nssm set ModelBridge Start SERVICE_AUTO_START

# Start the service
nssm start ModelBridge
```

### Manage the Service

```powershell
nssm status ModelBridge       # Check status
nssm restart ModelBridge      # Restart after config changes
nssm stop ModelBridge         # Stop
nssm edit ModelBridge         # Edit settings (GUI)

# Or use services.msc — search for "ModelBridge"
```

## IIS Reverse Proxy

### Create IIS Site

1. Open IIS Manager
2. Right-click Sites > Add Website
   - Site name: `ModelBridge`
   - Physical path: `C:\Apps\modelbridge\frontend-dist`
   - Binding: `produuzit.blitta.nl` on port 80 (or 443 with SSL cert)

### Add web.config

Create `C:\Apps\modelbridge\frontend-dist\web.config`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="API Proxy" stopProcessing="true">
          <match url="^api/(.*)" />
          <action type="Rewrite" url="http://localhost:3000/api/{R:1}" />
        </rule>
        <rule name="SPA Fallback" stopProcessing="true">
          <match url=".*" />
          <conditions>
            <add input="{REQUEST_FILENAME}" matchType="IsFile" negate="true" />
            <add input="{REQUEST_FILENAME}" matchType="IsDirectory" negate="true" />
          </conditions>
          <action type="Rewrite" url="/" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
```

### Trimble OAuth via IIS

Trimble OAuth callback hits `https://produuzit.blitta.nl/api/trimble/auth/callback?code=...`.
IIS rewrites this to `http://localhost:3000/api/trimble/auth/callback?code=...`.
The app exchanges the code for a token. No port 80 listener needed.

Register these callback URLs at Trimble:
- `https://produuzit.blitta.nl/api/trimble/auth/callback`
- `http://localhost/api/trimble/auth/callback` (fallback for local dev)

## Updating

```powershell
nssm stop ModelBridge

# Copy new backend files
xcopy /E /I /Y .\webapp-ts\* C:\Apps\modelbridge\ /EXCLUDE:exclude.txt

# Install deps if package.json changed
cd C:\Apps\modelbridge
npm install --production

# Rebuild frontend if changed
cd ..\webapp\frontend
npm install
npm run build
xcopy /E /I /Y dist ..\..\webapp-ts\frontend-dist
cd ..\..\webapp-ts

nssm start ModelBridge
```

## Config Changes

- **Produuzit token rotation** (~January 2027): update `PRODUUZIT_REFRESH_TOKEN` in `.env`, restart service
- **Column synonyms / suffixes**: edit `config.yaml`, restart service
- **Trimble credentials**: update `.env`, restart service
- **Reporting schedule**: edit `data/produuzit_api_frequentie.csv`, restart service (or run `npm run reporting` manually)

Config is file-based only. There is no config editor in the web UI.

## Troubleshooting

### Service won't start
```powershell
# Check logs
Get-Content C:\Apps\modelbridge\logs\stderr.log -Tail 20

# Common: missing .env, missing node_modules
```

### 502 Bad Gateway from IIS
```powershell
# App not running
nssm status ModelBridge

# Check if port 3000 is listening
netstat -an | findstr 3000
```

### Trimble auth fails
- Verify callback URL is registered at Trimble
- Check that IIS ARR proxy is enabled (server-level, not site-level)
- Check `.env` has correct TRIMBLE_CLIENT_ID and TRIMBLE_CLIENT_SECRET

### Produuzit 401 errors
- Refresh token expired: get a new one and update `.env`
- The app auto-retries once on 401, but if the refresh token itself is expired, it will fail
