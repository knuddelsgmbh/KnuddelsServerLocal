import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { world, AppRecord, AppContentSpec } from '../state/world.js';

type Channel = 'debug' | 'iframe';

type DebugClient = { ws: WebSocket; kind: 'debug' };
type IframeClient = { ws: WebSocket; kind: 'iframe'; sessionId: string };
type Client = DebugClient | IframeClient;

const clients = new Set<Client>();

// When an iframe-WS disconnects we don't immediately close the AppContent session:
// the iframe might just be reloading (e.g. debug-ui ↻ button or HMR). We grant a
// short grace window — if a new iframe-WS for the same sessionId connects in time,
// the pending close is cancelled.
const IFRAME_RECONNECT_GRACE_MS = 1500;
const pendingIframeClose = new Map<string, NodeJS.Timeout>();

export function attachWsServer(server: any): void {
  const wss = new WebSocketServer({ server, path: '/__ws' });
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '', 'http://x');
    const channel = (url.searchParams.get('channel') ?? 'debug') as Channel;

    let client: Client;
    if (channel === 'iframe') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      client = { ws, kind: 'iframe', sessionId };
      const pending = pendingIframeClose.get(sessionId);
      if (pending) {
        clearTimeout(pending);
        pendingIframeClose.delete(sessionId);
      }
    } else {
      client = { ws, kind: 'debug' };
    }
    clients.add(client);

    if (client.kind === 'debug') {
      // Send initial snapshot
      send(client.ws, { type: 'snapshot', payload: world.snapshot() });
      send(client.ws, { type: 'log-history', payload: world.logs.slice(-200) });
      send(client.ws, { type: 'chat-history', payload: world.chatLog.slice(-100) });
    }

    ws.on('message', raw => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (client.kind === 'iframe') {
        handleIframeMessage(client.sessionId, msg);
      } else {
        // debug-ui control messages handled in debug-api.ts via HTTP, not WS.
      }
    });

    ws.on('close', () => {
      clients.delete(client);
      if (client.kind === 'iframe' && client.sessionId) {
        const sid = client.sessionId;
        const t = setTimeout(() => {
          pendingIframeClose.delete(sid);
          world.appContentRemoved(sid);
        }, IFRAME_RECONNECT_GRACE_MS);
        pendingIframeClose.set(sid, t);
      }
    });
  });

  // Forward world events to debug-ui clients
  world.on('change', () => broadcastDebug({ type: 'snapshot', payload: world.snapshot() }));
  world.on('log',    e => broadcastDebug({ type: 'log',  payload: e }));
  world.on('chat',   e => broadcastDebug({ type: 'chat', payload: e }));
  world.on('app-content-shown', spec => {
    broadcastDebug({ type: 'app-content-shown', payload: spec });
    broadcastDebug({ type: 'snapshot', payload: world.snapshot() });
  });
  world.on('app-content-updated', spec => {
    broadcastDebug({ type: 'app-content-updated', payload: spec });
    broadcastDebug({ type: 'snapshot', payload: world.snapshot() });
  });
  world.on('app-content-removed', ({ sessionId }) => {
    broadcastDebug({ type: 'app-content-removed', payload: { sessionId } });
    broadcastDebug({ type: 'snapshot', payload: world.snapshot() });
    // also tell the iframe to close itself
    for (const c of clients) {
      if (c.kind === 'iframe' && c.sessionId === sessionId) {
        try { c.ws.close(); } catch {}
      }
    }
  });
  world.on('session-event', ({ sessionId, type, data }) => {
    // Forward to iframe with that session
    for (const c of clients) {
      if (c.kind === 'iframe' && c.sessionId === sessionId) {
        send(c.ws, { kind: 'event', type, data });
      }
    }
    // Also to debug-ui for visibility
    broadcastDebug({ type: 'session-event', payload: { sessionId, eventType: type, data } });
  });
  world.on('frontend-changed', appId => broadcastDebug({ type: 'frontend-changed', payload: { appId } }));
  world.on('external-apps-changed', () => broadcastDebug({ type: 'external-apps-changed', payload: null }));
}

