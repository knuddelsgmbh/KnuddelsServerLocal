import React, { useEffect, useRef, useState } from 'react';
import type { AppContentSpec } from '../store.js';
import { useStore } from '../store.js';
import { postJson } from '../api/http.js';

// Default frame resolution for every session. Both axes are freely resizable
// via the corner drag handle so responsive behavior can be exercised — there
// is intentionally no min-width / fixed-height coming from the app spec.
const DEFAULT_FRAME_WIDTH = 756;
const DEFAULT_FRAME_HEIGHT = 476;
const MIN_FRAME_SIZE = 120;

export function AppContentFrame({ spec }: { spec: AppContentSpec }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const version = useStore(s => s.frontendVersion[spec.appId] ?? 0);
  const users = useStore(s => s.snapshot.users);
  const app = useStore(s => s.snapshot.apps.find(a => a.appId === spec.appId));
  const [reloadKey, setReloadKey] = useState(0);
  const [liveBusy, setLiveBusy] = useState(false);
  const [size, setSize] = useState({ width: DEFAULT_FRAME_WIDTH, height: DEFAULT_FRAME_HEIGHT });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);

  function onResizeStart(e: React.PointerEvent) {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, startW: size.width, startH: size.height };
    setDragging(true);
    (e.target as Element).setPointerCapture(e.pointerId);
  }
  function onResizeMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    setSize({
      width: Math.max(MIN_FRAME_SIZE, Math.round(d.startW + (e.clientX - d.startX))),
      height: Math.max(MIN_FRAME_SIZE, Math.round(d.startH + (e.clientY - d.startY))),
    });
  }
  function onResizeEnd(e: React.PointerEvent) {
    dragRef.current = null;
    setDragging(false);
    try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  }
  function resetSize() {
    setSize({ width: DEFAULT_FRAME_WIDTH, height: DEFAULT_FRAME_HEIGHT });
  }

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

  // The frame is freely resizable on both axes (default 756x476). We deliberately
  // ignore the app's min/fixed sizing here so responsive behavior can be tested
  // by dragging the corner handle.
  const frameStyle: React.CSSProperties = {
    width: size.width,
    height: size.height,
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
            className="size-reset"
            onClick={resetSize}
            title={`Auf Standardgröße zurücksetzen (${DEFAULT_FRAME_WIDTH}×${DEFAULT_FRAME_HEIGHT})`}>
            {size.width}×{size.height}
          </button>
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
      <div className="frame-viewport" style={frameStyle}>
        <iframe ref={ref}
                key={reloadKey}
                src={url}
                style={{ pointerEvents: dragging ? 'none' : 'auto' }}
                title={titleLabel} />
        <div
          className={`resize-dot ${dragging ? 'dragging' : ''}`}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          title="Ziehen, um Breite & Höhe anzupassen" />
      </div>
    </div>
  );
}
