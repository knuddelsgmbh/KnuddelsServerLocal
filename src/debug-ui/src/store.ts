import { useSyncExternalStore } from 'react';
import { wsClient, type WsMessage } from './api/wsClient.js';

export type SimUser = {
  userId: number;
  nick: string;
  gender: 'Male' | 'Female' | 'Unknown';
  age: number;
  status: string;
  userType: 'Human' | 'AppBot' | 'SystemBot';
  isInChannel: boolean;
  isChannelOwner: boolean;
  isAppManager: boolean;
  knuddel: number;
};

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

export type AppSnap = {
  appId: string;
  appDir: string;
  config: Record<string, string>;
  sessions: AppContentSpec[];
  /** App is currently served live (ks start + yarn watch) vs frozen from dist/. */
  liveSource: boolean;
  /** Whether Live Source can be toggled (external app with a repo root). */
  liveSourceAvailable: boolean;
};

export type Snapshot = {
  channelName: string;
  topic: string;
  defaultBotUserId: number;
  users: SimUser[];
  apps: AppSnap[];
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

type State = {
  connected: boolean;
  snapshot: Snapshot;
  logs: LogEntry[];
  chats: ChatLogEntry[];
  selectedAppId: string | null;
  selectedTab: TabId;
  // bumped whenever a frontend file changed, used to refresh iframes
  frontendVersion: Record<string, number>;
};

export type TabId = 'apps' | 'externalApps' | 'users' | 'chat' | 'simulation' | 'events' | 'persistence' | 'logs';

const initialSnapshot: Snapshot = {
  channelName: 'TestChannel', topic: '', defaultBotUserId: 1, users: [], apps: [],
};

let state: State = {
  connected: false,
  snapshot: initialSnapshot,
  logs: [],
  chats: [],
  selectedAppId: null,
  selectedTab: 'apps',
  frontendVersion: {},
};

const subs = new Set<() => void>();
function emit() { for (const s of subs) s(); }
function setState(patch: Partial<State>) {
  state = { ...state, ...patch };
  emit();
}

export function getState(): State { return state; }
export function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

export function selectApp(appId: string | null) { setState({ selectedAppId: appId }); }
export function selectTab(tab: TabId) { setState({ selectedTab: tab }); }

// ---- WS wiring ----
wsClient.onStatus(connected => setState({ connected }));
wsClient.onMessage((msg: WsMessage) => {
  switch (msg.type) {
    case 'snapshot': {
      const snap = msg.payload as Snapshot;
      // auto-select first app if none yet
      const next: Partial<State> = { snapshot: snap };
      if (!state.selectedAppId && snap.apps.length > 0) {
        next.selectedAppId = snap.apps[0].appId;
      }
      // if selected app vanished, clear selection
      if (state.selectedAppId && !snap.apps.some(a => a.appId === state.selectedAppId)) {
        next.selectedAppId = snap.apps[0]?.appId ?? null;
      }
      setState(next);
      break;
    }
    case 'log-history': setState({ logs: msg.payload as LogEntry[] }); break;
    case 'chat-history': setState({ chats: msg.payload as ChatLogEntry[] }); break;
    case 'log': {
      const next = [...state.logs, msg.payload as LogEntry];
      if (next.length > 1000) next.splice(0, next.length - 1000);
      setState({ logs: next });
      break;
    }
    case 'chat': {
      const next = [...state.chats, msg.payload as ChatLogEntry];
      if (next.length > 500) next.splice(0, next.length - 500);
      setState({ chats: next });
      break;
    }
    case 'frontend-changed': {
      const id = (msg.payload?.appId ?? '') as string;
      if (!id) break;
      setState({
        frontendVersion: { ...state.frontendVersion, [id]: (state.frontendVersion[id] ?? 0) + 1 },
      });
      break;
    }
    // app-content-shown / app-content-removed handled implicitly via snapshot resync
  }
});
wsClient.connect();
