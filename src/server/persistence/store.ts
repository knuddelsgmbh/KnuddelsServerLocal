import * as fs from 'node:fs';
import * as path from 'node:path';

const PERSISTENCE_DIR = path.resolve('.test-env/persistence');

export type Slot = { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'object'; value: unknown };

type AppData = Record<string, Slot>;

export class PersistenceStore {
  private data: AppData = {};
  private filePath: string;
  private writeQueued = false;
  /**
   * Optional change hook fired AFTER each mutation. Receives the full scoped
   * key, the prior slot (or null), and the new slot (or null on delete).
   * Used by the API layer to drive Toplist rank/label-change listeners.
   */
  onChange?: (key: string, oldSlot: Slot | null, newSlot: Slot | null) => void;

  constructor(public readonly appId: string) {
    fs.mkdirSync(PERSISTENCE_DIR, { recursive: true });
    this.filePath = path.join(PERSISTENCE_DIR, `${appId}.json`);
    this.load();
  }

  private notify(key: string, oldSlot: Slot | undefined, newSlot: Slot | undefined): void {
    if (!this.onChange) return;
    try { this.onChange(key, oldSlot ?? null, newSlot ?? null); }
    catch (err) { console.error(`[persistence] onChange threw for ${key}:`, err); }
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.data = {};
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.data = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      console.error(`[persistence] failed to load ${this.filePath}:`, err);
      this.data = {};
    }
  }

  private scheduleWrite(): void {
    if (this.writeQueued) return;
    this.writeQueued = true;
    queueMicrotask(() => {
      this.writeQueued = false;
      this.flush();
    });
  }

  flush(): void {
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  reloadFromDisk(): void {
    this.load();
  }

  // App-scoped keys: `app:<key>`. User-scoped: `user:<userId>:<key>`.
  private appKey(key: string): string {
    return `app:${key}`;
  }

  private userKey(userId: number, key: string): string {
    return `user:${userId}:${key}`;
  }

  // ---- generic accessors ----
  getNumber(scopedKey: string, def: number = 0): number {
    const slot = this.data[scopedKey];
    return slot?.kind === 'number' ? slot.value : def;
  }
  setNumber(scopedKey: string, value: number): void {
    const old = this.data[scopedKey];
    const slot: Slot = { kind: 'number', value };
    this.data[scopedKey] = slot;
    this.scheduleWrite();
    this.notify(scopedKey, old, slot);
  }
  hasNumber(scopedKey: string): boolean {
    return this.data[scopedKey]?.kind === 'number';
  }
  deleteNumber(scopedKey: string): void {
    if (this.hasNumber(scopedKey)) {
      const old = this.data[scopedKey];
      delete this.data[scopedKey];
      this.scheduleWrite();
      this.notify(scopedKey, old, undefined);
    }
  }
  addNumber(scopedKey: string, value: number): number {
    const current = this.getNumber(scopedKey, 0);
    const next = current + value;
    this.setNumber(scopedKey, next);
    return next;
  }

  getString(scopedKey: string, def: string = ''): string {
    const slot = this.data[scopedKey];
    return slot?.kind === 'string' ? slot.value : def;
  }
  setString(scopedKey: string, value: string): void {
    this.data[scopedKey] = { kind: 'string', value };
    this.scheduleWrite();
  }
  hasString(scopedKey: string): boolean {
    return this.data[scopedKey]?.kind === 'string';
  }
  deleteString(scopedKey: string): void {
    if (this.hasString(scopedKey)) {
      delete this.data[scopedKey];
      this.scheduleWrite();
    }
  }

  getObject(scopedKey: string, def: unknown = null): unknown {
    const slot = this.data[scopedKey];
    return slot?.kind === 'object' ? slot.value : def;
  }
  setObject(scopedKey: string, value: unknown): void {
    this.data[scopedKey] = { kind: 'object', value };
    this.scheduleWrite();
  }
  hasObject(scopedKey: string): boolean {
    return this.data[scopedKey]?.kind === 'object';
  }
  deleteObject(scopedKey: string): void {
    if (this.hasObject(scopedKey)) {
      delete this.data[scopedKey];
      this.scheduleWrite();
    }
  }

  // ---- key listings ----
  private keysOfKind(kind: Slot['kind'], prefix: string, pattern?: string): string[] {
    const re = pattern ? globToRegExp(pattern) : null;
    return Object.keys(this.data)
      .filter(k => k.startsWith(prefix))
      .filter(k => this.data[k]?.kind === kind)
      .map(k => k.slice(prefix.length))
      .filter(k => !re || re.test(k));
  }

  getNumberKeysApp(pattern?: string): string[] {
    return this.keysOfKind('number', 'app:', pattern);
  }
  getStringKeysApp(pattern?: string): string[] {
    return this.keysOfKind('string', 'app:', pattern);
  }
  getObjectKeysApp(pattern?: string): string[] {
    return this.keysOfKind('object', 'app:', pattern);
  }

  // ---- user-scoped helpers ----
  appKeyOf(key: string): string { return this.appKey(key); }
  userKeyOf(userId: number, key: string): string { return this.userKey(userId, key); }

  deleteAllForUser(userId: number, kind?: Slot['kind']): number {
    const prefix = `user:${userId}:`;
    let count = 0;
    const removed: { key: string; old: Slot }[] = [];
    for (const key of Object.keys(this.data)) {
      if (!key.startsWith(prefix)) continue;
      if (kind && this.data[key]?.kind !== kind) continue;
      removed.push({ key, old: this.data[key]! });
      delete this.data[key];
      count++;
    }
    if (count) this.scheduleWrite();
    for (const r of removed) this.notify(r.key, r.old, undefined);
    return count;
  }

  deleteAllApp(): number {
    let count = 0;
    for (const key of Object.keys(this.data)) {
      if (!key.startsWith('app:')) continue;
      delete this.data[key];
      count++;
    }
    if (count) this.scheduleWrite();
    return count;
  }

  deleteAllUsers(): number {
    let count = 0;
    for (const key of Object.keys(this.data)) {
      if (!key.startsWith('user:')) continue;
      delete this.data[key];
      count++;
    }
    if (count) this.scheduleWrite();
    return count;
  }

  clearAll(): number {
    const count = Object.keys(this.data).length;
    if (count) {
      this.data = {};
      this.scheduleWrite();
    }
    return count;
  }

  // Drop every `user:<id>:*` key whose `<id>` is not in `validUserIds`.
  // Used on server start to reconcile the disk store against the freshly
  // seeded `world.users` — recovers from sessions that ended without
  // running the simulation cleanup path (hard kill, crash).
  pruneUserKeysExcept(validUserIds: Set<number>): { prunedKeys: string[] } {
    const removed: string[] = [];
    for (const key of Object.keys(this.data)) {
      const m = /^user:(\d+):/.exec(key);
      if (!m) continue;
      const uid = parseInt(m[1]!, 10);
      if (!validUserIds.has(uid)) {
        delete this.data[key];
        removed.push(key);
      }
    }
    if (removed.length) this.scheduleWrite();
    return { prunedKeys: removed };
  }

  // ---- introspection (used by debug-ui) ----
  snapshot(): AppData {
    return { ...this.data };
  }
  setRaw(key: string, slot: Slot): void {
    const old = this.data[key];
    this.data[key] = slot;
    this.scheduleWrite();
    this.notify(key, old, slot);
  }
  deleteRaw(key: string): void {
    const old = this.data[key];
    delete this.data[key];
    this.scheduleWrite();
    if (old) this.notify(key, old, undefined);
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + re + '$');
}
