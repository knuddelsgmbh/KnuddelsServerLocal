import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useStore } from '../store.js';
import { postJson } from '../api/http.js';

type Mode = 'public' | 'private' | 'action' | 'slash';

export function ChatSimulator() {
  const users = useStore(s => s.snapshot.users);
  const apps = useStore(s => s.snapshot.apps);
  const chats = useStore(s => s.chats);
  const humans = useMemo(() => users.filter(u => u.userType === 'Human'), [users]);
  const [userId, setUserId] = useState<number>(humans[0]?.userId ?? 100);
  const [mode, setMode] = useState<Mode>('public');
  const [text, setText] = useState('');
  const [appId, setAppId] = useState<string>('');
  const [actionFn, setActionFn] = useState('action');
  const [err, setErr] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // keep userId valid
  React.useEffect(() => {
    if (!humans.find(u => u.userId === userId) && humans[0]) setUserId(humans[0].userId);
  }, [humans, userId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [chats]);

  function userNick(id: number) { return users.find(u => u.userId === id)?.nick ?? `#${id}`; }

  async function send() {
    setErr(null);
    if (!text.trim()) return;
    try {
      if (mode === 'public') {
        await postJson('/api/debug/publicMessage', { userId, text });
      } else if (mode === 'private') {
        await postJson('/api/debug/privateMessage', { userId, text });
      } else if (mode === 'action') {
        await postJson('/api/debug/actionMessage', { userId, text, functionName: actionFn });
      } else if (mode === 'slash') {
        const cmd = text.startsWith('/') ? text : `/${text}`;
        await postJson('/api/debug/slashCommand', { userId, command: cmd, appId: appId || undefined });
      }
      setText('');
    } catch (e: any) {
      setErr(e.message);
    }
  }

  // auto-detect slash from input
  const detectedSlash = text.startsWith('/');

  return (
    <div>
      <div className="card">
        <h3>Chat-Simulator</h3>
        <div className="grid">
          <div className="row">
            <label className="muted small" style={{ minWidth: 70 }}>Als User</label>
            <select value={userId} onChange={e => setUserId(Number(e.target.value))} style={{ maxWidth: 220 }}>
              {humans.map(u => <option key={u.userId} value={u.userId}>{u.nick} (#{u.userId})</option>)}
            </select>
            <label className="muted small" style={{ marginLeft: 12 }}>Modus</label>
            <select value={mode} onChange={e => setMode(e.target.value as Mode)} style={{ maxWidth: 180 }}>
              <option value="public">Public</option>
              <option value="private">Private (an Bot)</option>
              <option value="action">Action</option>
              <option value="slash">Slashcommand</option>
            </select>
          </div>
          {mode === 'action' && (
            <div className="row">
              <label className="muted small" style={{ minWidth: 70 }}>fn name</label>
              <input value={actionFn} onChange={e => setActionFn(e.target.value)} />
            </div>
          )}
          {mode === 'slash' && (
            <div className="row">
              <label className="muted small" style={{ minWidth: 70 }}>App</label>
              <select value={appId} onChange={e => setAppId(e.target.value)} style={{ maxWidth: 280 }}>
                <option value="">(automatisch — erste passende)</option>
                {apps.map(a => <option key={a.appId} value={a.appId}>{a.appId}</option>)}
              </select>
            </div>
          )}
          <textarea rows={3}
                    placeholder={mode === 'slash' ? '/meinCommand argumente' : 'Nachricht…'}
                    value={text}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <div className="row">
            <button onClick={send}>Senden</button>
            {detectedSlash && mode !== 'slash' && (
              <span className="small muted">Tipp: Wechsle in den <em>Slashcommand</em>-Modus für <code>{text}</code></span>
            )}
            {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Chat-Verlauf</h3>
        <div className="log" ref={logRef}>
          {chats.length === 0 && <div className="muted small">noch nichts</div>}
          {chats.map((c, i) => {
            const dt = new Date(c.ts).toLocaleTimeString();
            const from = userNick(c.fromUserId);
            const to = c.toUserIds?.map(userNick).join(', ');
            return (
              <div key={i} className="line">
                <span className="meta">{dt}</span>
                <span className="meta">[{c.kind === 'in-app' && c.chatGroupId ? `in-app:${c.chatGroupId}` : c.kind}]</span>
                <strong>{from}</strong>
                {(c.kind === 'private' || c.kind === 'in-app') && to && <> → <em>{to}</em></>}
                <>: </>{c.text}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
