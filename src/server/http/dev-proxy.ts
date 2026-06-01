import type { Request, Response } from 'express';
import * as http from 'node:http';
import { world, AppRecord } from '../state/world.js';
import { clientShimSource } from './client-shim.js';

/**
 * Proxy an `/app/:appId/*` request to the app's `ks start` dev server (frontend
 * HMR). For the HTML entry we rewrite the response: strip the real Knuddels API
 * loader and inject the local `Client` shim, so the live-reloading frontend talks
 * to the LOCAL sandbox over `/__ws` instead of Knuddels infra. Everything else
 * (JS/CSS chunks, modernizr.js, hot-update files) is streamed through unchanged.
 *
 * The React Fast Refresh websocket connects directly to the dev server
 * (WDS_SOCKET_PORT), so this proxy only ever sees plain HTTP.
 */
export function handleDevProxy(
  req: Request,
  res: Response,
  opts: { appId: string; rec: AppRecord; devPort: number },
): void {
  const { appId, rec, devPort } = opts;

  // The dev server is configured with PUBLIC_URL=/app/<appId>, so it serves
  // under the same path the iframe requests — forward the URL as-is.
  const proxyReq = http.request(
    {
      host: '127.0.0.1',
      port: devPort,
      method: req.method,
      path: req.originalUrl,
      // Force identity encoding so we can safely rewrite the HTML response
      // (the dev server has compression enabled).
      headers: { ...req.headers, host: `localhost:${devPort}`, 'accept-encoding': 'identity' },
    },
    proxyRes => {
      const contentType = String(proxyRes.headers['content-type'] ?? '');

      if (contentType.includes('text/html')) {
        const chunks: Buffer[] = [];
        proxyRes.on('data', c => chunks.push(c as Buffer));
        proxyRes.on('end', () => {
          const html = injectShim(Buffer.concat(chunks).toString('utf8'), req, appId, rec);
          const headers = { ...proxyRes.headers };
          delete headers['content-length'];
          delete headers['content-encoding'];
          headers['cache-control'] = 'no-store';
          res.writeHead(proxyRes.statusCode ?? 200, headers);
          res.end(html);
        });
        proxyRes.on('error', () => {
          if (!res.headersSent) res.status(502).type('text/plain').send('dev server stream error');
        });
        return;
      }

      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', err => {
    if (!res.headersSent) {
      res
        .status(502)
        .type('text/plain')
        .send(
          `[${appId}] frontend dev server not reachable on :${devPort} — is \`ks start\` still booting?\n${err}`,
        );
    }
  });

  // Forward a request body if present (the frontend only GETs, but be safe).
  req.pipe(proxyReq);
}

function injectShim(html: string, req: Request, appId: string, rec: AppRecord): string {
  // Remove every form of the real Knuddels client API loader so it can't
  // overwrite our shim. `ks start` emits BOTH:
  //   1. a static <script src="…/knuddels-api.js"> tag, and
  //   2. an inline <script> that document.write()s the cdnc apploader
  //      (from @knuddels/.../systemAppHotreloading.js).
  const stripped = html
    .replace(/<script\b[^>]*\bsrc=["'][^"']*knuddels-api\.js[^"']*["'][^>]*>\s*<\/script>/gi, '')
    .replace(
      /<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?knuddels-api\.js(?:(?!<\/script>)[\s\S])*?<\/script>/gi,
      '',
    );

  const sessionId = String(req.query.sessionId ?? '');
  const userId = Number(req.query.userId ?? world.defaultBotUserId);
  const sim = world.users.get(userId);
  const spec = rec.sessions.get(sessionId);
  const shim = clientShimSource({
    sessionId,
    appId,
    nick: sim?.nick ?? 'Unknown',
    pageData: (spec?.pageData as Record<string, unknown>) ?? {},
    appViewMode: spec?.appViewMode ?? 'Popup',
    cacheInvalidationId: `${appId}-${world.getFrontendVersion(appId)}`,
    wsUrl: `ws://${req.headers.host}/__ws?channel=iframe&sessionId=${encodeURIComponent(sessionId)}`,
    clientType: sim?.clientType ?? 'Web',
    isK3Client: sim?.isK3Client ?? true,
  });
  const tag = `<script>${shim}</script>`;

  return stripped.includes('</head>')
    ? stripped.replace('</head>', `${tag}\n</head>`)
    : `${tag}\n${stripped}`;
}
