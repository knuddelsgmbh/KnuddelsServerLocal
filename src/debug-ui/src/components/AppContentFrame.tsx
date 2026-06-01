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

  // Headerbar/Global modes always span the container width — only height is honored
  // from `setSize`. Popup/Overlay honor both width and height.
  const isFullWidth = spec.appViewMode === 'Headerbar' || spec.appViewMode === 'Global';
  const iframeStyle: React.CSSProperties = {
    width: isFullWidth ? '100%' : (spec.width || '100%'),
    height: spec.height || 480,
    minWidth: !isFullWidth ? spec.minWidth : undefined,
    minHeight: spec.minHeight,
    maxWidth: !isFullWidth ? spec.maxWidth : undefined,
    maxHeight: spec.maxHeight,
    background: spec.backgroundColor,
    transition: spec.backgroundColorTransitionMs
      ? `background-color ${spec.backgroundColorTransitionMs}ms`
      : undefined,
  };
  const titleLabel = spec.title || `${spec.appId}/${spec.sessionId}`;
  const lc = spec.loadConfig;
  const showLoadBanner = lc && lc.enabled && (lc.text || lc.backgroundColor || lc.foregroundColor || lc.backgroundImage || lc.loadingIndicatorImage);

  return (
    <div className="app-frame">
      <div className="frame-header">
        <span>
          <span className="pill">{spec.appViewMode}</span>
          {' '}<strong>{userNick}</strong>
          {' · '}<code>{spec.sessionId}</code>
          {spec.title ? <> {' · '}<em>{spec.title}</em></> : null}
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
      {showLoadBanner && (
        <div className="frame-header" style={{
          background: lc!.backgroundColor ?? undefined,
          color: lc!.foregroundColor ?? undefined,
          backgroundImage: lc!.backgroundImage ? `url(/app/${encodeURIComponent(spec.appId)}/${lc!.backgroundImage})` : undefined,
          backgroundSize: 'cover',
          fontStyle: 'italic',
        }}>
          <span>
            <span className="pill">LoadConfig</span>
            {lc!.loadingIndicatorImage && (
              <img src={`/app/${encodeURIComponent(spec.appId)}/${lc!.loadingIndicatorImage}`}
                   alt="" style={{ height: 16, marginLeft: 6, verticalAlign: 'middle' }}
                   onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
            )}
            {' '}{lc!.text || <em>(kein Text)</em>}
          </span>
        </div>
      )}
      <iframe ref={ref}
              key={reloadKey}
              src={url}
              style={iframeStyle}
              title={titleLabel} />
    </div>
  );
}
