import React from 'react';
import { useStore, selectApp } from '../store.js';

export function AppSelector() {
  const apps = useStore(s => s.snapshot.apps);
  const selected = useStore(s => s.selectedAppId);

  async function deleteApp(appId: string) {
    if (!confirm(`App "${appId}" löschen? Die Dateien unter apps/${appId}/ werden entfernt.`)) return;
    const r = await fetch(`/api/debug/app/${encodeURIComponent(appId)}`, { method: 'DELETE' });
    if (!r.ok) alert(await r.text());
  }

  async function restartApp(appId: string) {
    const r = await fetch(`/api/debug/app/${encodeURIComponent(appId)}/restart`, { method: 'POST' });
    if (!r.ok) alert(await r.text());
  }

  return (
    <div>
      <h2>Geladene Apps</h2>
      {apps.length === 0 && <p className="small muted">noch keine</p>}
      <div className="grid">
        {apps.map(a => (
          <div key={a.appId}
               style={{
                 background: selected === a.appId ? 'var(--panel-2)' : 'transparent',
                 border: `1px solid ${selected === a.appId ? 'var(--accent)' : 'var(--border)'}`,
                 borderRadius: 6,
                 padding: '6px 8px',
                 display: 'flex',
                 alignItems: 'center',
                 gap: 6,
               }}>
            <button onClick={() => selectApp(a.appId)}
                    style={{
                      flex: 1,
                      textAlign: 'left',
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                    }}>
              <div style={{ fontWeight: 600 }}>{a.appId}</div>
              <div className="small muted">{a.sessions.length} Session(s)</div>
            </button>
            <button title="App neu starten"
                    onClick={() => restartApp(a.appId)}
                    style={{ padding: '2px 8px', fontSize: 14 }}>↻</button>
            <button title="App löschen"
                    onClick={() => deleteApp(a.appId)}
                    style={{ padding: '2px 8px', fontSize: 14 }}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}
