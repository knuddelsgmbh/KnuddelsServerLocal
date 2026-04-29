import React, { useEffect, useState } from 'react';
import { useStore } from '../store.js';
import { postJson } from '../api/http.js';

const LEAGUES = ['bronze', 'silber', 'gold', 'smaragd', 'diamant', 'elite'] as const;
type League = typeof LEAGUES[number];

export function UserManager() {
  const users = useStore(s => s.snapshot.users);
  const defaultBotId = useStore(s => s.snapshot.defaultBotUserId);
  const [nick, setNick] = useState('');
  const [gender, setGender] = useState<'Male' | 'Female' | 'Unknown'>('Unknown');
  const [age, setAge] = useState(25);
  const [startLeague, setStartLeague] = useState<'' | League>('');
  const [err, setErr] = useState<string | null>(null);

  async function addUser() {
    setErr(null);
    if (!nick.trim()) return;
    try {
      const created = await postJson<{ ok: boolean; user: { userId: number; nick: string } }>(
        '/api/debug/createUser', { nick: nick.trim(), gender, age });
      if (startLeague && created.user) {
        // Skip onboarding + place in chosen league. Sent as the new user
        // themselves — IS_TEST_SYSTEM=true means hasDevPermission() passes
        // for any sender, so this is the simplest reliable choice.
        await postJson('/api/debug/slashCommand', {
          userId: created.user.userId,
          command: `/LSSkipOnboarding ${created.user.nick}:${startLeague}`,
        });
      }
      setNick('');
      setStartLeague('');
    } catch (e: any) {
      setErr(e.message);
    }
  }
  async function joinLeave(userId: number, isInChannel: boolean) {
    const path = isInChannel ? '/api/debug/userLeft' : '/api/debug/userJoined';
    await postJson(path, { userId });
  }
  async function deleteUser(userId: number) {
    if (userId === defaultBotId) return;
    if (!confirm('User wirklich löschen? Triggert onUserDeleted in allen Apps.')) return;
    await postJson('/api/debug/deleteUser', { userId });
  }
  async function setFlag(userId: number, flag: 'isChannelOwner' | 'isAppManager', value: boolean) {
    await postJson('/api/debug/setUserFlags', { userId, [flag]: value });
  }

  return (
    <div>
      <div className="card">
        <h3>Neuen User anlegen</h3>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input placeholder="Nick" value={nick} onChange={e => setNick(e.target.value)} />
          <select value={gender} onChange={e => setGender(e.target.value as any)}>
            <option value="Unknown">Unknown</option>
            <option value="Female">Female</option>
            <option value="Male">Male</option>
          </select>
          <input type="number" min={1} max={120} value={age} onChange={e => setAge(Number(e.target.value))} style={{ maxWidth: 80 }} />
          <select value={startLeague} onChange={e => setStartLeague(e.target.value as any)} title="LevelingSystem-Start-Liga">
            <option value="">Liga: kein Override</option>
            {LEAGUES.map(l => <option key={l} value={l}>Liga: {l}</option>)}
          </select>
          <button onClick={addUser}>Anlegen</button>
        </div>
        <p className="small muted" style={{ marginTop: 6, marginBottom: 0 }}>
          Bei gewählter Liga wird direkt nach dem Anlegen <code>/LSSkipOnboarding &lt;nick&gt;:&lt;liga&gt;</code> ausgeführt
          (funktioniert nur, wenn die geladene App diesen Cheat-Command registriert hat — z.B. <code>crash-userapp</code>).
        </p>
        {err && <p className="small" style={{ color: 'var(--red)', marginTop: 6 }}>{err}</p>}
      </div>

      <div className="card">
        <h3>Users ({users.length})</h3>
        <table>
          <thead>
            <tr><th></th><th>ID</th><th>Nick</th><th>Type</th><th>Status</th><th>Gender</th><th>Age</th><th>Rollen</th><th>im Channel</th><th></th></tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.userId}>
                <td><Avatar userId={u.userId} nick={u.nick} userType={u.userType} /></td>
                <td className="muted">{u.userId}</td>
                <td><strong>{u.nick}</strong></td>
                <td>{u.userType}</td>
                <td>{u.status}</td>
                <td>{u.gender}</td>
                <td>{u.age}</td>
                <td>
                  <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                    <label className="row small" style={{ gap: 4 }}>
                      <input type="checkbox"
                             checked={u.isChannelOwner}
                             onChange={e => setFlag(u.userId, 'isChannelOwner', e.target.checked)}
                             style={{ width: 'auto' }} />
                      <span>Owner</span>
                    </label>
                    <label className="row small" style={{ gap: 4 }}>
                      <input type="checkbox"
                             checked={u.isAppManager}
                             onChange={e => setFlag(u.userId, 'isAppManager', e.target.checked)}
                             style={{ width: 'auto' }} />
                      <span>AppMgr</span>
                    </label>
                  </div>
                </td>
                <td>
                  <span className={`pill ${u.isInChannel ? 'in' : 'out'}`}>
                    {u.isInChannel ? 'drin' : 'draussen'}
                  </span>
                </td>
                <td>
                  <div className="row">
                    {u.userType === 'Human' && (
                      <button onClick={() => joinLeave(u.userId, u.isInChannel)}>
                        {u.isInChannel ? 'Leave' : 'Join'}
                      </button>
                    )}
                    {u.userId !== defaultBotId && u.userType === 'Human' && (
                      <button onClick={() => deleteUser(u.userId)}>Löschen</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <LevelingControls
        users={users.map(u => ({ userId: u.userId, nick: u.nick, userType: u.userType }))}
      />
    </div>
  );
}

type LSTarget = { userId: number; nick: string; userType: string };

function LevelingControls({ users }: { users: LSTarget[] }) {
  const humans = users.filter(u => u.userType === 'Human');
  const [targetId, setTargetId] = useState<number | null>(null);
  const [league, setLeague] = useState<League>('bronze');
  const [level, setLevel] = useState(1);
  const [status, setStatus] = useState<{ kind: 'idle' } | { kind: 'ok'; msg: string } | { kind: 'err'; msg: string }>({ kind: 'idle' });

  // Default-target: erster Human, sobald die Liste verfügbar ist.
  useEffect(() => {
    if (targetId == null && humans.length > 0) setTargetId(humans[0]!.userId);
  }, [humans, targetId]);

  const target = humans.find(u => u.userId === targetId) ?? null;

  async function send(senderId: number, command: string, label: string) {
    try {
      await postJson('/api/debug/slashCommand', { userId: senderId, command });
      setStatus({ kind: 'ok', msg: `${label} → ${command}` });
    } catch (e: any) {
      setStatus({ kind: 'err', msg: `${label}: ${e?.message ?? String(e)}` });
    }
  }

  if (humans.length === 0) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Leveling-System</h3>
        <p className="small muted" style={{ marginBottom: 0 }}>Keine Human-User vorhanden — leg erst einen an.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Leveling-System</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        Triggert die LS-Cheat-Commands der geladenen App (<code>/LSSetLeague</code>, <code>/LSSkipOnboarding</code>, …).
        Funktioniert nur, wenn die App diese Commands registriert hat. Sender ist der gewählte Target-User
        (in der Test-Env passt <code>hasDevPermission()</code> für alle).
      </p>

      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 8 }}>
        <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="muted">User</span>
          <select value={targetId ?? ''} onChange={e => setTargetId(Number(e.target.value))}>
            {humans.map(u => <option key={u.userId} value={u.userId}>{u.nick} (#{u.userId})</option>)}
          </select>
        </label>

        <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="muted">Liga</span>
          <select value={league} onChange={e => setLeague(e.target.value as League)}>
            {LEAGUES.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>

        <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="muted">Level (in Liga)</span>
          <input type="number" min={1} max={999} value={level}
                 onChange={e => setLevel(Math.max(1, Number(e.target.value)))}
                 style={{ width: 80 }} />
        </label>
      </div>

      <div className="row" style={{ marginTop: 10, flexWrap: 'wrap', gap: 6 }}>
        <button disabled={!target}
                onClick={() => target && send(target.userId, `/LSSetLeague ${target.nick}:${league}`, 'Liga setzen')}>
          Liga setzen
        </button>
        <button disabled={!target}
                onClick={() => target && send(target.userId, `/LSSkipOnboarding ${target.nick}:${league}`, 'Onboarding skippen')}>
          Onboarding skippen
        </button>
        <button disabled={!target}
                onClick={() => target && send(target.userId, `/LSSETLevelForCurrentLeague ${level}`, 'Level setzen')}
                title="Setzt Level in der aktuellen Liga des Users; benötigt vorher 'Liga setzen' falls neuer User.">
          Level setzen
        </button>
        <button disabled={!target}
                onClick={() => target && send(target.userId, `/LSResetExp`, 'XP zurücksetzen')}>
          XP reset (→ bronze)
        </button>
        <button disabled={!target}
                onClick={() => target && send(target.userId, `/MCMDeactivateLevelingSystem ${target.nick}`, 'LS deaktivieren')}>
          LS deaktivieren
        </button>
        <button disabled={!target}
                onClick={() => target && send(target.userId, `/MCMActivateLevelingSystem ${target.nick}`, 'LS aktivieren')}>
          LS aktivieren
        </button>
      </div>

      {status.kind === 'ok'  && <p className="small" style={{ marginTop: 8, color: 'var(--green)' }}>{status.msg}</p>}
      {status.kind === 'err' && <p className="small" style={{ marginTop: 8, color: 'var(--red)' }}>{status.msg}</p>}
    </div>
  );
}

// Mirrors the URL scheme produced by makeUser().getProfilePhoto on the server
// so the debug UI shows the same avatar the UserApp will see.
function Avatar({ userId, nick, userType }: { userId: number; nick: string; userType: string }) {
  const size = 32;
  const url = userType === 'Human'
    ? `https://i.pravatar.cc/${size * 2}?img=${(((userId - 1) % 70) + 70) % 70 + 1}`
    : `https://api.dicebear.com/9.x/bottts/png?seed=${encodeURIComponent(nick || String(userId))}&size=${size * 2}`;
  return (
    <img
      src={url}
      alt={nick}
      width={size}
      height={size}
      style={{ borderRadius: '50%', display: 'block', objectFit: 'cover', border: '1px solid var(--border)' }}
      loading="lazy"
    />
  );
}
