import crossSpawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { world } from '../state/world.js';

export const DEFAULT_FRONTEND_DEV_PORT = 3100;

/** Dir holding the no-op `react-devtools` stub (see stubs/react-devtools.cmd). */
const STUB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stubs');

export type HotReloadTarget = {
  appId: string;
  /** Repo root used as cwd for the spawned processes. */
  repoRoot: string;
  /** Port `ks start` listens on. */
  devPort: number;
};

type Managed = {
  appId: string;
  /** `ks start` — webpack-dev-server with React Fast Refresh (frontend HMR). */
  frontend?: ChildProcess;
  /** `yarn watch` — incremental webpack build of dist/main.js (backend). */
  backend?: ChildProcess;
};

const managed = new Map<string, Managed>();

/**
 * Spawn (and supervise) the two watch processes that back "Live Source" mode:
 *   - `ks start` (frontend dev server, proxied by the test-env with HMR)
 *   - `yarn watch` (incremental backend build → dist/main.js, picked up by the file watcher)
 * Idempotent per appId. The backend watcher starts immediately; the frontend
 * dev server starts only once we've confirmed its port is free (otherwise
 * `ks start` would silently pick another port and the proxy would desync).
 */
export function startLiveSource(t: HotReloadTarget): void {
  if (managed.has(t.appId)) return;
  const m: Managed = { appId: t.appId };
  managed.set(t.appId, m);

  log(t.appId, 'info', `[live-source] starting (repo=${t.repoRoot}, devPort=${t.devPort})`);
  spawnBackend(t, m);

  void isPortFree(t.devPort).then(free => {
    if (!managed.has(t.appId)) return; // stopped meanwhile
    if (!free) {
      log(
        t.appId,
        'error',
        `[live-source] frontend dev port ${t.devPort} is already in use — not starting \`ks start\`. ` +
          `Free the port or set a different frontendDevPort, then toggle Live Source again.`,
      );
      return;
    }
    spawnFrontend(t, m);
    // Once the dev server starts answering, reload the iframes so they swap
    // from the "booting…" placeholder to the live HMR build automatically.
    void waitForPort(t.devPort, m).then(up => {
      if (up && managed.has(t.appId)) {
        log(t.appId, 'info', `[live-source] dev server ready on :${t.devPort}`);
        world.emit('frontend-changed', t.appId);
      }
    });
  });
}

export function stopLiveSource(appId: string): void {
  const m = managed.get(appId);
  if (!m) return;
  managed.delete(appId);
  killTree(m.frontend);
  killTree(m.backend);
  log(appId, 'info', `[live-source] stopped`);
}

export function stopAllLiveSource(): void {
  for (const appId of Array.from(managed.keys())) stopLiveSource(appId);
}

/** True while the test-env is actively managing watch processes for this app. */
export function isLiveSourceRunning(appId: string): boolean {
  return managed.has(appId);
}

// ---- internals ---------------------------------------------------------------

function spawnFrontend(t: HotReloadTarget, m: Managed): void {
  const ksBin = path.join(
    t.repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'ks.cmd' : 'ks',
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(t.devPort),
    // Don't auto-open a browser tab; the iframe consumes the dev server.
    BROWSER: 'none',
    // Make the dev server emit asset URLs under /app/<appId>/… so they
    // round-trip through the test-env proxy on a single origin.
    PUBLIC_URL: `/app/${t.appId}`,
    // Point React Fast Refresh's websocket straight at the dev server,
    // bypassing the proxy (which then only has to handle plain HTTP).
    WDS_SOCKET_HOST: 'localhost',
    WDS_SOCKET_PORT: String(t.devPort),
    HTTPS: 'false',
    FORCE_COLOR: '0',
  };
  // `ks start` spawns `react-devtools` with no error handler; prepend our stub
  // dir so that spawn resolves to a no-op instead of crashing the dev server.
  prependToPath(env, STUB_DIR);

  const child = crossSpawn(ksBin, ['start'], { cwd: t.repoRoot, env });
  m.frontend = child;
  pipeLogs(t.appId, '[ks]', child);
  child.on('exit', code => log(t.appId, code ? 'error' : 'info', `[ks] exited (code ${code})`));
}

function spawnBackend(t: HotReloadTarget, m: Managed): void {
  // Which yarn script runs the incremental backend build. Defaults to `watch`;
  // a launcher can override it via KS_BACKEND_WATCH_SCRIPT. The Crash repo's
  // `watch` script brackets webpack with `update-version-timestamp.js` (set →
  // build → reset), but because `webpack --watch` never returns, the trailing
  // reset never runs and the version file is left dirty. `yarn start-local`
  // therefore points this at a `watch-local` script that skips versioning
  // entirely — matching classic `yarn start`, which never touches it.
  const script = process.env.KS_BACKEND_WATCH_SCRIPT?.trim() || 'watch';
  const child = crossSpawn('yarn', [script], {
    cwd: t.repoRoot,
    env: { ...process.env, NODE_ENV: 'development', BUILD_MODE: 'fast', FORCE_COLOR: '0' },
  });
  m.backend = child;
  pipeLogs(t.appId, '[webpack]', child);
  child.on('exit', code => log(t.appId, code ? 'error' : 'info', `[webpack] exited (code ${code})`));
}

function pipeLogs(appId: string, prefix: string, child: ChildProcess): void {
  const onData = (level: 'info' | 'error') => (buf: Buffer) => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (trimmed) log(appId, level, `${prefix} ${trimmed}`);
    }
  };
  child.stdout?.on('data', onData('info'));
  child.stderr?.on('data', onData('error'));
  child.on('error', err => log(appId, 'error', `${prefix} spawn error: ${err.message}`));
}

/** Prepend a directory to the env's PATH, handling Windows' `Path` casing. */
function prependToPath(env: NodeJS.ProcessEnv, dir: string): void {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
  env[key] = dir + path.delimiter + (env[key] ?? '');
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/** Resolve once something accepts a TCP connection on `port` (i.e. `ks start`
 * is up), or `false` if the managed entry goes away / we give up. Polls for up
 * to ~2 minutes — first-time webpack builds can be slow. */
function waitForPort(port: number, m: Managed, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const tick = () => {
      if (!managed.has(m.appId) || m !== managed.get(m.appId)) return resolve(false);
      if (Date.now() > deadline) return resolve(false);
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); setTimeout(tick, 500); });
    };
    tick();
  });
}

/** Kill the process and its children. cross-spawn'd shells (.cmd / yarn) spawn
 * grandchildren that a plain SIGTERM wouldn't reap, so on Windows we use taskkill. */
function killTree(child?: ChildProcess): void {
  if (!child || child.killed || child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    crossSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  } else {
    child.kill('SIGTERM');
  }
}

function log(appId: string, level: 'info' | 'warn' | 'error', msg: string): void {
  world.log({ ts: Date.now(), appId, level, msg });
  // Mirror to the server console so the watch processes are visible in the
  // same terminal as `npm run dev` (world.log only reaches the debug-ui panel).
  const line = `[${appId}] ${msg}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}
