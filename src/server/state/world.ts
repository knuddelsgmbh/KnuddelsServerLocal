import { EventEmitter } from 'node:events';
import { PersistenceStore } from '../persistence/store.js';
import { appRegistry } from './app-registry.js';

export type SimUser = {
  userId: number;
  nick: string;
  gender: 'Male' | 'Female' | 'Unknown';
  age: number;
  status: 'Newbie' | 'Family' | 'Stammi' | 'HonoryMember' | 'Admin' | 'SystemBot' | 'Sysadmin';
  userType: 'Human' | 'AppBot' | 'SystemBot';
  isInChannel: boolean;
  /** True if this user owns the (single, simulated) channel — gates many App permission checks. */
  isChannelOwner: boolean;
  /** True if this user is an App-Manager (developer/admin of the app). */
  isAppManager: boolean;
  /** Knuddel-Saldo des Users in ganzen Knuddeln (Apps sehen diesen Wert über `user.getKnuddelAmount()`). */
  knuddel: number;
};

export const DEFAULT_KNUDDEL = 1000;

export type AppContentSpec = {
  sessionId: string;
  appId: string;
  userId: number;
  appViewMode: 'Popup' | 'Overlay' | 'Headerbar' | 'Global';
  width: number;
  height: number;
  responsive: boolean;
  assetPath: string;
  pageData: Record<string, unknown>;
};

export type LogEntry = {
  ts: number;
  appId: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  msg: string;
};

export type ChatLogEntry = {
  ts: number;
  appId: string;
  kind: 'public' | 'private' | 'action' | 'event' | 'post';
  fromUserId: number;
  toUserIds?: number[];
  text: string;
};

export type AppRecord = {
  appId: string;
  appDir: string;
  config: Record<string, string>;
  // The sandboxed App object — set after main.js executes.
  app?: any;
  context?: any;
  persistence: PersistenceStore;
  sessions: Map<string, AppContentSpec>;
  // Toplists registered by the app:
  toplists: Map<string, { displayName: string; ascending: boolean; labelMapping?: { [minValue: string]: string } }>;
};

class World extends EventEmitter {
  channelName = 'TestChannel';
  topic = 'Lokale Test-Umgebung';
  defaultBotUserId = 1;
  users: Map<number, SimUser> = new Map();
  apps: Map<string, AppRecord> = new Map();
  logs: LogEntry[] = [];
  chatLog: ChatLogEntry[] = [];
  // session id sequence
  private nextSessionId = 1;
  // user id sequence (for ad-hoc creation)
  nextUserId = 100;

  constructor() {
    super();
    this.setMaxListeners(0);
    this.seedDefaults();
  }

  private seedDefaults(): void {
    this.users.set(1, {
      userId: 1,
      nick: 'AppBot',
      gender: 'Unknown',
      age: 99,
      status: 'SystemBot',
      userType: 'AppBot',
      isInChannel: true,
      isChannelOwner: false,
      isAppManager: true,
      knuddel: DEFAULT_KNUDDEL,
    });
    [
      { nick: 'Anna',  gender: 'Female' as const, age: 27, owner: true,  appMgr: true  },
      { nick: 'Bjoern', gender: 'Male' as const, age: 32, owner: false, appMgr: false },
      { nick: 'Charlie', gender: 'Unknown' as const, age: 24, owner: false, appMgr: false },
    ].forEach((u, i) => {
      const id = 100 + i;
      this.users.set(id, {
        userId: id,
        nick: u.nick,
        gender: u.gender,
        age: u.age,
        status: 'Stammi',
        userType: 'Human',
        isInChannel: false,
        isChannelOwner: u.owner,
        isAppManager: u.appMgr,
        knuddel: DEFAULT_KNUDDEL,
      });
      this.nextUserId = Math.max(this.nextUserId, id + 1);
    });
  }

  // ---- emit helpers ----
  emitChange(): void { this.emit('change'); }
  log(entry: LogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > 1000) this.logs.shift();
    this.emit('log', entry);
  }
  chat(entry: ChatLogEntry): void {
    this.chatLog.push(entry);
    if (this.chatLog.length > 500) this.chatLog.shift();
    this.emit('chat', entry);
  }
  appContentShown(spec: AppContentSpec): void {
    const app = this.apps.get(spec.appId);
    app?.sessions.set(spec.sessionId, spec);
    this.emit('app-content-shown', spec);
  }
  appContentRemoved(sessionId: string, opts?: { replacing?: boolean }): void {
    const replacing = opts?.replacing ?? false;
    for (const a of this.apps.values()) {
      if (a.sessions.has(sessionId)) {
        a.sessions.delete(sessionId);
        break;
      }
    }
    this.emit('app-content-removed', { sessionId, replacing });
  }
  sendEventToSession(sessionId: string, type: string, data: unknown): void {
    this.emit('session-event', { sessionId, type, data });
  }

  // ---- session ids ----
  newSessionId(): string {
    return `sess-${this.nextSessionId++}`;
  }

  // ---- user lookup ----
  getUser(userId: number): SimUser | undefined {
    return this.users.get(userId);
  }
  getDefaultBot(): SimUser {
    return this.users.get(this.defaultBotUserId)!;
  }

  // ---- snapshot for UI ----
  snapshot() {
    return {
      channelName: this.channelName,
      topic: this.topic,
      defaultBotUserId: this.defaultBotUserId,
      users: Array.from(this.users.values()),
      apps: Array.from(this.apps.values()).map(a => {
        const reg = appRegistry.get(a.appId);
        return {
          appId: a.appId,
          appDir: a.appDir,
          config: a.config,
          sessions: Array.from(a.sessions.values()),
          // Whether the app is currently served live (ks start + yarn watch)
          // vs frozen from dist/. Only external apps with a repo root can.
          liveSource: reg?.liveSource ?? false,
          liveSourceAvailable: reg?.source === 'external' && !!reg.repoRoot,
        };
      }),
    };
  }
}

export const world = new World();
