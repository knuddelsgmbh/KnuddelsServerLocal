import type { Express } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { world, SimUser, AppRecord, DEFAULT_KNUDDEL } from '../state/world.js';
import { appRegistry, safeAppId } from '../state/app-registry.js';
import { dispatchUserJoined, dispatchPublicMessage, dispatchPublicActionMessage } from '../simulation/dispatch.js';
import { handleSlashCommand } from './ws-bridge.js';
import {
  addExternalAppPath,
  listExternalTargets,
  loadOrReload,
  removeExternalAppPath,
  setLiveSource,
} from '../watcher.js';
import { pickFolderNative } from '../config/folder-picker.js';

const APPS_DIR = path.resolve('apps');

type UploadedFile = {
  /** path relative to the app root, e.g. "main.js" or "www/index.html" */
  path: string;
  /** base64-encoded content */
  base64: string;
};

function safeRelPath(rel: string): string | null {
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (norm.includes('\0')) return null;
  if (norm.split('/').some(seg => seg === '..' || seg === '')) return null;
  return norm;
}

function userFor(a: AppRecord, userId: number): any {
  const get = (a.context as any)?.__getUser as ((id: number) => any) | undefined;
  if (get) {
    try { return get(userId); } catch { /* unknown user */ }
  }
  return (a.context as any)?.__userCache?.get(userId);
}

