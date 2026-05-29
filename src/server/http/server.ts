import express from 'express';
import http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { world } from '../state/world.js';
import { appRegistry } from '../state/app-registry.js';
import { clientShimSource } from './client-shim.js';
import { handleDevProxy } from './dev-proxy.js';
import { DEFAULT_FRONTEND_DEV_PORT } from '../dev/process-manager.js';
import { attachWsServer } from './ws-bridge.js';
import { registerDebugApi } from './debug-api.js';
import { registerSimulationApi } from '../simulation/api.js';

const PORT = Number(process.env.PORT ?? 3000);

export function startHttpServer(): void {
  const app = express();
  // Generous limit so users can drop in apps with media assets via base64.
  app.use(express.json({ limit: '50mb' }));

  // Serve UserApp HTML with the Client-shim injected.
  app.get('/app/:appId/*', (req, res) => {
    const appId = req.params.appId;
    const rec = world.apps.get(appId);
    if (!rec) return res.status(404).send('app not loaded');

    // Live Source apps: serve the frontend from the `ks start` dev server (HMR)
    // instead of the built dist/www, injecting the local Client shim.
    const entry = appRegistry.get(appId);
    if (entry?.liveSource) {
      return handleDevProxy(req, res, {
        appId,
        rec,
        devPort: entry.frontendDevPort ?? DEFAULT_FRONTEND_DEV_PORT,
      });
    }

    const appDir = appRegistry.getAppDir(appId);
    if (!appDir) return res.status(404).send('app not loaded');
    const wwwDir = path.join(appDir, 'www');
    const subPath = (req.params as any)['0'] ?? '';
    const fullPath = path.join(wwwDir, subPath);
    if (fullPath !== wwwDir && !fullPath.startsWith(wwwDir + path.sep)) return res.status(400).send('bad path');
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return res.status(404).send('not found');
    }

    if (fullPath.endsWith('.html') || fullPath.endsWith('.htm')) {
      const sessionId = String(req.query.sessionId ?? '');
      const userId = Number(req.query.userId ?? world.defaultBotUserId);
      const sim = world.users.get(userId);
      const spec = rec.sessions.get(sessionId);
      const html = fs.readFileSync(fullPath, 'utf8');
      const shim = clientShimSource({
        sessionId,
        appId,
        nick: sim?.nick ?? 'Unknown',
        pageData: (spec?.pageData as Record<string, unknown>) ?? {},
        wsUrl: `ws://${req.headers.host}/__ws?channel=iframe&sessionId=${encodeURIComponent(sessionId)}`,
      });
      const inject = `<script>${shim}</script>`;
      const injected = html.includes('</head>')
        ? html.replace('</head>', `${inject}\n</head>`)
        : `${inject}\n${html}`;
      res.set('Cache-Control', 'no-store').type('html').send(injected);
      return;
    }

    res.set('Cache-Control', 'no-store').sendFile(fullPath);
  });

  registerDebugApi(app);
  registerSimulationApi(app);

  // Health check
  app.get('/api/state', (_req, res) => res.json(world.snapshot()));

  // Root just shows a small index page pointing at the debug-ui dev server.
  app.get('/', (_req, res) => {
    res.type('html').send(`
      <!doctype html>
      <html><head><title>KnuddelsServer Test-Env</title>
      <style>body{font-family:system-ui;padding:2rem;max-width:720px;margin:auto;background:#0c0d10;color:#e6e7ea}
      a{color:#7aa7ff} h1{margin-top:0}</style>
      </head><body>
      <h1>Knuddels UserApps Test-Umgebung</h1>
      <p>Test-Server läuft auf <code>:${PORT}</code>. Die <strong>Debug-UI</strong> findest du unter
      <a href="http://localhost:5173">http://localhost:5173</a>.</p>
      <p>Lade Apps in <code>./apps/&lt;app-id&gt;/</code> ab und sie werden automatisch geladen.
      Externe App-Ordner können über die Env-Var <code>KS_EXTERNAL_APPS</code> (komma-separierte absolute Pfade) eingebunden werden.</p>
      <p>Aktuell geladene Apps: <strong>${Array.from(world.apps.keys()).join(', ') || '(keine)'}</strong></p>
      </body></html>
    `);
  });

  const server = http.createServer(app);
  attachWsServer(server);
  server.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    console.log(`[server] debug-ui:    http://localhost:5173`);
  });
}
