import { EventEmitter } from 'node:events';
import { PersistenceStore } from '../persistence/store.js';
import { appRegistry } from './app-registry.js';

export type SimGender = 'Male' | 'Female' | 'Unknown';
export type SimGenderDetailed = 'Male' | 'Female' | 'NonBinaryHe' | 'NonBinaryShe' | 'Unknown';
export type SimUserStatus = 'Newbie' | 'Family' | 'Stammi' | 'HonoryMember' | 'Admin' | 'SystemBot' | 'Sysadmin';
export type SimUserType = 'Human' | 'AppBot' | 'SystemBot';
export type SimClientType = 'Applet' | 'Browser' | 'Android' | 'IOS' | 'Offline' | 'Web' | 'MobileWeb';
export type SimChannelTalkPermission = 'NotInChannel' | 'Default' | 'TalkOnce' | 'TalkPermanent' | 'VIP' | 'Moderator';
export type SimAuthenticityClassification = 'ServiceNotAvailable' | 'Unknown' | 'Trusted' | 'VeryTrusted';

export type SimUser = {
  userId: number;
  nick: string;
  gender: SimGender;
  age: number;
  status: SimUserStatus;
  userType: SimUserType;
  isInChannel: boolean;
  /** True if this user owns the (single, simulated) channel — gates many App permission checks. */
  isChannelOwner: boolean;
  /** True if this user is an App-Manager (developer/admin of the app). */
  isAppManager: boolean;

  // — Client connection
  clientType: SimClientType;
  isK3Client: boolean;

  // — Identity (extended)
  genderDetailed: SimGenderDetailed;
  profilePhoto: string;
  hasProfilePhoto: boolean;
  isProfilePhotoVerified: boolean;
  readme: string;
  isAgeVerified: boolean;
  authenticityClassification: SimAuthenticityClassification;

  // — Time / activity (unix-ms for dates)
  onlineMinutes: number;
  regDate: number;
  lastOnlineTime: number;

  // — Channel role / permissions (independent flags)
  isChannelModerator: boolean;
  isChannelCoreUser: boolean;
  isEventModerator: boolean;
  isInTeam: boolean;
  channelTalkPermission: SimChannelTalkPermission;

  // — State flags
  isAway: boolean;
  isLocked: boolean;
  isMuted: boolean;
  isColorMuted: boolean;
  isLikingChannel: boolean;
  isStreamingVideo: boolean;

  // — Knuddel (in Knuddel-Einheiten, nicht Cents)
  knuddelAmount: number;
  maxKnuddelToApp: number;

  /**
   * Per-app nicklist icons set via `User.addNicklistIcon`. Outer key = appId,
   * each entry one icon registration. Cleared when the owning app is unloaded.
   */
  nicklistIcons?: { [appId: string]: { imagePath: string; imageWidth: number }[] };
};

/**
 * Defaults for all extended SimUser fields. Values match the previously
 * hardcoded behavior of `makeUser()` in src/server/api/index.ts so adding
 * the fields doesn't change runtime behavior for existing apps.
 */
export function defaultUserFields(opts?: { gender?: SimGender; isChannelOwner?: boolean }): Pick<
  SimUser,
  | 'clientType' | 'isK3Client'
  | 'genderDetailed' | 'profilePhoto' | 'hasProfilePhoto' | 'isProfilePhotoVerified'
  | 'readme' | 'isAgeVerified' | 'authenticityClassification'
  | 'onlineMinutes' | 'regDate' | 'lastOnlineTime'
  | 'isChannelModerator' | 'isChannelCoreUser' | 'isEventModerator' | 'isInTeam'
  | 'channelTalkPermission'
  | 'isAway' | 'isLocked' | 'isMuted' | 'isColorMuted' | 'isLikingChannel' | 'isStreamingVideo'
  | 'knuddelAmount' | 'maxKnuddelToApp'
> {
  const gender = opts?.gender ?? 'Unknown';
  const owner = opts?.isChannelOwner ?? false;
  const now = Date.now();
  return {
    clientType: 'Web',
    isK3Client: true,
    genderDetailed: gender,
    profilePhoto: '',
    hasProfilePhoto: false,
    isProfilePhotoVerified: false,
    readme: '',
    isAgeVerified: true,
    authenticityClassification: 'Trusted',
    onlineMinutes: 0,
    regDate: now - 1000 * 60 * 60 * 24 * 30,
    lastOnlineTime: now,
    isChannelModerator: owner,
    isChannelCoreUser: owner,
    isEventModerator: false,
    isInTeam: false,
    channelTalkPermission: 'Default',
    isAway: false,
    isLocked: false,
    isMuted: false,
    isColorMuted: false,
    isLikingChannel: true,
    isStreamingVideo: false,
    knuddelAmount: 1000,
    maxKnuddelToApp: 10000,
  };
}

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
  // Mutable frame-level state set by the iframe via `Client.getHostFrame().*`.
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  resizable?: boolean;
  backgroundColor?: string;
  backgroundColorTransitionMs?: number;
  iconUrl?: string;
  title?: string;
  /** Loading-screen configuration set via `AppContent.getLoadConfiguration()`. */
  loadConfig?: LoadConfigSpec;
};

export type LoadConfigSpec = {
  enabled: boolean;
  backgroundColor: string | null;
  backgroundImage: string;
  loadingIndicatorImage: string;
  foregroundColor: string | null;
  text: string;
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
  kind: 'public' | 'private' | 'action' | 'event' | 'post' | 'in-app';
  fromUserId: number;
  toUserIds?: number[];
  text: string;
  /** Only set for kind === 'in-app': the chat-group identifier passed by the app. */
  chatGroupId?: string;
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
  // AppProfileEntries registered by the app, keyed by their toplist key:
  profileEntries: Map<string, { displayType: string }>;
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
  // monotonic per-app version, bumped on every frontend change. Used to power
  // a stable `Client.getCacheInvalidationId()` per iframe load.
  private frontendVersions: Map<string, number> = new Map();

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
      ...defaultUserFields({ gender: 'Unknown', isChannelOwner: false }),
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
        ...defaultUserFields({ gender: u.gender, isChannelOwner: u.owner }),
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
  updateAppContentSpec(sessionId: string, patch: Partial<AppContentSpec>): AppContentSpec | undefined {
    for (const a of this.apps.values()) {
      const cur = a.sessions.get(sessionId);
      if (!cur) continue;
      const next = { ...cur, ...patch };
      a.sessions.set(sessionId, next);
      this.emit('app-content-updated', next);
      return next;
    }
    return undefined;
  }
  bumpFrontendVersion(appId: string): number {
    const n = (this.frontendVersions.get(appId) ?? 0) + 1;
    this.frontendVersions.set(appId, n);
    return n;
  }
  getFrontendVersion(appId: string): number {
    return this.frontendVersions.get(appId) ?? 0;
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