export function registerDebugApi(app: Express): void {
  app.post('/api/debug/userJoined', (req, res) => {
    const userId = Number(req.body?.userId);
    const sim = world.users.get(userId);
    if (!sim) return res.status(404).json({ error: 'unknown userId' });
    if (sim.isInChannel) return res.json({ ok: true, alreadyInChannel: true });
    const r = dispatchUserJoined(userId);
    if (!r.joined) return res.json({ ok: false, denied: true, reason: r.reason, appId: r.appId });
    res.json({ ok: true });
  });

  app.post('/api/debug/userLeft', (req, res) => {
    const userId = Number(req.body?.userId);
    const sim = world.users.get(userId);
    if (!sim) return res.status(404).json({ error: 'unknown userId' });
    sim.isInChannel = false;
    world.emitChange();
    for (const a of world.apps.values()) {
      const u = userFor(a, userId);
      try { a.app?.onUserLeft?.(u); }
      catch (e: any) { world.log({ ts: Date.now(), appId: a.appId, level: 'error', msg: `onUserLeft threw: ${e?.message ?? e}` }); }
      // Close any AppContent sessions still open for this user.
      const userSessions = Array.from(a.sessions.values()).filter(s => s.userId === userId);
      for (const s of userSessions) {
        world.appContentRemoved(s.sessionId);
      }
    }
    res.json({ ok: true });
  });

  app.post('/api/debug/createUser', (req, res) => {
    const nick = String(req.body?.nick ?? '').trim();
    if (!nick) return res.status(400).json({ error: 'nick required' });
    if (Array.from(world.users.values()).some(u => u.nick === nick)) {
      return res.status(409).json({ error: 'nick exists' });
    }
    const id = world.nextUserId++;
    const sim: SimUser = {
      userId: id,
      nick,
      gender: (req.body?.gender as any) ?? 'Unknown',
      age: Number(req.body?.age ?? 25),
      status: (req.body?.status as any) ?? 'Stammi',
      userType: (req.body?.userType as any) ?? 'Human',
      isInChannel: false,
      isChannelOwner: Boolean(req.body?.isChannelOwner),
      isAppManager: Boolean(req.body?.isAppManager),
      knuddel: clampKnuddel(req.body?.knuddel, DEFAULT_KNUDDEL),
    };
    world.users.set(id, sim);
    world.emitChange();
    res.json({ ok: true, user: sim });
  });

  app.post('/api/debug/setUserFlags', (req, res) => {
    const userId = Number(req.body?.userId);
    const sim = world.users.get(userId);
    if (!sim) return res.status(404).json({ error: 'unknown userId' });
    if (typeof req.body?.isChannelOwner === 'boolean') sim.isChannelOwner = req.body.isChannelOwner;
    if (typeof req.body?.isAppManager === 'boolean')   sim.isAppManager   = req.body.isAppManager;
    if (typeof req.body?.status === 'string')          sim.status         = req.body.status as any;
    if (req.body?.knuddel !== undefined)               sim.knuddel        = clampKnuddel(req.body.knuddel, sim.knuddel);
    world.emitChange();
    res.json({ ok: true, user: sim });
  });

  // Dedicated endpoint for live knuddel-balance edits (used by the inline
  // input in the user table). Same effect as setUserFlags with `knuddel`,
  // but explicit and easier to extend later (e.g. add/subtract semantics).
  app.post('/api/debug/setUserKnuddel', (req, res) => {
    const userId = Number(req.body?.userId);
    const sim = world.users.get(userId);
    if (!sim) return res.status(404).json({ error: 'unknown userId' });
    if (req.body?.knuddel === undefined) return res.status(400).json({ error: 'knuddel required' });
    sim.knuddel = clampKnuddel(req.body.knuddel, sim.knuddel);
    world.emitChange();
    res.json({ ok: true, user: sim });
  });

  app.post('/api/debug/deleteUser', (req, res) => {
    const userId = Number(req.body?.userId);
    if (userId === world.defaultBotUserId) return res.status(400).json({ error: 'cannot delete default bot' });
    const sim = world.users.get(userId);
    if (!sim) return res.status(404).json({ error: 'unknown userId' });
    if (sim.isInChannel) {
      sim.isInChannel = false;
      for (const a of world.apps.values()) {
        const u = userFor(a, userId);
        try { a.app?.onUserLeft?.(u); } catch {}
      }
    }
    world.users.delete(userId);
    // App-level: simulate "user deleted" privacy event
    for (const a of world.apps.values()) {
      try { a.app?.onUserDeleted?.(userId, a.persistence); } catch {}
    }
    world.emitChange();
    res.json({ ok: true });
  });

  app.post('/api/debug/publicMessage', (req, res) => {
    const userId = Number(req.body?.userId);
    const text = String(req.body?.text ?? '');
    const sim = world.users.get(userId);
    if (!sim) return res.status(404).json({ error: 'unknown userId' });
    const r = dispatchPublicMessage(userId, text, 'debug');
    if (!r.dispatched) return res.json({ ok: false, blocked: true, blockedBy: r.blockedBy });
    res.json({ ok: true });
  });

  app.post('/api/debug/privateMessage', (req, res) => {
    const userId = Number(req.body?.userId);
    const text = String(req.body?.text ?? '');
    const sim = world.users.get(userId);
    if (!sim) return res.status(404).json({ error: 'unknown userId' });
    world.chat({ ts: Date.now(), appId: 'debug', kind: 'private', fromUserId: userId, toUserIds: [world.defaultBotUserId], text });
    for (const a of world.apps.values()) {
      const u = userFor(a, userId);
      const msg = makePrivateMessage(u, text, [userFor(a, world.defaultBotUserId)]);
      try { a.app?.onPrivateMessage?.(msg); }
      catch (e: any) { world.log({ ts: Date.now(), appId: a.appId, level: 'error', msg: `onPrivateMessage threw: ${e?.message ?? e}` }); }
    }
    res.json({ ok: true });
  });

  app.post('/api/debug/actionMessage', (req, res) => {
    const userId = Number(req.body?.userId);
    const text = String(req.body?.text ?? '');
    const fn = String(req.body?.functionName ?? 'action');
    const sim = world.users.get(userId);
    if (!sim) return res.status(404).json({ error: 'unknown userId' });
    const r = dispatchPublicActionMessage(userId, text, fn, 'debug');
    if (!r.dispatched) return res.json({ ok: false, blocked: true, blockedBy: r.blockedBy });
    res.json({ ok: true });
  });

  app.post('/api/debug/slashCommand', (req, res) => {
    const userId = Number(req.body?.userId);
    const command = String(req.body?.command ?? '').trim();
    const appId = String(req.body?.appId ?? '');
    const sim = world.users.get(userId);
    if (!sim) return res.status(404).json({ error: 'unknown userId' });
    if (!command) return res.status(400).json({ error: 'command required' });
    if (appId) {
      handleSlashCommand(appId, userId, command);
    } else {
      // Try every loaded app — first match wins.
      for (const a of world.apps.values()) {
        const cmdName = command.replace(/^\//, '').split(/\s/)[0]!;
        if (a.app?.chatCommands?.[cmdName]) {
          handleSlashCommand(a.appId, userId, command);
          break;
        }
      }
    }
    res.json({ ok: true });
  });

  app.post('/api/debug/appEvent', (req, res) => {
    const appId = String(req.body?.appId ?? '');
    const type = String(req.body?.type ?? '');
    const data = req.body?.data ?? null;
    const a = world.apps.get(appId);
    if (!a) return res.status(404).json({ error: 'unknown appId' });
    try {
      a.app?.onAppEventReceived?.((a.context as any)?.KnuddelsServer?.getAppAccess?.()?.getOwnInstance?.(), type, data);
    } catch (e: any) {
      world.log({ ts: Date.now(), appId, level: 'error', msg: `onAppEventReceived threw: ${e?.message ?? e}` });
    }
    res.json({ ok: true });
  });

  app.post('/api/debug/dice', (req, res) => {
    const userId = Number(req.body?.userId);
    const value = Number(req.body?.value ?? 6);
    const result = Math.floor(Math.random() * value) + 1;
    for (const a of world.apps.values()) {
      const u = userFor(a, userId);
      const event = {
        getUser: () => u,
        getDiceResult: () => ({
          totalSum: () => result,
          getDiceConfiguration: () => ({ toString: () => `1w${value}` }),
          getSingleDiceResults: () => [{ valuesRolled: () => [result], sum: () => result, getDice: () => ({ getNumberOfSides: () => value, getAmount: () => 1 }) }],
          toString: () => String(result),
        }),
      };
      try { a.app?.onUserDiced?.(event); }
      catch (e: any) { world.log({ ts: Date.now(), appId: a.appId, level: 'error', msg: `onUserDiced threw: ${e?.message ?? e}` }); }
    }
    res.json({ ok: true, result });
  });

  app.post('/api/debug/knuddelTransfer', (req, res) => {
    const senderId = Number(req.body?.userId);
    const amount = Number(req.body?.amount ?? 1);
    const reason = String(req.body?.reason ?? '');
    for (const a of world.apps.values()) {
      const sender = userFor(a, senderId);
      const bot = userFor(a, world.defaultBotUserId);
      try {
        a.app?.onKnuddelReceived?.(sender, bot, { asNumber: () => amount, getKnuddelCents: () => amount * 100 }, reason);
      } catch (e: any) {
        world.log({ ts: Date.now(), appId: a.appId, level: 'error', msg: `onKnuddelReceived threw: ${e?.message ?? e}` });
      }
    }
    res.json({ ok: true });
  });

  app.post('/api/debug/closeSession', (req, res) => {
    const sessionId = String(req.body?.sessionId ?? '');
    world.appContentRemoved(sessionId);
    res.json({ ok: true });
  });

  app.post('/api/debug/topicChange', (req, res) => {
    const topic = String(req.body?.topic ?? '');
    const oldChannel = world.channelName;
    const newChannel = String(req.body?.channelName ?? world.channelName);
    world.topic = topic;
    world.channelName = newChannel;
    world.emitChange();
    // Channel-Wechsel wirkt sich auf die Auswahl der Feature-Flag-Profile in
    // den UserApps aus (FeatureManager schaut beim onAppStart nach
    // `featureFlags.<channelName>.dev.js`). Beim Wechsel des Namens reloaden
    // wir daher alle geladenen Apps, damit der neue Name unmittelbar greift.
    let reloaded = 0;
    if (newChannel !== oldChannel) {
      for (const appId of Array.from(world.apps.keys())) {
        loadOrReload(appId);
        reloaded++;
      }
    }
    res.json({ ok: true, reloaded });
  });

  // Recent logs / chat — handy for e2e verification without WS.
  app.get('/api/debug/logs', (_req, res) => res.json(world.logs.slice(-200)));
  app.get('/api/debug/chat', (_req, res) => res.json(world.chatLog.slice(-200)));

  // Persistence inspection
  app.get('/api/debug/persistence/:appId', (req, res) => {
    const a = world.apps.get(req.params.appId);
    if (!a) return res.status(404).json({ error: 'unknown appId' });
    res.json(a.persistence.snapshot());
  });
  app.post('/api/debug/persistence/:appId', (req, res) => {
    const a = world.apps.get(req.params.appId);
    if (!a) return res.status(404).json({ error: 'unknown appId' });
    const { key, slot } = req.body ?? {};
    if (!key) return res.status(400).json({ error: 'key required' });
    if (slot === null) a.persistence.deleteRaw(key);
    else a.persistence.setRaw(key, slot);
    res.json({ ok: true });
  });
  app.post('/api/debug/persistence/:appId/clear', (req, res) => {
    const a = world.apps.get(req.params.appId);
    if (!a) return res.status(404).json({ error: 'unknown appId' });
    const scope = String(req.body?.scope ?? '');
    let removed = 0;
    if (scope === 'all') removed = a.persistence.clearAll();
    else if (scope === 'app') removed = a.persistence.deleteAllApp();
    else if (scope === 'users') removed = a.persistence.deleteAllUsers();
    else if (scope === 'user') {
      const userId = Number(req.body?.userId);
      if (!Number.isFinite(userId)) return res.status(400).json({ error: 'userId required for scope=user' });
      removed = a.persistence.deleteAllForUser(userId);
    } else {
      return res.status(400).json({ error: 'invalid scope' });
    }
    res.json({ ok: true, removed });
  });

  // Upload (or update) an app via drag-and-drop in the UI.
  // Body: { appId, files: [{ path, base64 }], replace?: boolean }
  app.post('/api/debug/uploadApp', (req, res) => {
    const appId = safeAppId(String(req.body?.appId ?? ''));
    if (!appId) return res.status(400).json({ error: 'invalid or missing appId' });
    const existing = appRegistry.get(appId);
    if (existing && existing.source === 'external') {
      return res.status(409).json({ error: `appId '${appId}' is registered as external (${existing.appDir}); upload would shadow it` });
    }
    const files = req.body?.files;
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files[] required' });
    }
    const replace = Boolean(req.body?.replace);
    const appDir = path.join(APPS_DIR, appId);

    // Validate every relative path before touching the disk.
    const writes: { abs: string; rel: string; data: Buffer }[] = [];
    for (const f of files as UploadedFile[]) {
      const rel = safeRelPath(String(f?.path ?? ''));
      if (!rel) return res.status(400).json({ error: `invalid file path: ${f?.path}` });
      const abs = path.join(appDir, rel);
      if (!abs.startsWith(appDir + path.sep) && abs !== appDir) {
        return res.status(400).json({ error: `path escapes app dir: ${rel}` });
      }
      let data: Buffer;
      try { data = Buffer.from(String(f?.base64 ?? ''), 'base64'); }
      catch { return res.status(400).json({ error: `invalid base64 for ${rel}` }); }
      writes.push({ abs, rel, data });
    }

    if (replace && fs.existsSync(appDir)) {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
    fs.mkdirSync(appDir, { recursive: true });
    for (const w of writes) {
      fs.mkdirSync(path.dirname(w.abs), { recursive: true });
      fs.writeFileSync(w.abs, w.data);
    }

    const hasMain = writes.some(w => w.rel === 'main.js');
    res.json({ ok: true, appId, fileCount: writes.length, hasMain });
  });

  app.delete('/api/debug/app/:appId', (req, res) => {
    const appId = safeAppId(req.params.appId);
    if (!appId) return res.status(400).json({ error: 'invalid appId' });
    const existing = appRegistry.get(appId);
    if (existing && existing.source === 'external') {
      return res.status(409).json({ error: `appId '${appId}' is registered as external (${existing.appDir}); refuse to delete from disk` });
    }
    const appDir = path.join(APPS_DIR, appId);
    if (!fs.existsSync(appDir)) return res.status(404).json({ error: 'unknown appId' });
    fs.rmSync(appDir, { recursive: true, force: true });
    res.json({ ok: true });
  });

  // List externally registered app folders (env-defined + persisted via UI).
  app.get('/api/debug/externalApps', (_req, res) => {
    res.json({ items: listExternalTargets() });
  });

  // Add an external app folder by absolute path. Body: { path, appId }
  app.post('/api/debug/externalApps', (req, res) => {
    const rawPath = String(req.body?.path ?? '');
    const rawAppId = String(req.body?.appId ?? '');
    const r = addExternalAppPath(rawPath, rawAppId);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true, item: r.view });
  });

  // Toggle "Live Source" for an external app at runtime.
  // Body: { appId: string, enabled: boolean }
  app.post('/api/debug/liveSource', (req, res) => {
    const appId = safeAppId(String(req.body?.appId ?? ''));
    if (!appId) return res.status(400).json({ error: 'invalid or missing appId' });
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) required' });
    }
    const r = setLiveSource(appId, req.body.enabled);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true, liveSource: r.liveSource });
  });

  // Remove an external app folder. Body: { path: string }
  app.delete('/api/debug/externalApps', (req, res) => {
    const absPath = String(req.body?.path ?? '');
    const r = removeExternalAppPath(absPath);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true });
  });

  // Open a native OS folder picker. Returns { path: string | null }.
  app.post('/api/debug/pickFolder', async (_req, res) => {
    try {
      const p = await pickFolderNative('Externe UserApp auswählen');
      res.json({ path: p });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // Discover which channel-specific feature-flag profiles each loaded app
  // ships in its `feature_flags/` folder. The Knuddels UserApp convention is
  // `featureFlags.<channelName>.dev.js` / `.prod.js` plus the generic
  // `featureFlags.dev.js` / `featureFlags.prod.js`. The UI uses this to offer
  // a dropdown of valid channel names.
  app.get('/api/debug/featureFlagProfiles', (_req, res) => {
    res.json(listFeatureFlagProfiles());
  });
}

function listFeatureFlagProfiles(): {
  channels: string[];
  perApp: Record<string, { channels: string[]; hasGenericDev: boolean; hasGenericProd: boolean }>;
} {
  const allChannels = new Set<string>();
  const perApp: Record<string, { channels: string[]; hasGenericDev: boolean; hasGenericProd: boolean }> = {};
  for (const app of world.apps.values()) {
    const ffDir = path.join(app.appDir, 'feature_flags');
    let entries: string[];
    try { entries = fs.readdirSync(ffDir); }
    catch { perApp[app.appId] = { channels: [], hasGenericDev: false, hasGenericProd: false }; continue; }
    const channels: string[] = [];
    let hasGenericDev = false;
    let hasGenericProd = false;
    for (const f of entries) {
      if (f === 'featureFlags.dev.js') { hasGenericDev = true; continue; }
      if (f === 'featureFlags.prod.js') { hasGenericProd = true; continue; }
      const m = /^featureFlags\.(.+?)\.(dev|prod)\.js$/.exec(f);
      if (m && m[1]) {
        channels.push(m[1]);
        allChannels.add(m[1]);
      }
    }
    perApp[app.appId] = {
      channels: Array.from(new Set(channels)).sort((a, b) => a.localeCompare(b)),
      hasGenericDev,
      hasGenericProd,
    };
  }
  return {
    channels: Array.from(allChannels).sort((a, b) => a.localeCompare(b)),
    perApp,
  };
}

// Übernimmt eingehende Knuddel-Werte (Number, String, JSON-`null`/`undefined`)
// und gibt einen sicheren ganzzahligen Saldo zurück. Negative Werte werden auf
// 0 geklemmt — Knuddel-Saldo darf nie negativ sein. Ungültiges Input fällt
// auf den Fallback zurück (z.B. der bisherige Saldo).
function clampKnuddel(value: any, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.round(n));
}

function makePrivateMessage(author: any, text: string, receivers: any[]): any {
  const date = new Date();
  return {
    getAuthor: () => author,
    getText: () => text,
    getRawText: () => text,
    getCreationDate: () => date,
    getReceivingUsers: () => receivers,
    sendReply: (reply: string) => {
      world.chat({ ts: Date.now(), appId: 'debug', kind: 'private', fromUserId: world.defaultBotUserId, toUserIds: [author.getUserId()], text: reply });
    },
  };
}