function handleIframeMessage(sessionId: string, msg: any): void {
  if (!msg) return;
  // Find the app/session
  let appRec: AppRecord | undefined;
  let userId = -1;
  for (const a of world.apps.values()) {
    const spec = a.sessions.get(sessionId);
    if (spec) { appRec = a; userId = spec.userId; break; }
  }
  if (!appRec) {
    world.log({ ts: Date.now(), appId: 'unknown', level: 'warn', msg: `iframe message for unknown session ${sessionId}` });
    return;
  }

  if (msg.kind === 'event') {
    // Build session ref and dispatch into the sandbox.
    const session = sessionRefFor(appRec, sessionId);
    const user = lookupUser(appRec, userId);
    try {
      appRec.app?.onEventReceived?.(user, msg.type, msg.data, session);
    } catch (e: any) {
      world.log({ ts: Date.now(), appId: appRec.appId, level: 'error', msg: `onEventReceived threw: ${e?.message ?? e}` });
    }
    broadcastDebug({ type: 'frontend-event', payload: { appId: appRec.appId, sessionId, eventType: msg.type, data: msg.data } });
  } else if (msg.kind === 'slash') {
    // Forward to chatCommands handler
    handleSlashCommand(appRec.appId, userId, msg.command);
  } else if (msg.kind === 'close') {
    world.appContentRemoved(sessionId);
  } else if (msg.kind === 'host-frame') {
    applyHostFrameOp(sessionId, msg);
  } else if (msg.type === '__hello') {
    // ack
  }
}

function applyHostFrameOp(sessionId: string, msg: any): void {
  const patch: Partial<AppContentSpec> = {};
  switch (msg.op) {
    case 'setSize':
      patch.width = Number(msg.width);
      patch.height = Number(msg.height);
      break;
    case 'setMinSize':
      patch.minWidth = Number(msg.width);
      patch.minHeight = Number(msg.height);
      break;
    case 'setMaxSize':
      patch.maxWidth = Number(msg.width);
      patch.maxHeight = Number(msg.height);
      break;
    case 'setResizable':
      patch.resizable = !!msg.resizable;
      break;
    case 'setBackgroundColor':
      patch.backgroundColor = String(msg.color);
      patch.backgroundColorTransitionMs = Number(msg.durationMs) || 0;
      break;
    case 'setIcons':
      patch.iconUrl = String(msg.url);
      break;
    case 'setTitle':
      patch.title = String(msg.title);
      break;
    default:
      return;
  }
  world.updateAppContentSpec(sessionId, patch);
}

function sessionRefFor(appRec: AppRecord, sessionId: string): any {
  return {
    __sessionId: sessionId,
    getUser: () => lookupUser(appRec, appRec.sessions.get(sessionId)?.userId ?? -1),
    getAppViewMode: () => ({ name: appRec.sessions.get(sessionId)?.appViewMode ?? 'Popup' }),
    getOpenTimestamp: () => new Date(),
    isConnectedUsingDirectConnection: () => false,
    getGlobalAppInstance: () => null,
    sendEvent: (type: string, data: any) => world.sendEventToSession(sessionId, type, data),
    remove: () => world.appContentRemoved(sessionId),
    getAppContent: () => null,
  };
}

function lookupUser(appRec: AppRecord, userId: number): any {
  const get = (appRec.context as any)?.__getUser as ((id: number) => any) | undefined;
  if (get) {
    try { return get(userId); } catch { /* unknown user — fall through */ }
  }
  const sim = world.users.get(userId);
  if (!sim) return null;
  // Minimal proxy if cache miss (shouldn't happen often)
  return {
    getUserId: () => sim.userId,
    getNick: () => sim.nick,
    getAge: () => sim.age,
    sendPrivateMessage: (msg: string) => world.chat({ ts: Date.now(), appId: appRec.appId, kind: 'private', fromUserId: world.defaultBotUserId, toUserIds: [userId], text: msg }),
  };
}

export function handleSlashCommand(appId: string, userId: number, raw: string): void {
  const appRec = world.apps.get(appId);
  if (!appRec) return;
  const trimmed = raw.replace(/^\//, '');
  const spaceIdx = trimmed.search(/\s/);
  const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const params = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);
  const handler = appRec.app?.chatCommands?.[cmd];
  if (typeof handler !== 'function') {
    world.log({ ts: Date.now(), appId, level: 'warn', msg: `unknown slash command /${cmd}` });
    return;
  }
  const user = lookupUser(appRec, userId);
  try {
    handler(user, params, cmd);
  } catch (e: any) {
    world.log({ ts: Date.now(), appId, level: 'error', msg: `chatCommands.${cmd} threw: ${e?.message ?? e}` });
  }
}

function send(ws: WebSocket, msg: any) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcastDebug(msg: any) {
  for (const c of clients) {
    if (c.kind === 'debug') send(c.ws, msg);
  }
}
