import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeAppId } from '../state/app-registry.js';

export type ExternalAppPath = {
  /** Absolute, normalized path to the app's repo ROOT (the folder the user registers). */
  repoRoot: string;
  /** Absolute path to the built artifacts — derived as `<repoRoot>/dist` — where `main.js` + `www` live. */
  appDir: string;
  /** Absolute path of the parent dir — what chokidar actually watches so we can pick the `dist/` folder up once it's built. Equals `repoRoot`. */
  parentDir: string;
};

export type ExternalAppEntry = ExternalAppPath & {
  /** The appId under which the external folder will be registered. */
  appId: string;
  /**
   * When true ("Live Source"), the test-env spawns `ks start` + `yarn watch`
   * for this app and serves the frontend via the dev-server proxy (HMR) while
   * the backend rebuilds incrementally. When false/absent, the app is served
   * frozen from the built `dist/` folder.
   */
  liveSource?: boolean;
  /** Port the spawned `ks start` dev server listens on (default 3100). */
  frontendDevPort?: number;
};

export type ValidationResult =
  | { ok: true; value: ExternalAppPath }
  | { ok: false; error: string };

/**
 * Validate a single user-supplied path. The path is the app's REPO ROOT; the
 * built artifacts (`main.js` + `www`) are derived as `<repoRoot>/dist`. The
 * `dist/` folder may not exist yet (build hasn't run), so we watch the repo
 * root itself (`parentDir`) and pick `dist/` up once it appears. Resolves
 * symlinks so the path matches what the OS-level watcher reports (e.g. macOS
 * FSEvents emits /private/tmp/... not /tmp/...).
 */
export function validateExternalAppPath(rawPath: string, appsRoot: string): ValidationResult {
  const trimmed = rawPath.trim();
  if (!trimmed) return { ok: false, error: 'path is empty' };
  if (!path.isAbsolute(trimmed)) return { ok: false, error: `path must be absolute: ${trimmed}` };

  const abs = realpathOfNearestExisting(trimmed);

  if (abs === appsRoot || abs.startsWith(appsRoot + path.sep)) {
    return { ok: false, error: `path lies under apps/ root, would cause double-watching: ${abs}` };
  }

  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { ok: false, error: `repo root does not exist or is not a directory: ${abs}` };
  }

  const appDir = path.join(abs, 'dist');
  return { ok: true, value: { repoRoot: abs, appDir, parentDir: abs } };
}

/**
 * Best-effort: derive an appId from a folder path's basename. Used when no
 * explicit appId was provided (env-var without `=` syntax, or legacy persisted
 * entries pre-dating the explicit-appId schema).
 */
export function deriveAppIdFromPath(absPath: string): string | null {
  return safeAppId(path.basename(absPath));
}

/**
 * Parse KS_EXTERNAL_APPS into a list of validated, deduplicated app entries.
 *
 * Supported piece syntaxes:
 *   - `<path>`            → appId = basename(path)
 *   - `<appId>=<path>`    → explicit appId
 *
 * Invalid pieces are logged and skipped (env-var bootstrap is best-effort).
 */
export function parseExternalAppsEnv(raw: string | undefined, appsRoot: string): ExternalAppEntry[] {
  if (!raw) return [];
  const out: ExternalAppEntry[] = [];
  const seenDir = new Set<string>();
  const seenId = new Set<string>();
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;

    const { rawPath, explicitAppId } = splitEnvPiece(trimmed);
    const result = validateExternalAppPath(rawPath, appsRoot);
    if (!result.ok) {
      console.error(`[external-apps] skipping ${trimmed}: ${result.error}`);
      continue;
    }
    const appId = explicitAppId ?? deriveAppIdFromPath(result.value.appDir);
    if (!appId) {
      console.error(`[external-apps] skipping ${trimmed}: cannot derive valid appId from basename (use 'appId=path' syntax)`);
      continue;
    }
    if (seenDir.has(result.value.appDir)) continue;
    if (seenId.has(appId)) {
      console.error(`[external-apps] skipping ${trimmed}: appId '${appId}' already used by another env entry`);
      continue;
    }
    seenDir.add(result.value.appDir);
    seenId.add(appId);
    out.push({ ...result.value, appId });
  }
  return out;
}

function splitEnvPiece(piece: string): { rawPath: string; explicitAppId: string | null } {
  // Tolerant: only treat `=` as a separator if the LHS is a valid appId AND
  // the RHS looks like an absolute path. This keeps Windows paths like
  // `C:\foo\bar` working unchanged when no appId override is given.
  const eq = piece.indexOf('=');
  if (eq <= 0) return { rawPath: piece, explicitAppId: null };
  const lhs = piece.slice(0, eq).trim();
  const rhs = piece.slice(eq + 1).trim();
  const id = safeAppId(lhs);
  if (id && path.isAbsolute(rhs)) return { rawPath: rhs, explicitAppId: id };
  return { rawPath: piece, explicitAppId: null };
}

function realpathOfNearestExisting(p: string): string {
  // Walk up until we find an existing ancestor, realpath it, then re-append the missing tail.
  const segs = p.split(path.sep);
  for (let i = segs.length; i > 0; i--) {
    const candidate = segs.slice(0, i).join(path.sep) || path.sep;
    if (fs.existsSync(candidate)) {
      const real = fs.realpathSync(candidate);
      const tail = segs.slice(i).join(path.sep);
      return tail ? path.join(real, tail) : real;
    }
  }
  return p;
}
