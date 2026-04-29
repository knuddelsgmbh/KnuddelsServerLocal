import React, { useCallback, useEffect, useState } from 'react';
import { getJson, postJson } from '../api/http.js';
import { wsClient } from '../api/wsClient.js';

type ExternalAppView = {
  appDir: string;
  parentDir: string;
  source: 'env' | 'persisted';
  appId: string;
  status: 'loaded' | 'no-main' | 'pending' | 'error';
  error: string | null;
};

type Status = { kind: 'idle' } | { kind: 'busy'; msg: string } | { kind: 'err'; msg: string };

const APP_ID_RE = /^[a-zA-Z0-9._-]+$/;

function basename(absPath: string): string {
  const parts = absPath.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

export function ExternalAppsPanel() {
  const [items, setItems] = useState<ExternalAppView[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [hover, setHover] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [appIdInput, setAppIdInput] = useState('');
  // Track whether the user has manually edited the appId so we don't overwrite their input
  // when the path changes (e.g. via picker after a manual rename).
  const [appIdTouched, setAppIdTouched] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await getJson<{ items: ExternalAppView[] }>('/api/debug/externalApps');
      setItems(r.items);
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message ?? String(e) });
    }
  }, []);

  // Refresh on mount + whenever the server emits external-apps-changed.
  useEffect(() => {
    refresh();
    return wsClient.onMessage(msg => {
      if (msg.type === 'external-apps-changed') refresh();
    });
  }, [refresh]);

  const updatePath = useCallback((p: string) => {
    setPathInput(p);
    if (!appIdTouched) {
      const derived = basename(p);
      if (APP_ID_RE.test(derived)) setAppIdInput(derived);
    }
  }, [appIdTouched]);

  const submit = useCallback(async () => {
    const path = pathInput.trim();
    const appId = appIdInput.trim();
    if (!path || !appId) {
      setStatus({ kind: 'err', msg: 'Pfad und App-Name müssen angegeben werden.' });
      return;
    }
    setStatus({ kind: 'busy', msg: `füge hinzu: ${appId} → ${path}` });
    try {
      await postJson('/api/debug/externalApps', { path, appId });
      setStatus({ kind: 'idle' });
      setPathInput('');
      setAppIdInput('');
      setAppIdTouched(false);
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message ?? String(e) });
    }
  }, [pathInput, appIdInput]);

  const browse = useCallback(async () => {
    setStatus({ kind: 'busy', msg: 'öffne Ordner-Dialog…' });
    try {
      const r = await postJson<{ path: string | null }>('/api/debug/pickFolder', {});
      if (r.path) {
        updatePath(r.path);
        setStatus({ kind: 'idle' });
      } else {
        setStatus({ kind: 'idle' });
      }
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message ?? String(e) });
    }
  }, [updatePath]);

  const remove = useCallback(async (absPath: string) => {
    setStatus({ kind: 'busy', msg: `entferne ${absPath}` });
    try {
      await fetch('/api/debug/externalApps', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: absPath }),
      }).then(async r => {
        if (!r.ok) throw new Error((await r.json())?.error ?? r.statusText);
      });
      setStatus({ kind: 'idle' });
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message ?? String(e) });
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setHover(false);
    const dt = e.dataTransfer;

    // Preferred: text/uri-list contains file:// URLs from native file managers.
    const uriList = dt?.getData('text/uri-list') ?? '';
    const paths: string[] = [];
    for (const line of uriList.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('file://')) {
        try { paths.push(decodeURIComponent(new URL(trimmed).pathname)); } catch { /* ignore */ }
      }
    }

    // Fallback: text/plain (some terminals/apps drop a raw path).
    if (paths.length === 0) {
      const txt = (dt?.getData('text/plain') ?? '').trim();
      if (txt && (txt.startsWith('/') || txt.match(/^[a-zA-Z]:\\/))) paths.push(txt);
    }

    if (paths.length === 0) {
      setStatus({ kind: 'err', msg: 'Kein Pfad im Drop erkannt. Browser blockiert eventuell text/uri-list — nutze "Durchsuchen…" oder gib den Pfad manuell ein.' });
      return;
    }
    // Drag-and-drop fills the form so the user can confirm/edit the appId.
    updatePath(paths[0]!);
    if (paths.length > 1) {
      setStatus({ kind: 'err', msg: 'Mehrfach-Drop nicht unterstützt — nur der erste Pfad wurde übernommen.' });
    }
  }, [updatePath]);

  return (
    <div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Externe App-Ordner</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          Externe Ordner werden parallel zu <code>apps/</code> gewatched. Den App-Namen
          (= App-ID) gibst du beim Hinzufügen an — keine <code>app.config</code> nötig.
          Hinzugefügte Pfade überleben Server-Restarts (gespeichert in <code>.test-env/external-apps.json</code>).
        </p>

        <div
          onDragOver={e => { e.preventDefault(); setHover(true); }}
          onDragLeave={() => setHover(false)}
          onDrop={onDrop}
          style={{
            border: `2px dashed ${hover ? 'var(--accent)' : 'var(--border)'}`,
            background: hover ? 'rgba(122,167,255,0.08)' : 'var(--panel-2)',
            borderRadius: 8,
            padding: '14px 12px',
            textAlign: 'center',
            fontSize: 12,
            color: 'var(--muted)',
            marginTop: 8,
            transition: 'background 0.15s, border-color 0.15s',
          }}>
          <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
            Ordner aus Finder/Explorer hier ablegen
          </div>
          <div>oder Pfad unten eingeben / über den Dialog auswählen</div>
        </div>

        <div className="row" style={{ marginTop: 8, gap: 8, alignItems: 'stretch' }}>
          <input
            value={appIdInput}
            onChange={e => { setAppIdInput(e.target.value); setAppIdTouched(true); }}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            placeholder="app-name"
            style={{ width: 140 }}
          />
          <input
            value={pathInput}
            onChange={e => updatePath(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            placeholder="/absoluter/pfad/zum/app-ordner"
            style={{ flex: 1 }}
          />
          <button onClick={browse}>Durchsuchen…</button>
          <button onClick={submit} disabled={!pathInput.trim() || !appIdInput.trim()}>Hinzufügen</button>
        </div>

        {status.kind === 'busy' && <p className="small muted" style={{ marginTop: 8 }}>{status.msg}</p>}
        {status.kind === 'err'  && <p className="small" style={{ marginTop: 8, color: 'var(--red)' }}>{status.msg}</p>}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Registrierte Pfade ({items.length})</h3>
        {items.length === 0 && (
          <p className="small muted" style={{ marginTop: 0 }}>Noch keine externen Pfade registriert.</p>
        )}
        {items.map(it => <ExternalRow key={it.appDir} it={it} onRemove={() => remove(it.appDir)} />)}
      </div>
    </div>
  );
}

function ExternalRow({ it, onRemove }: { it: ExternalAppView; onRemove: () => void }) {
  const badgeColor =
    it.status === 'loaded'  ? 'var(--green)'  :
    it.status === 'error'   ? 'var(--red)'    :
    it.status === 'no-main' ? 'var(--yellow)' :
                              'var(--muted)';
  const badgeText =
    it.status === 'loaded'  ? `geladen: ${it.appId}` :
    it.status === 'error'   ? 'Fehler' :
    it.status === 'no-main' ? `${it.appId}: keine main.js gefunden` :
                              `${it.appId}: warte auf Ordner`;
  const hint =
    it.status === 'no-main'
      ? 'Der Ordner ist da, aber enthält keine main.js. Hast du den Build-Output-Ordner registriert (z.B. .../dist)?'
      : null;

  return (
    <div style={{
      padding: '8px 10px',
      border: '1px solid var(--border)',
      borderRadius: 6,
      marginBottom: 6,
      background: 'var(--panel-2)',
    }}>
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <code style={{ flex: 1, wordBreak: 'break-all' }}>{it.appDir}</code>
        <span style={{
          fontSize: 11,
          padding: '2px 6px',
          borderRadius: 3,
          background: 'var(--panel)',
          color: badgeColor,
          border: `1px solid ${badgeColor}`,
        }}>{badgeText}</span>
        <span className="small muted" style={{ fontSize: 11 }}>
          {it.source === 'env' ? 'KS_EXTERNAL_APPS' : 'UI'}
        </span>
        {it.source === 'persisted' ? (
          <button onClick={onRemove} style={{ fontSize: 11 }}>Entfernen</button>
        ) : (
          <span className="small muted" title="Über Env-Var gesetzt — entferne KS_EXTERNAL_APPS dafür" style={{ fontSize: 11, opacity: 0.5 }}>read-only</span>
        )}
      </div>
      {it.error && <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>{it.error}</div>}
      {hint && <div className="small muted" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
