import React from 'react';
import { useStore, selectTab, type TabId } from './store.js';
import { AppSelector } from './components/AppSelector.js';
import { AppDropzone } from './components/AppDropzone.js';
import { UserManager } from './components/UserManager.js';
import { ChannelControls } from './components/ChannelControls.js';
import { ChatSimulator } from './components/ChatSimulator.js';
import { SimulationPanel } from './components/SimulationPanel.js';
import { EventTrigger } from './components/EventTrigger.js';
import { PersistenceViewer } from './components/PersistenceViewer.js';
import { LogPanel } from './components/LogPanel.js';
import { AppContentFrame } from './components/AppContentFrame.js';
import { ExternalAppsPanel } from './components/ExternalAppsPanel.js';

const TABS: { id: TabId; label: string }[] = [
  { id: 'apps',         label: 'Apps & Sessions' },
  { id: 'externalApps', label: 'Externe Ordner' },
  { id: 'users',        label: 'User' },
  { id: 'chat',         label: 'Chat' },
  { id: 'simulation',   label: 'Simulation' },
  { id: 'events',       label: 'Events' },
  { id: 'persistence',  label: 'Persistence' },
  { id: 'logs',         label: 'Logs' },
];

export function App() {
  const tab = useStore(s => s.selectedTab);
  const connected = useStore(s => s.connected);

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>Knuddels UserApps</h1>
        <div className="conn">
          <span className={`dot ${connected ? 'ok' : 'bad'}`} />
          {connected ? 'Server verbunden' : 'Keine Verbindung zu :3000'}
        </div>

        <ChannelControls />
        <AppDropzone />
        <AppSelector />
      </aside>

      <div className="main">
        <nav className="tabs">
          {TABS.map(t => (
            <div key={t.id}
                 className={`tab ${tab === t.id ? 'active' : ''}`}
                 onClick={() => selectTab(t.id)}>
              {t.label}
            </div>
          ))}
        </nav>
        <section className="content">
          {/* AppsTab stays mounted so UserApp iframes don't reload on tab switch */}
          <div style={{ display: tab === 'apps' ? 'block' : 'none' }}><AppsTab /></div>
          {tab === 'externalApps' && <ExternalAppsPanel />}
          {tab === 'users'        && <UserManager />}
          {tab === 'chat'         && <ChatSimulator />}
          {tab === 'simulation'   && <SimulationPanel />}
          {tab === 'events'       && <EventTrigger />}
          {tab === 'persistence'  && <PersistenceViewer />}
          {tab === 'logs'         && <LogPanel />}
        </section>
      </div>
    </div>
  );
}

function AppsTab() {
  const apps = useStore(s => s.snapshot.apps);
  const selectedAppId = useStore(s => s.selectedAppId);
  const selected = apps.find(a => a.appId === selectedAppId);
  if (!selected) {
    return (
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>Keine App geladen.</p>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Entweder einen Ordner mit <code>main.js</code> unter <code>apps/&lt;app-id&gt;/</code> ablegen,
          oder im Tab <strong>Externe Ordner</strong> einen externen App-Ordner registrieren.
          Bei Build-Pipelines (TS / webpack) gibst du den Pfad zum Build-Output an
          (typischerweise <code>…/dist</code>).
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="card">
        <h3>{selected.appId}</h3>
        <div className="small muted">{selected.appDir}</div>
        <div className="small" style={{ marginTop: 8 }}>
          {Object.entries(selected.config).map(([k, v]) => (
            <div key={k}><code>{k}</code> = <code>{v}</code></div>
          ))}
        </div>
      </div>
      <div className="card">
        <h3>Aktive Sessions ({selected.sessions.length})</h3>
        {selected.sessions.length === 0 && (
          <p className="muted small">Keine offenen AppContent-Sessions. Trigger ein <code>user.sendAppContent(...)</code> aus der App heraus.</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
          {selected.sessions.map(s => <AppContentFrame key={s.sessionId} spec={s} />)}
        </div>
      </div>
    </div>
  );
}
