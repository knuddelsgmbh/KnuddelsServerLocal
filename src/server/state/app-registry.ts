import * as path from 'node:path';

export type AppSource = 'internal' | 'external';

export type AppRegistryEntry = {
  appId: string;
  /** Where `main.js` + `www` live. For external hot-reload apps this is `<repoRoot>/dist`. */
  appDir: string;
  source: AppSource;
  /** Repo root of an external app (cwd for the spawned `ks start` / `yarn watch`). */
  repoRoot?: string;
  /**
   * When true, the app is served "live": frontend from the `ks start` dev-server
   * proxy (HMR) and backend from `yarn watch` (incremental rebuilds). When false,
   * the app is served frozen from the built `dist/` folder. Not to be confused
   * with the Knuddels platform's "hot reload" concept (which the app mocks as
   * always-on); this flag is purely about where THIS test-env reads the app from.
   */
  liveSource?: boolean;
  /** Port the spawned `ks start` dev server listens on (default 3100). */
  frontendDevPort?: number;
};

export function safeAppId(id: string): string | null {
  const trimmed = id.trim();
  if (!trimmed) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  return trimmed;
}

class AppRegistry {
  private byId = new Map<string, AppRegistryEntry>();

  register(entry: AppRegistryEntry): void {
    this.byId.set(entry.appId, entry);
  }

  unregister(appId: string): void {
    this.byId.delete(appId);
  }

  has(appId: string): boolean {
    return this.byId.has(appId);
  }

  get(appId: string): AppRegistryEntry | undefined {
    return this.byId.get(appId);
  }

  getAppDir(appId: string): string | undefined {
    return this.byId.get(appId)?.appDir;
  }

  entries(): AppRegistryEntry[] {
    return Array.from(this.byId.values());
  }

  // Longest-prefix match — needed because external appDirs can be arbitrary
  // and one could nest under another (rare, but cheap to handle correctly).
  findByPath(absPath: string): AppRegistryEntry | null {
    let best: AppRegistryEntry | null = null;
    for (const entry of this.byId.values()) {
      if (absPath === entry.appDir || absPath.startsWith(entry.appDir + path.sep)) {
        if (!best || entry.appDir.length > best.appDir.length) best = entry;
      }
    }
    return best;
  }
}

export const appRegistry = new AppRegistry();
