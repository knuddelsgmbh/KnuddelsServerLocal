import React, { useEffect, useRef, useState } from 'react';
import type { AppContentSpec } from '../store.js';
import { useStore } from '../store.js';
import { postJson } from '../api/http.js';

export function AppContentFrame({ spec }: { spec: AppContentSpec }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const version = useStore(s => s.frontendVersion[spec.appId] ?? 0);
  const users = useStore(s => s.snapshot.users);
  const app = useStore(s => s.snapshot.apps.find(a => a.appId === spec.appId));
  const [reloadKey, setReloadKey] = useState(0);
  const [liveBusy, setLiveBusy] = useState(false);

  const liveSource = app?.liveSource ?? false;
  const liveAvailable = app?.liveSourceAvailable ?? false;

  async function toggleLiveSource() {
    if (!liveAvailable || liveBusy) return;
    setLiveBusy(true);
    try {
      await postJson('/api/debug/liveSource', { appId: spec.appId, enabled: !liveSource });
    } catch (err) {
      console.error('[live-source] toggle failed', err);
    } finally {
      // Just an in-flight lock: toggling only flips routing now (the dev server
      // stays warm), so there's no process-kill race to guard against.
      setLiveBusy(false);
    }
  }

  // Auto-reload iframe when frontend files change.
  useEffect(() => {
    setReloadKey(k => k + 1);
  }, [version]);

  // Listen for postMessage('close') from the shim.
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.data?.kind === 'close' && ev.data?.sessionId === spec.sessionId) {
        postJson('/api/debug/closeSession', { sessionId: spec.sessionId });
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [spec.sessionId]);

  const url = `/app/${encodeURIComponent(spec.appId)}/${spec.assetPath}`
    + `?sessionId=${encodeURIComponent(spec.sessionId)}`
    + `&userId=${encodeURIComponent(String(spec.userId))}`
    + `&v=${reloadKey}`;
  const userNick = users.find(u => u.userId === spec.userId)?.nick ?? `#${spec.userId}`;

  return (
    <div className="app-frame">
      <div className="frame-header">
        <span>
          <span className="pill">{spec.appViewMode}</span>
          {' '}<strong>{userNick}</strong>
          {' · '}<code>{spec.sessionId}</code>
        </span>
        <span className="row">
          <button
            className={`live-toggle ${liveSource ? 'on' : 'off'}`}
            disabled={!liveAvailable || liveBusy}
            onClick={toggleLiveSource}
            title={
              !liveAvailable
                ? 'Live Source ist nur für externe App-Ordner mit Repo-Root verfügbar'
                : liveSource
                  ? 'Live Source AN — Frontend via ks start (HMR) + Backend via yarn watch. Klicken, um auf das gebaute dist/ zu wechseln.'
                  : 'Quelle: gebautes dist/. Klicken, um Live Source (HMR + watch) zu aktivieren.'
            }>
            {liveSource ? '● LIVE' : '○ dist'}
          </button>
          <button onClick={() => setReloadKey(k => k + 1)}>↻</button>
          <button onClick={() => postJson('/api/debug/closeSession', { sessionId: spec.sessionId })}>×</button>
        </span>
      </div>
      <iframe ref={ref}
              key={reloadKey}
              src={url}
              style={{ width: '100%', height: spec.height || 480 }}
              title={`${spec.appId}/${spec.sessionId}`} />
    </div>
  );
}
