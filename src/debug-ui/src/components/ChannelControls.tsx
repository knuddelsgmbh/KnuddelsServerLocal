import React, { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store.js';
import { getJson, postJson } from '../api/http.js';
import { wsClient } from '../api/wsClient.js';

type Profiles = {
  channels: string[];
  perApp: Record<string, { channels: string[]; hasGenericDev: boolean; hasGenericProd: boolean }>;
};

const CUSTOM_VALUE = '__custom__';

export function ChannelControls() {
  const channelName = useStore(s => s.snapshot.channelName);
  const topic = useStore(s => s.snapshot.topic);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(channelName);
  const [draftTopic, setDraftTopic] = useState(topic);
  const [profiles, setProfiles] = useState<Profiles>({ channels: [], perApp: {} });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refreshProfiles = useCallback(async () => {
    try {
      setProfiles(await getJson<Profiles>('/api/debug/featureFlagProfiles'));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }, []);

  // Re-detect profiles whenever apps load/unload. Triggered explicitly via
  // `external-apps-changed` (emitted by the watcher when an app mounts /
  // unmounts / a channel-driven reload completes). NOT subscribed to the
  // generic `snapshot` event — those fire on every game tick / persistence
  // flush in the running app, which would hammer the profiles endpoint and
  // freeze the UI.
  useEffect(() => {
    refreshProfiles();
    return wsClient.onMessage(msg => {
      if (msg.type === 'external-apps-changed') refreshProfiles();
    });
  }, [refreshProfiles]);

  function open() {
    setDraftName(channelName); setDraftTopic(topic); setErr(null); setEditing(true);
  }
  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await postJson<{ ok: boolean; reloaded: number }>(
        '/api/debug/topicChange',
        { channelName: draftName, topic: draftTopic },
      );
      setEditing(false);
      if (r.reloaded > 0) {
        // Profile-Liste neu ziehen — gerade reloadete Apps können andere Configs mitbringen.
        refreshProfiles();
      }
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  // Mismatch zwischen aktivem Channel-Name und vorhandenen Profilen anzeigen,
  // damit man sofort sieht, ob das gewählte Profil überhaupt greift.
  const active = activeProfileFor(channelName, profiles);

  return (
    <div>
      <h2>Channel</h2>
      {!editing ? (
        <div className="grid">
          <div><strong>{channelName}</strong></div>
          <div className="small muted">{topic || <em>kein Topic</em>}</div>
          <ProfileBadge active={active} channels={profiles.channels} />
          <button onClick={open}>Bearbeiten</button>
        </div>
      ) : (
        <ChannelEditor
          channelName={channelName}
          draftName={draftName} setDraftName={setDraftName}
          draftTopic={draftTopic} setDraftTopic={setDraftTopic}
          profiles={profiles}
          busy={busy} err={err}
          onCancel={() => { setEditing(false); setErr(null); }}
          onSave={save}
        />
      )}
    </div>
  );
}

function ChannelEditor({
  channelName, draftName, setDraftName, draftTopic, setDraftTopic,
  profiles, busy, err, onCancel, onSave,
}: {
  channelName: string;
  draftName: string; setDraftName: (s: string) => void;
  draftTopic: string; setDraftTopic: (s: string) => void;
  profiles: Profiles;
  busy: boolean; err: string | null;
  onCancel: () => void; onSave: () => void;
}) {
  const isCustom = !!draftName && !profiles.channels.includes(draftName);
  const select = isCustom ? CUSTOM_VALUE : draftName;

  return (
    <div className="grid">
      <select
        value={select}
        onChange={e => {
          const v = e.target.value;
          if (v === CUSTOM_VALUE) {
            // Switch in den Custom-Modus, aber den aktuellen Wert behalten.
            setDraftName(draftName === channelName && profiles.channels.includes(draftName) ? '' : draftName);
          } else {
            setDraftName(v);
          }
        }}
        disabled={busy}
      >
        {profiles.channels.length === 0 && (
          <option value={channelName}>{channelName} (kein App-Profil erkannt)</option>
        )}
        {profiles.channels.map(c => (
          <option key={c} value={c}>
            {c} {appsForChannel(c, profiles).length > 0 ? `(${appsForChannel(c, profiles).join(', ')})` : ''}
          </option>
        ))}
        <option value={CUSTOM_VALUE}>Custom…</option>
      </select>

      {(select === CUSTOM_VALUE || profiles.channels.length === 0) && (
        <input
          value={draftName}
          onChange={e => setDraftName(e.target.value)}
          placeholder="Channel-Name (frei)"
          disabled={busy}
        />
      )}

      <input
        value={draftTopic}
        onChange={e => setDraftTopic(e.target.value)}
        placeholder="Topic"
        disabled={busy}
      />

      <p className="small muted" style={{ margin: 0 }}>
        Beim Speichern werden alle geladenen Apps neu gestartet, damit das
        passende <code>featureFlags.&lt;channel&gt;.dev.js</code> aufgegriffen wird.
      </p>

      {err && <p className="small" style={{ color: 'var(--red)', margin: 0 }}>{err}</p>}

      <div className="row">
        <button onClick={onSave} disabled={busy || !draftName.trim()}>Speichern</button>
        <button onClick={onCancel} disabled={busy}>Abbrechen</button>
      </div>
    </div>
  );
}

function ProfileBadge({ active, channels }: { active: ActiveProfile; channels: string[] }) {
  const color =
    active.kind === 'channel-match' ? 'var(--green)' :
    active.kind === 'fallback'      ? 'var(--yellow)' :
                                      'var(--muted)';
  const label =
    active.kind === 'channel-match' ? `Profil: ${active.channel}` :
    active.kind === 'fallback'      ? 'Profil: featureFlags.dev.js (Fallback)' :
                                      'Kein App-Profil verfügbar';
  return (
    <span
      title={
        active.kind === 'channel-match' ? `Apps mit Match: ${active.appIds.join(', ')}` :
        active.kind === 'fallback'      ? `Channel-Name '${active.channelName}' hat kein passendes File; Apps fallen auf 'featureFlags.dev.js' zurück. Verfügbare Channel-Profile: ${channels.join(', ') || 'keine'}` :
                                          'Es ist keine App geladen oder keine App hat einen feature_flags/-Ordner.'
      }
      style={{
        fontSize: 11,
        padding: '2px 6px',
        borderRadius: 3,
        color, border: `1px solid ${color}`,
        alignSelf: 'flex-start',
      }}>
      {label}
    </span>
  );
}

type ActiveProfile =
  | { kind: 'channel-match'; channel: string; appIds: string[] }
  | { kind: 'fallback'; channelName: string }
  | { kind: 'none' };

function activeProfileFor(channelName: string, profiles: Profiles): ActiveProfile {
  if (Object.keys(profiles.perApp).length === 0) return { kind: 'none' };
  const matchingApps: string[] = [];
  for (const [appId, info] of Object.entries(profiles.perApp)) {
    if (info.channels.includes(channelName)) matchingApps.push(appId);
  }
  if (matchingApps.length > 0) return { kind: 'channel-match', channel: channelName, appIds: matchingApps };
  return { kind: 'fallback', channelName };
}

function appsForChannel(channel: string, profiles: Profiles): string[] {
  return Object.entries(profiles.perApp)
    .filter(([, info]) => info.channels.includes(channel))
    .map(([appId]) => appId);
}
