import * as fs from 'node:fs';
import * as path from 'node:path';
import { deriveAppIdFromPath } from './external-apps.js';

const STORE_FILE = path.resolve('.test-env/external-apps.json');

export type PersistedExternalApp = {
  path: string;
  appId: string;
};

type StoreShapeV2 = { entries: PersistedExternalApp[] };
type StoreShapeV1 = { paths: string[] };

function readStore(): StoreShapeV2 {
  try {
    if (!fs.existsSync(STORE_FILE)) return { entries: [] };
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoreShapeV2 & StoreShapeV1>;

    // V2: explicit {path, appId} entries.
    if (Array.isArray(parsed?.entries)) {
      const entries = parsed.entries
        .filter((e): e is PersistedExternalApp =>
          !!e && typeof e.path === 'string' && typeof e.appId === 'string'
        );
      return { entries };
    }

    // V1: legacy {paths: string[]}. Migrate by deriving the appId from the
    // folder basename. Skip paths whose basename isn't a valid appId — the
    // user can re-add them through the UI with an explicit name.
    if (Array.isArray(parsed?.paths)) {
      const migrated: PersistedExternalApp[] = [];
      for (const p of parsed.paths) {
        if (typeof p !== 'string') continue;
        const appId = deriveAppIdFromPath(p);
        if (!appId) {
          console.error(`[external-apps-store] cannot migrate ${p}: basename is not a valid appId — drop it and re-add via UI`);
          continue;
        }
        migrated.push({ path: p, appId });
      }
      writeStore({ entries: migrated });
      return { entries: migrated };
    }

    return { entries: [] };
  } catch (err) {
    console.error('[external-apps-store] failed to read; starting empty:', err);
    return { entries: [] };
  }
}

function writeStore(store: StoreShapeV2): void {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

export function loadPersistedExternalApps(): PersistedExternalApp[] {
  return readStore().entries;
}

export function persistExternalApp(entry: PersistedExternalApp): void {
  const store = readStore();
  if (!store.entries.some(e => e.path === entry.path)) {
    store.entries.push(entry);
    writeStore(store);
  }
}

export function unpersistExternalApp(absPath: string): void {
  const store = readStore();
  const next = store.entries.filter(e => e.path !== absPath);
  if (next.length !== store.entries.length) {
    writeStore({ entries: next });
  }
}
