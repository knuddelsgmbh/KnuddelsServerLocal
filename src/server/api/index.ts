/**
 * Builds the bag of globals that get injected into a UserApp's vm context.
 * Each call returns a fresh set bound to the given AppRecord — apps are
 * isolated from each other.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { world, AppRecord, AppContentSpec, SimUser } from '../state/world.js';

// Standard Knuddel-Shop packages (amount of Knuddel ↔ price in euro-cents).
// These mirror the real Knuddels knuddel shop so apps that read
// `KnuddelShopProduct.getOrigKnuddelPayout()` (e.g. Crash, which keys its
// purchase bonuses on the package amount) behave correctly in the sim.
const KNUDDEL_SHOP_PACKAGES: { productId: string; amount: number; priceCents: number }[] = [
  { productId: 'knuddelshop_15',    amount: 15,    priceCents: 99 },
  { productId: 'knuddelshop_110',   amount: 110,   priceCents: 499 },
  { productId: 'knuddelshop_240',   amount: 240,   priceCents: 999 },
  { productId: 'knuddelshop_510',   amount: 510,   priceCents: 1999 },
  { productId: 'knuddelshop_1400',  amount: 1400,  priceCents: 4999 },
  { productId: 'knuddelshop_3000',  amount: 3000,  priceCents: 9900 },
  { productId: 'knuddelshop_6500',  amount: 6500,  priceCents: 19900 },
  { productId: 'knuddelshop_21000', amount: 21000, priceCents: 49900 },
  { productId: 'knuddelshop_50000', amount: 50000, priceCents: 99900 },
];

// How long the simulated "test payment" takes before it auto-completes. Gives
// the frontend a beat to show its in-progress state, just like a real payment.
const PAYMENT_TEST_DELAY_MS = 600;

export function buildApi(appRec: AppRecord) {
  const { appId } = appRec;

  // ============================== Color ==============================
  class Color {
    private r: number; private g: number; private b: number; private a: number;
    constructor(r: number, g: number, b: number, a = 255) {
      this.r = clampByte(r); this.g = clampByte(g); this.b = clampByte(b); this.a = clampByte(a);
    }
    static fromRGB(r: number, g: number, b: number): Color { return new Color(r, g, b); }
    static fromRGBA(r: number, g: number, b: number, a: number): Color { return new Color(r, g, b, a); }
    static fromHexString(s: string): Color {
      const m = s.replace('#', '').match(/^([0-9a-f]{6})([0-9a-f]{2})?$/i);
      if (!m) return new Color(0, 0, 0);
      const n = parseInt(m[1]!, 16);
      const a = m[2] ? parseInt(m[2]!, 16) : 255;
      return new Color((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, a);
    }
    static fromNumber(n: number): Color {
      return new Color((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
    }
    getRed() { return this.r; }
    getGreen() { return this.g; }
    getBlue() { return this.b; }
    getAlpha() { return this.a; }
    asNumber() { return (this.r << 16) | (this.g << 8) | this.b; }
    asHexString() { return '#' + [this.r, this.g, this.b].map(v => v.toString(16).padStart(2, '0')).join(''); }
    toKCode() { return `°#${this.asHexString().slice(1)}°`; }
  }

  // ============================== Logger ==============================
  const Logger = {
    debug: (...args: any[]) => world.log({ ts: Date.now(), appId, level: 'debug', msg: fmtArgs(args) }),
    info:  (...args: any[]) => world.log({ ts: Date.now(), appId, level: 'info',  msg: fmtArgs(args) }),
    warn:  (...args: any[]) => world.log({ ts: Date.now(), appId, level: 'warn',  msg: fmtArgs(args) }),
    error: (...args: any[]) => world.log({ ts: Date.now(), appId, level: 'error', msg: fmtArgs(args) }),
    fatal: (...args: any[]) => world.log({ ts: Date.now(), appId, level: 'fatal', msg: fmtArgs(args) }),
  };

  // ============================== Enums ==============================
  // We use plain marker objects with a `name` field so reference equality works.
  const enumMember = (group: string, name: string) => ({ __enum: group, name, toString: () => name });

  const ClientType = {
    Applet: enumMember('ClientType', 'Applet'),
    Browser: enumMember('ClientType', 'Browser'),
    Android: enumMember('ClientType', 'Android'),
    IOS: enumMember('ClientType', 'IOS'),
    Offline: enumMember('ClientType', 'Offline'),
    Web: enumMember('ClientType', 'Web'),
    MobileWeb: enumMember('ClientType', 'MobileWeb'),
  };
  const Gender = {
    Male: enumMember('Gender', 'Male'),
    Female: enumMember('Gender', 'Female'),
    Unknown: enumMember('Gender', 'Unknown'),
  };
  const GenderDetailed = {
    Male: enumMember('GenderDetailed', 'Male'),
    Female: enumMember('GenderDetailed', 'Female'),
    NonBinaryHe: enumMember('GenderDetailed', 'NonBinaryHe'),
    NonBinaryShe: enumMember('GenderDetailed', 'NonBinaryShe'),
    Unknown: enumMember('GenderDetailed', 'Unknown'),
  };
  const AppViewMode = {
    Popup: enumMember('AppViewMode', 'Popup'),
    Overlay: enumMember('AppViewMode', 'Overlay'),
    Headerbar: enumMember('AppViewMode', 'Headerbar'),
    Global: enumMember('AppViewMode', 'Global'),
  };
  const UserType = {
    Human: enumMember('UserType', 'Human'),
    AppBot: enumMember('UserType', 'AppBot'),
    SystemBot: enumMember('UserType', 'SystemBot'),
  };
  const ChannelTalkMode = {
    Everyone: enumMember('ChannelTalkMode', 'Everyone'),
    OnlyWithTalkPermission: enumMember('ChannelTalkMode', 'OnlyWithTalkPermission'),
    FilteredByModerators: enumMember('ChannelTalkMode', 'FilteredByModerators'),
  };
  const ChannelTalkPermission = {
    NotInChannel: enumMember('ChannelTalkPermission', 'NotInChannel'),
    Default: enumMember('ChannelTalkPermission', 'Default'),
    TalkOnce: enumMember('ChannelTalkPermission', 'TalkOnce'),
    TalkPermanent: enumMember('ChannelTalkPermission', 'TalkPermanent'),
    VIP: enumMember('ChannelTalkPermission', 'VIP'),
    Moderator: enumMember('ChannelTalkPermission', 'Moderator'),
  };
  const KnuddelTransferDisplayType = {
    Public: enumMember('KnuddelTransferDisplayType', 'Public'),
    Private: enumMember('KnuddelTransferDisplayType', 'Private'),
    Post: enumMember('KnuddelTransferDisplayType', 'Post'),
    Silent: enumMember('KnuddelTransferDisplayType', 'Silent'),
  };
  const ToplistDisplayType = {
    Label: enumMember('ToplistDisplayType', 'Label'),
    Value: enumMember('ToplistDisplayType', 'Value'),
    LabelAndRank: enumMember('ToplistDisplayType', 'LabelAndRank'),
    ValueAndRank: enumMember('ToplistDisplayType', 'ValueAndRank'),
  };
  const AuthenticityClassification = {
    ServiceNotAvailable: enumMember('AuthenticityClassification', 'ServiceNotAvailable'),
    Unknown: enumMember('AuthenticityClassification', 'Unknown'),
    Trusted: enumMember('AuthenticityClassification', 'Trusted'),
    VeryTrusted: enumMember('AuthenticityClassification', 'VeryTrusted'),
    getDisplayText() { return (this as any).name ?? ''; },
  };

  // ============================== UserStatus ==============================
  const userStatusOrder = ['Newbie', 'Family', 'Stammi', 'HonoryMember', 'Admin', 'SystemBot', 'Sysadmin'];
  function makeUserStatus(name: string): any {
    const idx = userStatusOrder.indexOf(name);
    const obj: any = {
      __enum: 'UserStatus',
      name,
      isAtLeast(other: any) {
        return idx >= userStatusOrder.indexOf(other?.name ?? '');
      },
      getNumericStatus() { return idx; },
      toString() { return name; },
    };
    return obj;
  }
  const UserStatus = {
    Newbie: makeUserStatus('Newbie'),
    Family: makeUserStatus('Family'),
    Stammi: makeUserStatus('Stammi'),
    HonoryMember: makeUserStatus('HonoryMember'),
    Admin: makeUserStatus('Admin'),
    SystemBot: makeUserStatus('SystemBot'),
    Sysadmin: makeUserStatus('Sysadmin'),
  };

  // ============================== KnuddelAmount ==============================
  class KnuddelAmount {
    private cents: number;
    constructor(knuddel: number) { this.cents = Math.round(knuddel * 100); }
    static fromKnuddel(k: number): KnuddelAmount { return new KnuddelAmount(k); }
    static fromCents(c: number): KnuddelAmount { const a = new KnuddelAmount(0); (a as any).cents = c; return a; }
    getKnuddelCents() { return this.cents; }
    asNumber() { return this.cents / 100; }
    isNegative() { return this.cents < 0; }
    negate() { return KnuddelAmount.fromCents(-this.cents); }
  }

  // ============================== HTMLFile ==============================
  class HTMLFile {
    private assetPath: string;
    private pageData: Record<string, unknown>;
    constructor(assetPath: string, pageData?: Record<string, unknown>) {
      this.assetPath = assetPath;
      this.pageData = pageData ?? {};
    }
    getAssetPath() { return this.assetPath; }
    getPageData() { return this.pageData; }
  }

  // ============================== Persistence ==============================
  const store = appRec.persistence;
  const appPersistence = {
    // Persistence base methods
    getNumber: (k: string, def?: number) => store.getNumber(store.appKeyOf(k), def ?? 0),
    setNumber: (k: string, v: number) => store.setNumber(store.appKeyOf(k), v),
    hasNumber: (k: string) => store.hasNumber(store.appKeyOf(k)),
    deleteNumber: (k: string) => store.deleteNumber(store.appKeyOf(k)),
    addNumber: (k: string, v: number) => store.addNumber(store.appKeyOf(k), v),
    getString: (k: string, def?: string) => store.getString(store.appKeyOf(k), def ?? ''),
    setString: (k: string, v: string) => store.setString(store.appKeyOf(k), v),
    hasString: (k: string) => store.hasString(store.appKeyOf(k)),
    deleteString: (k: string) => store.deleteString(store.appKeyOf(k)),
    getObject: (k: string, def?: unknown) => store.getObject(store.appKeyOf(k), def ?? null),
    setObject: (k: string, v: unknown) => store.setObject(store.appKeyOf(k), v),
    hasObject: (k: string) => store.hasObject(store.appKeyOf(k)),
    deleteObject: (k: string) => store.deleteObject(store.appKeyOf(k)),
    // App-only:
    getNumberKeys: (pat?: string) => store.getNumberKeysApp(pat),
    getStringKeys: (pat?: string) => store.getStringKeysApp(pat),
    getObjectKeys: (pat?: string) => store.getObjectKeysApp(pat),
    getDatabaseFileSize: () => 0,
    getDatabaseFileSizeLimit: () => 1024 * 1024 * 100,
  };

  function userPersistenceFor(userId: number) {
    const sk = (k: string) => store.userKeyOf(userId, k);
    return {
      getNumber: (k: string, def?: number) => store.getNumber(sk(k), def ?? 0),
      setNumber: (k: string, v: number) => store.setNumber(sk(k), v),
      hasNumber: (k: string) => store.hasNumber(sk(k)),
      deleteNumber: (k: string) => store.deleteNumber(sk(k)),
      addNumber: (k: string, v: number) => store.addNumber(sk(k), v),
      getString: (k: string, def?: string) => store.getString(sk(k), def ?? ''),
      setString: (k: string, v: string) => store.setString(sk(k), v),
      hasString: (k: string) => store.hasString(sk(k)),
      deleteString: (k: string) => store.deleteString(sk(k)),
      getObject: (k: string, def?: unknown) => store.getObject(sk(k), def ?? null),
      setObject: (k: string, v: unknown) => store.setObject(sk(k), v),
      hasObject: (k: string) => store.hasObject(sk(k)),
      deleteObject: (k: string) => store.deleteObject(sk(k)),
      deleteAll: () => store.deleteAllForUser(userId),
      deleteAllNumbers: () => store.deleteAllForUser(userId, 'number'),
      deleteAllStrings: () => store.deleteAllForUser(userId, 'string'),
      deleteAllObjects: () => store.deleteAllForUser(userId, 'object'),
    };
  }

  // ============================== Knuddel-Konvertierung ==============================
  // App-Code übergibt KnuddelAmount-Instanzen oder rohe Numbers an
  // canTransferKnuddelToApp/transferKnuddelToApp; wir extrahieren die ganze
  // Knuddel-Anzahl unabhängig davon. Rückgabe `null` wenn nichts Brauchbares
  // drin steckt, damit der Caller einen sinnvollen Default wählen kann.
  function readKnuddelNumber(value: any): number | null {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value.asNumber === 'function') {
      const n = value.asNumber();
      return Number.isFinite(n) ? n : null;
    }
    if (typeof value.getKnuddelCents === 'function') {
      const c = value.getKnuddelCents();
      return Number.isFinite(c) ? c / 100 : null;
    }
    return null;
  }

  // ============================== Profile photo URLs ==============================
  // Stable per-user random avatar so the same user keeps the same picture
  // across reloads. Humans get a Pravatar photo (1..70 deterministic by id),
  // bots get a Bottts illustration. Apps that hit `user.getProfilePhoto(W,H)`
  // see a working image URL and `hasProfilePhoto()` returns true.
  function profilePhotoUrl(sim: SimUser, width?: number, height?: number): string {
    const w = clampSize(width);
    const h = clampSize(height ?? width);
    const size = Math.max(w, h);
    if (sim.userType === 'Human') {
      const idx = ((sim.userId - 1) % 70 + 70) % 70 + 1;
      return `https://i.pravatar.cc/${size}?img=${idx}`;
    }
    return `https://api.dicebear.com/9.x/bottts/png?seed=${encodeURIComponent(sim.nick || String(sim.userId))}&size=${size}`;
  }
  function clampSize(n: number | undefined): number {
    const v = Math.round(Number(n) || 300);
    if (!Number.isFinite(v) || v <= 0) return 300;
    return Math.min(2000, Math.max(16, v));
  }

  // ============================== User / BotUser ==============================
  // Real prototype-bearing constructors so apps can extend the User class via
  // `User.prototype.foo = function() { ... }` (a common pattern in Knuddels
  // apps — see e.g. crash-userapp's addCrashKnuddelMethods which patches
  // `getBalanceWithCrashKnuddel`, `addCrashKnuddelAmount`, etc.).
  // Direct construction is forbidden by the public API contract — apps must
  // obtain User instances via UserAccess / event payloads, never via `new User`.
  function User(this: any) { throw new Error('User cannot be constructed directly'); }
  function BotUser(this: any) { throw new Error('BotUser cannot be constructed directly'); }
  // BotUser extends User per the typings (knuddels-userapp-backend-api.d.ts:656),
  // so prototype patches on User flow through to bot instances too.
  BotUser.prototype = Object.create(User.prototype);
  BotUser.prototype.constructor = BotUser;

  // Platform lifecycle hook: a user's knuddel account amount changed. Apps
  // (e.g. Crash) listen via onAccountChangedKnuddelAmount to push a fresh
  // balance to their frontend, so this is what makes payouts/edits show up
  // live instead of only after a reload.
  function notifyKnuddelAccountChanged(targetSim: SimUser, before: number, after: number): void {
    if (before === after) return;
    try {
      appRec.app?.onAccountChangedKnuddelAmount?.(
        getUserById(targetSim.userId),
        {}, // KnuddelAccount is opaque in the sim
        new KnuddelAmount(before),
        new KnuddelAmount(after),
      );
    } catch (e: any) { Logger.error('onAccountChangedKnuddelAmount threw', e); }
  }

  function makeUser(sim: SimUser): any {
    const proto = sim.userType === 'Human' ? User.prototype : BotUser.prototype;
    const user: any = Object.create(proto);
    Object.assign(user, {
      getUserId: () => sim.userId,
      getNick: () => sim.nick,
      getAge: () => sim.age,
      getGender: () => (Gender as any)[sim.gender] ?? Gender.Unknown,
      getGenderDetailed: () => (GenderDetailed as any)[sim.genderDetailed] ?? GenderDetailed.Unknown,
      getUserStatus: () => (UserStatus as any)[sim.status] ?? UserStatus.Newbie,
      getUserType: () => (UserType as any)[sim.userType] ?? UserType.Human,
      getClientType: () => (ClientType as any)[sim.clientType] ?? ClientType.Web,
      getOnlineMinutes: () => sim.onlineMinutes,
      getRegDate: () => new Date(sim.regDate),
      getLastOnlineTime: () => new Date(sim.lastOnlineTime),
      getProfileLink: (text?: string) => `°@${sim.nick}|${text ?? sim.nick}°`,
      // An explicitly-set photo wins; otherwise fall back to a generated avatar
      // so simulated users always render with a picture.
      getProfilePhoto: (width?: number, height?: number) => sim.profilePhoto || profilePhotoUrl(sim, width, height),
      hasProfilePhoto: () => true,
      isProfilePhotoVerified: () => sim.isProfilePhotoVerified,
      getReadme: () => sim.readme,
      isOnline: () => sim.isInChannel,
      isOnlineInChannel: () => sim.isInChannel,
      isAway: () => sim.isAway,
      isLocked: () => sim.isLocked,
      isMuted: () => sim.isMuted,
      isColorMuted: () => sim.isColorMuted,
      isLikingChannel: () => sim.isLikingChannel,
      isAgeVerified: () => sim.isAgeVerified,
      isChannelOwner: () => sim.isChannelOwner,
      isChannelModerator: () => sim.isChannelModerator,
      isChannelCoreUser: () => sim.isChannelCoreUser,
      isEventModerator: () => sim.isEventModerator,
      isAppDeveloper: () => sim.isAppManager,
      isAppManager: () => sim.isAppManager,
      isStreamingVideo: () => sim.isStreamingVideo,
      isInTeam: () => sim.isInTeam,
      isConnectedWithK3Client: () => sim.isK3Client,
      getChannelTalkPermission: () => (ChannelTalkPermission as any)[sim.channelTalkPermission] ?? ChannelTalkPermission.Default,
      getAuthenticityClassification: () => (AuthenticityClassification as any)[sim.authenticityClassification] ?? AuthenticityClassification.Trusted,
      getKnuddelAmount: () => new KnuddelAmount(sim.knuddelAmount),
      getMaxKnuddelToApp: () => new KnuddelAmount(sim.maxKnuddelToApp),
      getKnuddelAccount: () => ({}),
      canTransferKnuddelToApp: (amount?: any) => {
        const n = readKnuddelNumber(amount);
        return n == null ? sim.knuddelAmount > 0 : sim.knuddelAmount >= n;
      },
      transferKnuddelToApp: (amount: any, reason: string, params?: any) => {
        const n = readKnuddelNumber(amount) ?? 0;
        if (n < 0 || sim.knuddelAmount < n) {
          try { params?.onError?.('insufficient knuddel'); } catch (e: any) { Logger.error('transferKnuddelToApp.onError threw', e); }
          return;
        }
        sim.knuddelAmount -= n;
        world.emitChange();
        try { params?.onSuccess?.(); } catch (e: any) { Logger.error('transferKnuddelToApp.onSuccess threw', e); }
        // Platform lifecycle hook: the app received knuddel. Apps (e.g. Crash)
        // use this to push a fresh balance to their frontend via onKnuddelReceived.
        try {
          appRec.app?.onKnuddelReceived?.(
            getUserById(sim.userId),
            getUserById(world.defaultBotUserId),
            new KnuddelAmount(n),
            reason,
          );
        } catch (e: any) { Logger.error('onKnuddelReceived threw', e); }
      },
      triggerDice: (diceConfiguration: any) => triggerDiceFor(sim, diceConfiguration),
      addNicklistIcon: (imagePath: string, imageWidth: number) => {
        sim.nicklistIcons = sim.nicklistIcons ?? {};
        const list = sim.nicklistIcons[appId] ?? (sim.nicklistIcons[appId] = []);
        if (!list.some(e => e.imagePath === imagePath)) {
          list.push({ imagePath, imageWidth });
          world.emitChange();
        }
      },
      removeNicklistIcon: (imagePath: string) => {
        const list = sim.nicklistIcons?.[appId];
        if (!list) return;
        const idx = list.findIndex(e => e.imagePath === imagePath);
        if (idx === -1) return;
        list.splice(idx, 1);
        if (list.length === 0) delete sim.nicklistIcons![appId];
        world.emitChange();
      },
      sendPostMessage: (topic: string, text: string) => {
        world.chat({ ts: Date.now(), appId, kind: 'post', fromUserId: appRec.persistence.appId === appId ? -1 : -1, toUserIds: [sim.userId], text: `[${topic}] ${text}` });
      },
      sendPrivateMessage: (msg: string) => {
        // user.sendPrivateMessage on the receiving user — log as bot→user pm
        world.chat({ ts: Date.now(), appId, kind: 'private', fromUserId: world.defaultBotUserId, toUserIds: [sim.userId], text: msg });
      },
      getPersistence: () => userPersistenceFor(sim.userId),
      getQuestAccess: () => ({
        getQuest: () => null,
        getUser: () => user,
        hasQuest: () => false,
        solvedQuest: () => {},
        getQuests: () => [],
      }),
      canShowAppViewMode: (_mode: any) => true,
      canSendAppContent: (_c: any) => true,
      sendAppContent: (content: any) => sendAppContentToUser(sim.userId, content),
      getAppContentSession: (mode: any) => findSessionFor(sim.userId, mode) ?? null,
      getAppContentSessions: (mode?: any) => findSessionsFor(sim.userId, mode),
      equals: (other: any) => other && typeof other.getUserId === 'function' && other.getUserId() === sim.userId,
      exists: () => true,
      __sim: sim,
      __isBot: sim.userType !== 'Human',
    });
    if (sim.userType !== 'Human') {
      user.sendPublicMessage = (text: string) => {
        world.chat({ ts: Date.now(), appId, kind: 'public', fromUserId: sim.userId, text });
      };
      user.sendPrivateMessage = (text: string, users?: any[]) => {
        const ids = users ? users.map((u: any) => u.getUserId()) : usersInChannel().map(u => u.userId).filter(id => id !== sim.userId);
        world.chat({ ts: Date.now(), appId, kind: 'private', fromUserId: sim.userId, toUserIds: ids, text });
      };
      user.sendPublicActionMessage = (text: string) => {
        world.chat({ ts: Date.now(), appId, kind: 'action', fromUserId: sim.userId, text });
      };
      user.sendPostMessage = (topic: string, text: string, receivingUser?: any) => {
        world.chat({ ts: Date.now(), appId, kind: 'post', fromUserId: sim.userId, toUserIds: receivingUser ? [receivingUser.getUserId()] : undefined, text: `[${topic}] ${text}` });
      };
      // BotUser → User payout (e.g. an app paying out winnings). Actually credit
      // the receiving user's balance so the simulated economy stays consistent;
      // the app bot is treated as an unlimited payout source (no debit).
      user.transferKnuddel = (receivingUser: any, amount: any, params?: any) => {
        const n = readKnuddelNumber(amount) ?? 0;
        const rid = typeof receivingUser?.getUserId === 'function' ? receivingUser.getUserId() : undefined;
        const receiverSim = rid != null ? world.users.get(rid) : undefined;
        if (n < 0 || !receiverSim) {
          try { params?.onError?.('invalid knuddel transfer'); } catch (e: any) { Logger.error('transferKnuddel.onError threw', e); }
          return;
        }
        const before = receiverSim.knuddelAmount;
        receiverSim.knuddelAmount += n;
        world.emitChange();
        try { params?.onSuccess?.(); } catch (e: any) { Logger.error('transferKnuddel.onSuccess threw', e); }
        notifyKnuddelAccountChanged(receiverSim, before, receiverSim.knuddelAmount);
      };
      user.destroyKnuddel = (amount: any, reason: string, params?: any) => {
        const n = readKnuddelNumber(amount) ?? 0;
        const before = sim.knuddelAmount;
        sim.knuddelAmount = Math.max(0, sim.knuddelAmount - n);
        world.emitChange();
        try { params?.onSuccess?.(new KnuddelAmount(n), reason); } catch (e: any) { Logger.error('destroyKnuddel.onSuccess threw', e); }
        notifyKnuddelAccountChanged(sim, before, sim.knuddelAmount);
      };
    }
    return user;
  }

  // Return User instance from sim record (cached, so reference equality works in onAppStart cycle)
  const userCache = new Map<number, any>();
  function getUserById(userId: number): any {
    const cached = userCache.get(userId);
    if (cached) return cached;
    const sim = world.users.get(userId);
    if (!sim) throw new Error(`Unknown user ${userId}`);
    const u = makeUser(sim);
    userCache.set(userId, u);
    return u;
  }
  // Invalidate cache when world user list changes
  const worldChangeHandler = () => userCache.clear();
  world.on('change', worldChangeHandler);
  // Track per-app world listeners that must be detached on app unload (e.g. AppContent close listeners).
  const ownWorldListenerOffs: (() => void)[] = [];
  appRec.context = appRec.context ?? {};
  (appRec.context as any).__userCache = userCache;
  (appRec.context as any).__getUser = getUserById;
  (appRec.context as any).__cleanup = () => {
    world.off('change', worldChangeHandler);
    for (const off of ownWorldListenerOffs) {
      try { off(); } catch {}
    }
    ownWorldListenerOffs.length = 0;
    let nicklistDirty = false;
    for (const u of world.users.values()) {
      if (u.nicklistIcons?.[appId]) {
        delete u.nicklistIcons[appId];
        nicklistDirty = true;
      }
    }
    if (nicklistDirty) world.emitChange();
  };

  function usersInChannel(): SimUser[] {
    return Array.from(world.users.values()).filter(u => u.isInChannel);
  }

  // ============================== Channel ==============================
  const channel = {
    getChannelName: () => world.channelName,
    getRootChannelName: () => world.channelName,
    getOnlineUsers: (...types: any[]) => {
      const wantedNames = types.length > 0 ? types.map(t => t?.name) : null;
      return usersInChannel()
        .filter(u => !wantedNames || wantedNames.includes(u.userType))
        .map(u => getUserById(u.userId));
    },
    isVideoChannel: () => false,
    isVisible: () => true,
    getTalkMode: () => ChannelTalkMode.Everyone,
    getAllUsersWithTalkPermission: () => usersInChannel().map(u => getUserById(u.userId)),
    getChannelDesign: () => ({
      getBackgroundColor: () => Color.fromHexString('#ffffff'),
      getDefaultFontColor: () => Color.fromHexString('#000000'),
      getDefaultFontSize: () => 14,
    }),
    getChannelConfiguration: () => ({
      getChannelRights: () => ({
        getChannelModerators: () => [],
        getChannelOwners: () => [],
        getEventModerators: () => [],
      }),
      getChannelInformation: () => ({
        getTopic: () => world.topic,
        setTopic: (topic: string) => { world.topic = topic; world.emitChange(); },
      }),
    }),
    getChannelRestrictions: () => ({
      getMutedUsers: () => [],
      getLockedUsers: () => [],
      getColorMutedUsers: () => [],
    }),
    getVideoChannelData: () => ({ getStreamingVideoUsers: () => [] }),
  };

  // ============================== AppContent ==============================
  function makeAppContent(htmlFile: HTMLFile, mode: 'Popup' | 'Overlay' | 'Headerbar' | 'Global', width: number, height: number) {
    const closeListeners: ((user: any, content: any, replacing: boolean) => void)[] = [];
    let responsive = false;
    const ownSessions: any[] = [];
    const loadConfigState = {
      enabled: true,
      backgroundColor: null as string | null,
      backgroundImage: '',
      loadingIndicatorImage: '',
      foregroundColor: null as string | null,
      text: '',
    };
    const loadConfig = {
      setEnabled: (b: boolean) => { loadConfigState.enabled = !!b; },
      setBackgroundColor: (c: any) => { loadConfigState.backgroundColor = c?.asHexString?.() ?? null; },
      setBackgroundImage: (url: string) => { loadConfigState.backgroundImage = String(url ?? ''); },
      setLoadingIndicatorImage: (url: string) => { loadConfigState.loadingIndicatorImage = String(url ?? ''); },
      setForegroundColor: (c: any) => { loadConfigState.foregroundColor = c?.asHexString?.() ?? null; },
      setText: (t: string) => { loadConfigState.text = String(t ?? ''); },
    };
    const content: any = {
      __isAppContent: true,
      __htmlFile: htmlFile,
      __mode: mode,
      __width: width,
      __height: height,
      __loadConfigState: loadConfigState,
      getHTMLFile: () => htmlFile,
      getAppViewMode: () => (AppViewMode as any)[mode],
      getWidth: () => width,
      getHeight: () => height,
      isResponsive: () => responsive,
      setResponsive: (r: boolean) => { responsive = r; },
      isAllowJFXBrowser: () => true,
      setAllowJFXBrowser: (_b: boolean) => {},
      getLoadConfiguration: () => loadConfig,
      addCloseListener: (cb: any) => { closeListeners.push(cb); },
      getSessions: () => ownSessions.slice(),
      getUsers: () => ownSessions.map(s => s.getUser()),
      sendEvent: (type: string, data?: any) => {
        for (const s of ownSessions) world.sendEventToSession(s.__sessionId, type, data);
      },
      replaceWithAppContent: (newContent: any) => {
        for (const s of ownSessions.slice()) {
          const userId = s.getUser().getUserId();
          world.appContentRemoved(s.__sessionId, { replacing: true });
          // open new session for the same user with new content
          const session = openSession(userId, newContent);
          newContent.__attachSession?.(session);
        }
      },
      remove: () => {
        for (const s of ownSessions.slice()) {
          world.appContentRemoved(s.__sessionId);
        }
      },
      __attachSession: (s: any) => { ownSessions.push(s); },
    };
    const onContentRemoved = ({ sessionId, replacing }: { sessionId: string; replacing: boolean }) => {
      const idx = ownSessions.findIndex(s => s.__sessionId === sessionId);
      if (idx === -1) return;
      const s = ownSessions[idx];
      ownSessions.splice(idx, 1);
      for (const cb of closeListeners) {
        try { cb(s.getUser(), content, replacing); }
        catch (err: any) {
          world.log({ ts: Date.now(), appId, level: 'error', msg: `closeListener threw: ${err?.message ?? err}` });
        }
      }
    };
    world.on('app-content-removed', onContentRemoved);
    ownWorldListenerOffs.push(() => world.off('app-content-removed', onContentRemoved));
    return content;
  }

  const AppContent = {
    popupContent: (html: HTMLFile, w?: number, h?: number) => makeAppContent(html, 'Popup', w ?? 400, h ?? 300),
    overlayContent: (html: HTMLFile, w?: number, h?: number) => makeAppContent(html, 'Overlay', w ?? 400, h ?? 300),
    headerbarContent: (html: HTMLFile, h?: number) => makeAppContent(html, 'Headerbar', -1, h ?? 60),
    globalContent: (html: HTMLFile, w?: number, h?: number) => makeAppContent(html, 'Global', w ?? 800, h ?? 600),
  };

  function openSession(userId: number, content: any) {
    const sessionId = world.newSessionId();
    const openTs = new Date();
    const session: any = {
      __sessionId: sessionId,
      __isAppContentSession: true,
      getUser: () => getUserById(userId),
      getAppContent: () => content,
      getAppViewMode: () => content.getAppViewMode(),
      getOpenTimestamp: () => openTs,
      isConnectedUsingDirectConnection: () => false,
      getGlobalAppInstance: () => null,
      sendEvent: (type: string, data?: any) => {
        world.sendEventToSession(sessionId, type, data);
      },
      remove: () => {
        world.appContentRemoved(sessionId);
      },
    };
    const html = content.__htmlFile as HTMLFile;
    const spec: AppContentSpec = {
      sessionId,
      appId,
      userId,
      appViewMode: content.__mode,
      width: content.__width,
      height: content.__height,
      responsive: content.isResponsive(),
      assetPath: html.getAssetPath(),
      pageData: html.getPageData() as Record<string, unknown>,
      loadConfig: content.__loadConfigState ? { ...content.__loadConfigState } : undefined,
    };
    world.appContentShown(spec);
    return session;
  }

  function sendAppContentToUser(userId: number, content: any) {
    const session = openSession(userId, content);
    content.__attachSession(session);
    return session;
  }

  function findSessionFor(userId: number, mode?: any): any {
    for (const s of appRec.sessions.values()) {
      if (s.userId === userId && (!mode || s.appViewMode === mode.name)) {
        return reconstructSessionRef(s);
      }
    }
    return null;
  }
  function findSessionsFor(userId: number, mode?: any): any[] {
    const result: any[] = [];
    for (const s of appRec.sessions.values()) {
      if (s.userId === userId && (!mode || s.appViewMode === mode.name)) {
        result.push(reconstructSessionRef(s));
      }
    }
    return result;
  }
  function reconstructSessionRef(spec: AppContentSpec) {
    return {
      __sessionId: spec.sessionId,
      getUser: () => getUserById(spec.userId),
      getAppViewMode: () => (AppViewMode as any)[spec.appViewMode],
      getOpenTimestamp: () => new Date(),
      isConnectedUsingDirectConnection: () => false,
      getGlobalAppInstance: () => null,
      sendEvent: (type: string, data?: any) => world.sendEventToSession(spec.sessionId, type, data),
      remove: () => world.appContentRemoved(spec.sessionId),
      getAppContent: () => null,
    };
  }

  // ============================== AppInstance / AppInfo / AppAccess ==============================
  const startDate = new Date();
  const developer = world.users.get(world.defaultBotUserId)!;
  const appInfo = {
    getAppName: () => appRec.config['appName'] ?? appId,
    getAppVersion: () => appRec.config['appVersion'] ?? '0.0',
    getAppDeveloper: () => getUserById(developer.userId),
    getAppId: () => appId,
    getAppKey: () => appId,
    getAppUid: () => 1,
    getRootAppUid: () => 1,
    getAppManagers: () => [getUserById(developer.userId)],
    requestKnuddelDebts: (cb: any) => cb(0, 'OK'),
    // Generous payout allowance so apps that gate winnings on this cap can
    // actually pay out in the sim (the real platform sets a regulated limit).
    getMaxPayoutKnuddelAmount: () => new KnuddelAmount(1_000_000),
  };
  const ownInstance: any = {
    getStartDate: () => startDate,
    getChannelName: () => world.channelName,
    getAllInstances: () => [ownInstance],
    getRegisteredChatCommandNames: () => Object.keys(appRec.app?.chatCommands ?? {}),
    sendAppEvent: (type: string, data: any) => {
      // self-loopback: simulates onAppEventReceived for other apps; here we only have one instance.
      try { appRec.app?.onAppEventReceived?.(ownInstance, type, data); }
      catch (e) { Logger.error('onAppEventReceived threw', e); }
    },
    getAppInfo: () => appInfo,
    isRootInstance: () => true,
    getRootInstance: () => rootInstance,
  };
  const rootInstance: any = Object.assign({}, ownInstance, {
    stopApp: (msg?: string, log?: string) => Logger.info('stopApp', msg ?? '', log ?? ''),
    cancelUpdateApp: () => true,
    invalidateClientCache: () => {},
    updateApp: () => 0,
    updateAppFiles: () => [],
  });

  const appAccess = {
    getOwnInstance: () => ownInstance,
    getAllRunningAppsInChannel: (_includeSelf?: boolean) => [ownInstance],
    getRunningAppInChannel: (id: string) => id === appId ? ownInstance : null,
    registerGlobalApp: (cfg: any) => {
      const inst = makeGlobalAppInstance(cfg);
      globalApps.set(cfg.getId?.() ?? cfg.id ?? appId, inst);
      return inst;
    },
    unregisterGlobalApp: (id: string) => {
      const inst = globalApps.get(id) ?? null;
      globalApps.delete(id);
      return inst;
    },
    getGlobalAppInstance: (id: string) => globalApps.get(id) ?? null,
    getAllGlobalAppInstances: () => Array.from(globalApps.values()),
  };

  const globalApps = new Map<string, any>();
  function makeGlobalAppInstance(initialCfg: any) {
    let cfg = initialCfg;
    const sessions: any[] = [];
    const instance: any = {
      getAppConfig: () => cfg,
      setAppConfig: (newCfg: any) => { cfg = newCfg; },
      getAddAsFavoriteChatCommand: () => '/addfav',
      getOpenAppChatCommand: () => '/openapp',
      getRemoveAsFavoriteChatCommand: () => '/removefav',
      closeActiveSessions: () => sessions.splice(0, sessions.length),
      getActiveSessions: () => sessions.slice(),
      getActiveSession: () => sessions[0] ?? null,
      hasAsFavorite: () => false,
      openGlobalApp: (user: any) => {
        const handler = cfg.getOpenRequestHandler?.();
        if (!handler) return null;
        const content = handler(user, instance);
        const session = sendAppContentToUser(user.getUserId(), content);
        sessions.push(session);
        cfg.getSessionOpenedCallback?.()?.(session);
        return session;
      },
    };
    return instance;
  }

  // ============================== UserAccess ==============================
  const userAccess = {
    getUserById: (id: number) => {
      const sim = world.users.get(id);
      if (!sim) throw new Error('Unknown userId ' + id);
      return getUserById(id);
    },
    isUserDeleted: () => false,
    getAccessibleUserCount: () => world.users.size,
    exists: (nick: string) => {
      const lower = nick.toLowerCase();
      return Array.from(world.users.values()).some(u => u.nick.toLowerCase() === lower);
    },
    mayAccess: () => true,
    getNick: (id: number) => world.users.get(id)?.nick ?? '',
    getUserId: (nick: string) => {
      const lower = nick.toLowerCase();
      return Array.from(world.users.values()).find(u => u.nick.toLowerCase() === lower)?.userId ?? -1;
    },
    eachAccessibleUser: (cb: any, params: any = {}) => {
      const list = Array.from(world.users.values());
      params.onStart?.(list.length, undefined);
      for (let i = 0; i < list.length; i++) {
        const cont = cb(getUserById(list[i]!.userId), i, list.length);
        if (cont === false) break;
      }
      params.onEnd?.(list.length, undefined);
    },
  };

  // ============================== ServerInfo ==============================
  const chatServerInfo = {
    getVersion: () => 'test-env',
    getServerId: () => 'localhost',
    isTestSystem: () => true,
  };
  const appServerInfo = { ...chatServerInfo };

  // ============================== ExternalServerAccess ==============================
  const externalServerAccess = {
    canAccessURL: () => true,
    getAllAccessibleDomains: () => [],
    getURL: (url: string, p: any = {}) => fetchHelper('GET', url, p),
    postURL: (url: string, p: any = {}) => fetchHelper('POST', url, p),
    callURL: (url: string, p: any = {}) => fetchHelper((p.method ?? 'GET'), url, p),
    touchURL: (url: string, p: any = {}) => fetchHelper('GET', url, p),
  };

  function fetchHelper(method: string, url: string, p: any) {
    Logger.info(`[ExternalServerAccess] ${method} ${url}`);
    fetch(url, {
      method,
      body: method === 'POST' && p.data ? JSON.stringify(p.data) : undefined,
      headers: p.header ?? (method === 'POST' ? { 'Content-Type': 'application/json' } : undefined),
    })
      .then(async r => {
        const text = await r.text();
        const resp = {
          getURLString: () => url,
          getResponseCode: () => r.status,
          getHeaders: () => ({ }),
        };
        if (r.ok) p.onSuccess?.(text, resp);
        else p.onFailure?.(text, resp);
      })
      .catch((e: Error) => {
        p.onFailure?.(String(e), {
          getURLString: () => url,
          getResponseCode: () => 0,
          getHeaders: () => ({}),
        });
      });
  }

  // ============================== WebHookAccess ==============================
  // Webhooks are tracked per app in a Map; the test-env doesn't deliver
  // events but the registry needs to round-trip register/unregister/list/get.
  const webHooks = new Map<string, string>();
  const webHookAccess = {
    registerWebHook: (key: string, _observer: Function) => {
      const url = `http://localhost/__webhook/${appId}/${encodeURIComponent(key)}`;
      webHooks.set(key, url);
      return url;
    },
    getWebHookUrl: (key: string) => webHooks.get(key) ?? null,
    unregisterWebHook: (key: string) => { webHooks.delete(key); },
    unregisterAllWebHooks: () => { webHooks.clear(); },
    getRegisteredWebhooks: () => Array.from(webHooks.keys()),
  };

  // ============================== Toplist ==============================
  // Per-toplist listener registries — keyed by the toplist's userPersistenceNumberKey.
  type RankListener = (e: any) => void;
  type LabelListener = (e: any) => void;
  const toplistListeners = new Map<string, { rank: RankListener[]; label: LabelListener[] }>();
  function listenersFor(key: string) {
    let l = toplistListeners.get(key);
    if (!l) { l = { rank: [], label: [] }; toplistListeners.set(key, l); }
    return l;
  }

  const toplistAccess = {
    createOrUpdateToplist: (key: string, name: string, params: any = {}) => {
      appRec.toplists.set(key, {
        displayName: name,
        ascending: params.ascending ?? false,
        labelMapping: params.labelMapping,
      });
      return makeToplist(key, name);
    },
    getAllToplists: () => Array.from(appRec.toplists.entries()).map(([k, v]) => makeToplist(k, v.displayName)),
    getToplist: (key: string) => makeToplist(key, appRec.toplists.get(key)?.displayName ?? key),
    removeToplist: (tl: any) => appRec.toplists.delete(tl.getUserPersistenceNumberKey()),
  };
  function computeLabel(key: string, value: number): string {
    const cfg = appRec.toplists.get(key);
    if (!cfg?.labelMapping) return '';
    const thresholds = Object.keys(cfg.labelMapping)
      .map(t => parseFloat(t))
      .filter(n => !Number.isNaN(n))
      .sort((a, b) => a - b);
    let label = '';
    for (const t of thresholds) {
      if (value >= t) label = cfg.labelMapping[String(t)] ?? cfg.labelMapping[t.toString()] ?? label;
      else break;
    }
    return label;
  }
  function getRankFromSnapshot(key: string, userId: number, snap: Record<string, any>): { rank: number; value: number } {
    const cfg = appRec.toplists.get(key);
    const ascending = cfg?.ascending ?? false;
    const list: { userId: number; value: number }[] = [];
    for (const [k, slot] of Object.entries(snap)) {
      const m = /^user:(\d+):(.+)$/.exec(k);
      if (m && m[2] === key && slot?.kind === 'number') {
        list.push({ userId: parseInt(m[1]!, 10), value: slot.value });
      }
    }
    list.sort((a, b) => ascending ? a.value - b.value : b.value - a.value);
    const idx = list.findIndex(e => e.userId === userId);
    return { rank: idx === -1 ? 0 : idx + 1, value: idx === -1 ? 0 : list[idx]!.value };
  }
  function makeToplist(key: string, displayName: string) {
    const tlObj: any = {
      getUserPersistenceNumberKey: () => key,
      getDisplayName: () => displayName,
      getLabel: (userOrId: any) => {
        const userId = typeof userOrId === 'number' ? userOrId : userOrId?.getUserId?.();
        if (typeof userId !== 'number') return '';
        const slot = store.snapshot()[store.userKeyOf(userId, key)];
        if (slot?.kind !== 'number') return '';
        return computeLabel(key, slot.value);
      },
      getChatCommand: () => `/toplist ${key}`,
      addRankChangeListener: (cb: RankListener) => { listenersFor(key).rank.push(cb); },
      removeRankChangeListener: (cb: RankListener) => {
        const arr = listenersFor(key).rank;
        const idx = arr.indexOf(cb);
        if (idx !== -1) arr.splice(idx, 1);
      },
      addLabelChangeListener: (cb: LabelListener) => { listenersFor(key).label.push(cb); },
      removeLabelChangeListener: (cb: LabelListener) => {
        const arr = listenersFor(key).label;
        const idx = arr.indexOf(cb);
        if (idx !== -1) arr.splice(idx, 1);
      },
    };
    return tlObj;
  }

  // Wire up Store onChange to drive toplist rank/label listeners. We snapshot
  // BEFORE the mutation by remembering the prior slot, then recompute rank/label
  // for the affected user using the AFTER-snapshot. The "users overtook" set is
  // the difference between the user's new and old neighbors in the sorted list.
  const previousStoreOnChange = store.onChange;
  store.onChange = (scopedKey, oldSlot, newSlot) => {
    previousStoreOnChange?.(scopedKey, oldSlot, newSlot);
    const m = /^user:(\d+):(.+)$/.exec(scopedKey);
    if (!m) return;
    const userId = parseInt(m[1]!, 10);
    const tlKey = m[2]!;
    const ls = toplistListeners.get(tlKey);
    if (!ls || (ls.rank.length === 0 && ls.label.length === 0)) return;
    const oldValue = oldSlot?.kind === 'number' ? oldSlot.value : null;
    const newValue = newSlot?.kind === 'number' ? newSlot.value : null;
    if (oldValue === newValue) return;
    const afterSnap = store.snapshot();
    const beforeSnap: Record<string, any> = { ...afterSnap };
    if (oldSlot) beforeSnap[scopedKey] = oldSlot; else delete beforeSnap[scopedKey];
    const before = getRankFromSnapshot(tlKey, userId, beforeSnap);
    const after = getRankFromSnapshot(tlKey, userId, afterSnap);
    const tl = makeToplist(tlKey, appRec.toplists.get(tlKey)?.displayName ?? tlKey);
    if (before.rank !== after.rank && ls.rank.length > 0) {
      const overtookIds = computeOvertaken(tlKey, userId, before.rank, after.rank, beforeSnap, afterSnap);
      const event: any = {
        getUser: () => getUserById(userId),
        getToplist: () => tl,
        getOldRank: () => before.rank,
        getNewRank: () => after.rank,
        getOldValue: () => before.value,
        getNewValue: () => after.value,
        getUsersOvertook: () => overtookIds.map(id => getUserById(id)),
      };
      for (const cb of ls.rank.slice()) {
        try { cb(event); } catch (e: any) { Logger.error('rankChangeListener threw', e?.message ?? e); }
      }
    }
    if (ls.label.length > 0) {
      const oldLabel = oldValue === null ? '' : computeLabel(tlKey, oldValue);
      const newLabel = newValue === null ? '' : computeLabel(tlKey, newValue);
      if (oldLabel !== newLabel) {
        const event: any = {
          getUser: () => getUserById(userId),
          getToplist: () => tl,
          getOldLabel: () => oldLabel,
          getNewLabel: () => newLabel,
          getOldValue: () => before.value,
          getNewValue: () => after.value,
        };
        for (const cb of ls.label.slice()) {
          try { cb(event); } catch (e: any) { Logger.error('labelChangeListener threw', e?.message ?? e); }
        }
      }
    }
  };
  ownWorldListenerOffs.push(() => { store.onChange = previousStoreOnChange; });

  function computeOvertaken(tlKey: string, userId: number, oldRank: number, newRank: number, beforeSnap: Record<string, any>, afterSnap: Record<string, any>): number[] {
    if (newRank >= oldRank) return [];
    const cfg = appRec.toplists.get(tlKey);
    const ascending = cfg?.ascending ?? false;
    const collect = (snap: Record<string, any>): { userId: number; value: number }[] => {
      const out: { userId: number; value: number }[] = [];
      for (const [k, slot] of Object.entries(snap)) {
        const mm = /^user:(\d+):(.+)$/.exec(k);
        if (mm && mm[2] === tlKey && slot?.kind === 'number') {
          out.push({ userId: parseInt(mm[1]!, 10), value: slot.value });
        }
      }
      out.sort((a, b) => ascending ? a.value - b.value : b.value - a.value);
      return out;
    };
    const beforeAhead = new Set(collect(beforeSnap).slice(0, oldRank - 1).map(e => e.userId));
    const afterAhead = new Set(collect(afterSnap).slice(0, newRank - 1).map(e => e.userId));
    const overtaken: number[] = [];
    for (const id of beforeAhead) if (!afterAhead.has(id) && id !== userId) overtaken.push(id);
    return overtaken;
  }

  // ============================== AppProfileEntryAccess ==============================
  const appProfileEntryAccess = {
    createOrUpdateEntry: (toplist: any, displayType: any) => {
      const key = toplist.getUserPersistenceNumberKey?.() ?? '';
      appRec.profileEntries.set(key, { displayType: displayType?.name ?? 'Value' });
      return makeAppProfileEntry(toplist, displayType);
    },
    removeEntry: (entry: any) => {
      const key = entry?.getKey?.();
      if (typeof key === 'string') appRec.profileEntries.delete(key);
    },
    getAppProfileEntry: (key: string) => {
      const stored = appRec.profileEntries.get(key);
      if (!stored) return null;
      const tlName = appRec.toplists.get(key)?.displayName ?? key;
      const dt = (ToplistDisplayType as any)[stored.displayType] ?? ToplistDisplayType.Value;
      return makeAppProfileEntry(makeToplist(key, tlName), dt);
    },
    getAllProfileEntries: () => Array.from(appRec.profileEntries.entries()).map(([key, stored]) => {
      const tlName = appRec.toplists.get(key)?.displayName ?? key;
      const dt = (ToplistDisplayType as any)[stored.displayType] ?? ToplistDisplayType.Value;
      return makeAppProfileEntry(makeToplist(key, tlName), dt);
    }),
  };
  function makeAppProfileEntry(toplist: any, displayType: any) {
    return {
      getKey: () => toplist.getUserPersistenceNumberKey?.() ?? '',
      getDisplayType: () => displayType,
      getToplist: () => toplist,
    };
  }

  // ============================== UserPersistence(Numbers/Strings/Objects) globals ==============================
  // Only the most-used surface of UserPersistenceNumbers is approximated.
  const UserPersistenceNumbers = {
    getAllKeys: (filter?: string) => getAllUserKeysOfKind('number', filter),
    addNumber: (key: string, value: number, _params?: any) => {
      let count = 0;
      for (const u of world.users.values()) {
        store.addNumber(store.userKeyOf(u.userId, key), value);
        count++;
      }
      return count;
    },
    each: (key: string, cb: any, params: any = {}) => {
      const entries = collectUserNumbers(key).filter(e => isUserRegisteredOrPrune(e.userId, key));
      params.onStart?.(entries.length, key);
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        const cont = cb(getUserById(e.userId), e.value, i, entries.length, key);
        if (cont === false) break;
      }
      params.onEnd?.(entries.length, key);
    },
    getSortedEntries: (key: string, params: any = {}) => {
      const ascending = params.ascending ?? false;
      const list = collectUserNumbers(key).sort((a, b) => ascending ? a.value - b.value : b.value - a.value);
      const sliced = list.slice(0, params.count ?? list.length);
      return sliced.map((e, i) => ({
        getValue: () => e.value,
        getRank: () => i + 1,
        getPosition: () => i + 1,
        getUser: () => getUserById(e.userId),
      }));
    },
    getRank: (key: string, userOrId: any) => {
      const userId = typeof userOrId === 'number' ? userOrId : userOrId.getUserId();
      const list = collectUserNumbers(key).sort((a, b) => b.value - a.value);
      return list.findIndex(e => e.userId === userId) + 1;
    },
    getPosition: (key: string, userOrId: any) => UserPersistenceNumbers.getRank(key, userOrId),
    getSortedEntriesAdjacent: (key: string, userOrId: any, params: any = {}) => {
      const ascending = params.ascending ?? false;
      const list = collectUserNumbers(key).sort((a, b) => ascending ? a.value - b.value : b.value - a.value);
      const targetId = typeof userOrId === 'number' ? userOrId : userOrId.getUserId();
      const idx = list.findIndex(e => e.userId === targetId);
      if (idx === -1) return [];
      const count = params.count ?? list.length;
      const half = Math.floor((count - 1) / 2);
      let start = Math.max(0, idx - half);
      const end = Math.min(list.length, start + count);
      start = Math.max(0, end - count);
      return list.slice(start, end).map((e, i) => ({
        getValue: () => e.value,
        getRank: () => start + i + 1,
        getPosition: () => start + i + 1,
        getUser: () => getUserById(e.userId),
      }));
    },
    getSum: (key: string) => collectUserNumbers(key).reduce((s, e) => s + e.value, 0),
    getCount: (key: string) => collectUserNumbers(key).length,
    updateValue: (key: string, oldValue: number, newValue: number) => {
      let n = 0;
      for (const [k, slot] of Object.entries(store.snapshot())) {
        const m = /^user:\d+:(.+)$/.exec(k);
        if (m && m[1] === key && slot.kind === 'number' && slot.value === oldValue) {
          store.setNumber(k, newValue);
          n++;
        }
      }
      return n;
    },
    updateKey: (oldKey: string, newKey: string) => {
      if (oldKey === newKey) return 0;
      let n = 0;
      for (const [k, slot] of Object.entries(store.snapshot())) {
        const m = /^user:(\d+):(.+)$/.exec(k);
        if (m && m[2] === oldKey && slot.kind === 'number') {
          const userId = parseInt(m[1]!, 10);
          store.setNumber(store.userKeyOf(userId, newKey), slot.value);
          store.deleteRaw(k);
          n++;
        }
      }
      return n;
    },
    deleteAll: (key: string) => deleteAllUserSlots(key, 'number'),
    getNicksByKey: (key: string, cb: any) => cb(
      collectUserNumbers(key)
        .map(e => world.users.get(e.userId)?.nick)
        .filter((n): n is string => typeof n === 'string')
    ),
    getUserIdsByKey: (key: string, cb: any) => cb(collectUserNumbers(key).map(e => e.userId)),
  };

  function collectUserNumbers(key: string): { userId: number; value: number }[] {
    const out: { userId: number; value: number }[] = [];
    for (const [k, slot] of Object.entries(store.snapshot())) {
      const m = /^user:(\d+):(.+)$/.exec(k);
      if (m && m[2] === key && slot.kind === 'number') {
        out.push({ userId: parseInt(m[1]!, 10), value: slot.value });
      }
    }
    return out;
  }

  function getAllUserKeysOfKind(kind: 'number' | 'string' | 'object', filter?: string): string[] {
    const out = new Set<string>();
    for (const [k, slot] of Object.entries(store.snapshot())) {
      const m = /^user:\d+:(.+)$/.exec(k);
      if (m && slot.kind === kind && (!filter || m[1]!.includes(filter))) {
        out.add(m[1]!);
      }
    }
    return Array.from(out);
  }

  function deleteAllUserSlots(key: string, kind: 'number' | 'string' | 'object'): number {
    let n = 0;
    for (const [k, slot] of Object.entries(store.snapshot())) {
      const m = /^user:\d+:(.+)$/.exec(k);
      if (m && m[1] === key && slot.kind === kind) {
        store.deleteRaw(k);
        n++;
      }
    }
    return n;
  }

  // Persistence keys can outlive their user record across sim restarts: the
  // file-backed store reloads on startup but `world.users` is reseeded fresh,
  // so any user-id beyond the seed set becomes orphan. Iteration APIs treat
  // orphan entries as a consistency break and prune them on encounter — this
  // keeps the invariant "no user-persistence without a registered user".
  function isUserRegisteredOrPrune(userId: number, key: string): boolean {
    if (world.users.get(userId)) return true;
    const fullKey = `user:${userId}:${key}`;
    world.log({ ts: Date.now(), appId, level: 'warn', msg: `orphan user-persistence entry ${fullKey} — auto-removed (no matching user record)` });
    store.deleteRaw(fullKey);
    return false;
  }

  function collectUserObjects(key: string): { userId: number; value: unknown }[] {
    const out: { userId: number; value: unknown }[] = [];
    for (const [k, slot] of Object.entries(store.snapshot())) {
      const m = /^user:(\d+):(.+)$/.exec(k);
      if (m && m[2] === key && slot.kind === 'object') {
        out.push({ userId: parseInt(m[1]!, 10), value: slot.value });
      }
    }
    return out;
  }

  function collectUserStrings(key: string): { userId: number; value: string }[] {
    const out: { userId: number; value: string }[] = [];
    for (const [k, slot] of Object.entries(store.snapshot())) {
      const m = /^user:(\d+):(.+)$/.exec(k);
      if (m && m[2] === key && slot.kind === 'string') {
        out.push({ userId: parseInt(m[1]!, 10), value: slot.value });
      }
    }
    return out;
  }

  const UserPersistenceStrings = {
    getAllKeys: (filter?: string) => getAllUserKeysOfKind('string', filter),
    deleteAll: (key: string) => deleteAllUserSlots(key, 'string'),
    exists: (key: string, value: string, ignoreCase?: boolean) => {
      const target = ignoreCase ? value.toLowerCase() : value;
      return collectUserStrings(key).some(e => (ignoreCase ? e.value.toLowerCase() : e.value) === target);
    },
    each: (key: string, cb: any, params: any = {}) => {
      let entries = collectUserStrings(key).filter(e => isUserRegisteredOrPrune(e.userId, key));
      if (params.online === true) {
        entries = entries.filter(e => getUserById(e.userId)?.isOnline());
      }
      const totalCount = entries.length;
      const limit = typeof params.maximumCount === 'number'
        ? Math.min(params.maximumCount, totalCount)
        : totalCount;
      params.onStart?.(totalCount, key);
      for (let i = 0; i < limit; i++) {
        const e = entries[i]!;
        const cont = cb(getUserById(e.userId), e.value, i, totalCount, key);
        if (cont === false) break;
      }
      params.onEnd?.(totalCount, key);
    },
    getNicksByKey: (key: string, cb: any) => cb(
      collectUserStrings(key)
        .map(e => world.users.get(e.userId)?.nick)
        .filter((n): n is string => typeof n === 'string')
    ),
    getUserIdsByKey: (key: string, cb: any) => cb(collectUserStrings(key).map(e => e.userId)),
  };
  const UserPersistenceObjects = {
    getAllKeys: (filter?: string) => getAllUserKeysOfKind('object', filter),
    deleteAll: (key: string) => deleteAllUserSlots(key, 'object'),
    each: (key: string, cb: any, params: any = {}) => {
      let entries = collectUserObjects(key).filter(e => isUserRegisteredOrPrune(e.userId, key));
      if (params.online === true) {
        entries = entries.filter(e => getUserById(e.userId)?.isOnline());
      }
      const totalCount = entries.length;
      const limit = typeof params.maximumCount === 'number'
        ? Math.min(params.maximumCount, totalCount)
        : totalCount;
      params.onStart?.(totalCount, key);
      for (let i = 0; i < limit; i++) {
        const e = entries[i]!;
        const cont = cb(getUserById(e.userId), e.value, i, totalCount, key);
        if (cont === false) break;
      }
      params.onEnd?.(totalCount, key);
    },
    getNicksByKey: (key: string, cb: any) => cb(
      collectUserObjects(key)
        .map(e => world.users.get(e.userId)?.nick)
        .filter((n): n is string => typeof n === 'string')
    ),
    getUserIdsByKey: (key: string, cb: any) => cb(collectUserObjects(key).map(e => e.userId)),
  };

  // ============================== ChannelJoinPermission / Misc enums w/ helpers ==============================
  const ChannelJoinPermission = {
    accepted: () => ({ __accepted: true }),
    denied: (reason: string) => ({ __accepted: false, reason }),
  };

  // ============================== RandomOperations ==============================
  const RandomOperations = {
    nextInt: (a: number, b?: number) => {
      const min = b === undefined ? 0 : a;
      const max = b === undefined ? a : b;
      return Math.floor(Math.random() * (max - min + 1)) + min;
    },
    nextInts: (a: number, b: number, count: number, onlyDifferent: boolean) => {
      if (!onlyDifferent) {
        const arr: number[] = [];
        for (let i = 0; i < count; i++) arr.push(RandomOperations.nextInt(a, b));
        return arr;
      }
      const range = b - a + 1;
      if (count > range) {
        throw new RangeError(`nextInts: cannot draw ${count} unique numbers from [${a},${b}]`);
      }
      const pool: number[] = [];
      for (let v = a; v <= b; v++) pool.push(v);
      for (let i = pool.length - 1; i > pool.length - 1 - count; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      return pool.slice(pool.length - count);
    },
    flipTrue: (p: number) => Math.random() < p,
    getRandomObject: <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)],
    getRandomString: (len: number, allowed?: string) => {
      const chars = allowed ?? 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let s = '';
      for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    },
    shuffleObjects: <T,>(arr: T[]) => {
      const copy = arr.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    },
  };

  // ============================== Dice ==============================
  class Dice {
    constructor(public count: number, public value: number) {}
    getNumberOfSides() { return this.value; }
    getAmount() { return this.count; }
  }

  const DiceConfigurationFactory = {
    fromString: (s: string) => makeDiceConfig(s),
  };
  function makeDiceConfig(s = '1w6'): any {
    const dices: Dice[] = [];
    for (const part of String(s).split('+')) {
      const m = /^(\d+)\s*[wWdD]\s*(\d+)$/.exec(part.trim());
      if (m) dices.push(new Dice(parseInt(m[1]!, 10), parseInt(m[2]!, 10)));
    }
    if (dices.length === 0) dices.push(new Dice(1, 6));
    return {
      isUsingPrivateThrow: () => false,
      isUsingOpenThrow: () => true,
      getDices: () => dices.slice(),
      getChatCommand: () => `/dice ${s}`,
      equals: () => false,
      toString: () => s,
    };
  }

  function triggerDiceFor(sim: SimUser, diceConfiguration: any): void {
    if (!diceConfiguration?.getDices) return;
    const dices: Dice[] = diceConfiguration.getDices();
    const singleResults: any[] = [];
    let totalSum = 0;
    for (const dice of dices) {
      const sides = dice.getNumberOfSides();
      const amount = dice.getAmount();
      const rolls: number[] = [];
      let sum = 0;
      for (let i = 0; i < amount; i++) {
        const v = Math.floor(Math.random() * sides) + 1;
        rolls.push(v);
        sum += v;
      }
      totalSum += sum;
      singleResults.push({
        valuesRolled: () => rolls.slice(),
        getDice: () => dice,
        sum: () => sum,
      });
    }
    const diceResult: any = {
      totalSum: () => totalSum,
      getDiceConfiguration: () => diceConfiguration,
      getSingleDiceResults: () => singleResults.slice(),
      toString: () => `${diceConfiguration.toString?.() ?? ''} = ${totalSum}`,
    };
    const diceEvent: any = {
      getDiceResult: () => diceResult,
      getUser: () => getUserById(sim.userId),
    };
    const mayDice = appRec.app?.mayUserDice?.(getUserById(sim.userId), diceConfiguration);
    if (mayDice === false) return;
    world.chat({
      ts: Date.now(), appId, kind: 'action',
      fromUserId: sim.userId,
      text: `würfelt ${diceConfiguration.toString?.() ?? ''} = ${totalSum} (${singleResults.map(r => r.valuesRolled().join(',')).join(' | ')})`,
    });
    try { appRec.app?.onUserDiced?.(diceEvent); }
    catch (e: any) { Logger.error('onUserDiced threw', e?.message ?? e); }
  }

  // ============================== PaymentAccess (Knuddel-Shop) ==============================
  // A working mock of the knuddel shop + "test payment" flow. `requestKnuddelShops`
  // hands the app a populated KnuddelShop; `startKnuddelPurchase` simulates a
  // successful test payment: it credits the bought Knuddel to the user and then
  // fires the app's `onKnuddelPurchaseSuccess` lifecycle hook — which is where
  // apps (e.g. Crash) grant their purchase bonuses such as freegames. No real
  // payment dialog exists in the test-env, so the purchase always succeeds.
  function makeKnuddelShopProduct(pkg: { productId: string; amount: number; priceCents: number }) {
    return {
      getProductId: () => pkg.productId,
      getOrigKnuddelPayout: () => pkg.amount,
      getOrigPriceCents: () => pkg.priceCents,
      getNewKnuddelPayout: () => null,
      getNewPriceCents: () => null,
      getHappyHourBonusPercentage: () => null,
      getLoyaltyPoints: () => 0,
      getLoyaltyLevelIncrease: () => 0,
    };
  }
  const knuddelShopProducts = KNUDDEL_SHOP_PACKAGES.map(makeKnuddelShopProduct);
  const knuddelShop = {
    getShopName: () => 'Knuddel-Shop (Test)',
    getProducts: () => knuddelShopProducts.slice(),
  };
  function findKnuddelShopProduct(productId: any) {
    if (typeof productId === 'string') {
      return knuddelShopProducts.find(p => p.getProductId() === productId) ?? null;
    }
    const amount = readKnuddelNumber(productId);
    if (amount != null) {
      return knuddelShopProducts.find(p => p.getOrigKnuddelPayout() === amount) ?? null;
    }
    return null;
  }
  function completeKnuddelPurchase(userObj: any, product: any, startTimestamp: number, params: any) {
    const sim: SimUser | undefined = userObj?.__sim;
    if (!sim) return;
    // A knuddel purchase credits the bought Knuddel to the user's account; the
    // app's bonus payout (freegames etc.) happens on top inside onKnuddelPurchaseSuccess.
    const payout = product.getNewKnuddelPayout() ?? product.getOrigKnuddelPayout();
    const before = sim.knuddelAmount;
    sim.knuddelAmount += payout;
    world.emitChange();
    notifyKnuddelAccountChanged(sim, before, sim.knuddelAmount);
    Logger.info(`[Payment] test purchase complete: ${sim.nick} +${payout} Knuddel (product ${product.getProductId()})`);
    try {
      appRec.app?.onKnuddelPurchaseSuccess?.(userObj, startTimestamp, product, !!params?.toBot);
    } catch (e: any) { Logger.error('onKnuddelPurchaseSuccess threw', e); }
  }
  const paymentAccess = {
    startKnuddelPurchase: (user: any, productId: any, params: any = {}) => {
      const startTimestamp = Date.now();
      const userObj = user && typeof user.getUserId === 'function' ? user : null;
      const product = findKnuddelShopProduct(productId);
      if (!userObj || !product) {
        Logger.warn(`[Payment] startKnuddelPurchase failed — ${!userObj ? 'no user' : `unknown product ${String(productId)}`}`);
        if (userObj) {
          setTimeout(() => {
            try { appRec.app?.onKnuddelPurchaseFailed?.(userObj, startTimestamp, 'Unbekanntes Produkt im Test-Shop'); }
            catch (e: any) { Logger.error('onKnuddelPurchaseFailed threw', e); }
          }, 0);
        }
        return;
      }
      Logger.info(`[Payment] test purchase started: ${userObj.getNick()} → ${product.getProductId()} (${product.getOrigKnuddelPayout()} Knuddel for ${(product.getOrigPriceCents() / 100).toFixed(2)} €)`);
      setTimeout(() => completeKnuddelPurchase(userObj, product, startTimestamp, params), PAYMENT_TEST_DELAY_MS);
    },
    requestKnuddelShops: (user: any, callback: any) => {
      try { callback?.(user, 0, [knuddelShop], 'OK'); }
      catch (e: any) { Logger.error('requestKnuddelShops callback threw', e); }
    },
    openKnuddelShop: (_user: any, _transferReason?: string) => {
      Logger.info('[Payment] openKnuddelShop — no native shop UI in test-env (use the app shop UI instead)');
    },
    requestLoyaltyDetails: (user: any, callback: any) => {
      try {
        callback?.(user, {
          getEndangeredPoints: () => 0,
          getNextDeductionTimestamp: () => 0,
          getPoints: () => 0,
          getLevels: () => [],
        });
      } catch (e: any) { Logger.error('requestLoyaltyDetails callback threw', e); }
    },
  };

  // ============================== KnuddelsServer namespace ==============================
  const KnuddelsServer = {
    getChannel: () => channel,
    getDefaultBotUser: () => getUserById(world.defaultBotUserId),
    getDefaultLogger: () => Logger,
    getPersistence: () => appPersistence,
    getUserAccess: () => userAccess,
    getAppAccess: () => appAccess,
    getAppProfileEntryAccess: () => appProfileEntryAccess,
    getAppServerInfo: () => appServerInfo,
    getChatServerInfo: () => chatServerInfo,
    getExternalServerAccess: () => externalServerAccess,
    getPaymentAccess: () => paymentAccess,
    getWebHookAccess: () => webHookAccess,
    getToplistAccess: () => toplistAccess,
    getFullImagePath: (img: string) => `/app/${appId}/${img}`,
    getFullSystemImagePath: (img: string) => `/__system/${img}`,
    listFiles: (subPath: string) => {
      // Returns immediate file children of `<appDir>/<subPath>`, each formatted
      // as `<subPath>/<filename>` (forward-slash, posix-style). This matches
      // what real apps expect: e.g. FeatureManager builds candidate paths via
      // string concat (`'feature_flags/' + 'featureFlags.dev.js'`) and checks
      // `new Set(SERVER.listFiles('feature_flags')).has(<candidate>)` — that
      // only works if the entries already include the sub-path prefix.
      const dir = path.join(appRec.appDir, subPath);
      const cleanSub = subPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      try {
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter(e => e.isFile())
          .map(e => cleanSub ? `${cleanSub}/${e.name}` : e.name);
      } catch { return []; }
    },
    execute: (fileName: string) => {
      // Loaded files are tracked by sandbox/require.ts via the same context.
      const exec = (appRec.context as any)?.__execute as ((file: string) => void) | undefined;
      exec?.(fileName);
    },
    refreshHooks: () => {},
    registerInAppChatMessage: (chatGroupId: string, sender: any, text: string, receiverIds: number[]) => {
      world.chat({
        ts: Date.now(),
        appId,
        kind: 'in-app',
        fromUserId: sender?.getUserId?.() ?? -1,
        toUserIds: Array.isArray(receiverIds) ? receiverIds : [],
        text,
        chatGroupId,
      });
    },
    getPerformanceStats: () => [],
  };

  // ============================== Knuddels-injected free globals ==============================
  // The real chat server exposes a few bare globals that aren't part of any
  // module — apps reference them via `// @ts-ignore` and bare `Mixpanel.X(...)`.
  // We provide a permissive no-op proxy so `Mixpanel.updateUserProfile`,
  // `Mixpanel.trackEvent`, etc. (or any future method) resolve without
  // throwing `ReferenceError: Mixpanel is not defined`. Apps that gate calls
  // behind `!IS_TEST_SYSTEM` (computed from `chatServerInfo.isTestSystem()`,
  // which is `true` here) won't invoke these no-ops anyway; the proxy is
  // there so the bare identifier resolves at evaluation time.
  const Mixpanel: any = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive || prop === 'then') return undefined;
      return (...args: any[]) => {
        Logger.debug(`[Mixpanel] ${String(prop)} (no-op in test-env)`, ...args.slice(0, 2));
      };
    },
  });

  // ============================== final globals bag ==============================
  return {
    KnuddelsServer,
    Mixpanel,
    AppContent, AppContentSession: function() {} as any,
    HTMLFile, AppViewMode, ClientType, Gender, GenderDetailed, UserType,
    Color, KnuddelAmount, KnuddelTransferDisplayType,
    UserStatus, ChannelTalkMode, ChannelTalkPermission, AuthenticityClassification,
    ChannelJoinPermission, ToplistDisplayType,
    UserPersistenceNumbers, UserPersistenceStrings, UserPersistenceObjects,
    RandomOperations, Dice, DiceConfigurationFactory,
    // User / BotUser are real prototype-bearing constructors so apps can
    // extend them via `User.prototype.foo = ...`; their instances are
    // produced by makeUser() and inherit through Object.create(proto).
    User: User as any,
    BotUser: BotUser as any,
    Channel: function Channel() { throw new Error('Channel cannot be constructed'); } as any,
    Message: function Message() { throw new Error('Message cannot be constructed'); } as any,
    PublicMessage: function PublicMessage() { throw new Error(); } as any,
    PrivateMessage: function PrivateMessage() { throw new Error(); } as any,
    PublicActionMessage: function PublicActionMessage() { throw new Error(); } as any,
    PublicEventMessage: function PublicEventMessage() { throw new Error(); } as any,
  };
}

function clampByte(n: number) { return Math.max(0, Math.min(255, n | 0)); }
function fmtArgs(args: any[]): string {
  return args.map(a => typeof a === 'string' ? a : safeStringify(a)).join(' ');
}
function safeStringify(v: any): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
