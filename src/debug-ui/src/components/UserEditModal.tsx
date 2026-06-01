import React, { useState } from 'react';
import { postJson } from '../api/http.js';
import type {
  SimUser,
  SimGender,
  SimGenderDetailed,
  SimUserStatus,
  SimUserType,
  SimClientType,
  SimChannelTalkPermission,
  SimAuthenticityClassification,
} from '../store.js';

const GENDER_OPTS: SimGender[] = ['Male', 'Female', 'Unknown'];
const GENDER_DETAILED_OPTS: SimGenderDetailed[] = ['Male', 'Female', 'NonBinaryHe', 'NonBinaryShe', 'Unknown'];
const STATUS_OPTS: SimUserStatus[] = ['Newbie', 'Family', 'Stammi', 'HonoryMember', 'Admin', 'SystemBot', 'Sysadmin'];
const USERTYPE_OPTS: SimUserType[] = ['Human', 'AppBot', 'SystemBot'];
const CLIENTTYPE_OPTS: SimClientType[] = ['Applet', 'Browser', 'Android', 'IOS', 'Offline', 'Web', 'MobileWeb'];
const TALKPERM_OPTS: SimChannelTalkPermission[] = ['NotInChannel', 'Default', 'TalkOnce', 'TalkPermanent', 'VIP', 'Moderator'];
const AUTH_OPTS: SimAuthenticityClassification[] = ['ServiceNotAvailable', 'Unknown', 'Trusted', 'VeryTrusted'];

function dateLocalFromMs(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  // YYYY-MM-DDTHH:MM (local)
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function msFromDateLocal(s: string): number {
  if (!s) return Date.now();
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : Date.now();
}

export function UserEditModal({ user, onClose }: { user: SimUser; onClose: () => void }) {
  const [form, setForm] = useState<SimUser>(user);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function up<K extends keyof SimUser>(key: K, value: SimUser[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  async function save() {
    setErr(null);
    setSaving(true);
    try {
      const { userId, nicklistIcons: _nl, isInChannel: _ic, ...patch } = form;
      const res = await postJson<{ ok: boolean; user: SimUser }>('/api/debug/updateUser', { userId, ...patch });
      if (!res || !(res as any).ok) throw new Error('Update fehlgeschlagen');
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" onClick={e => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>User bearbeiten · <code>{user.nick}</code> (#{user.userId})</h3>
          <button onClick={onClose} aria-label="Schliessen">×</button>
        </div>

        <h4 style={{ marginBottom: 4 }}>Basics</h4>
        <div className="grid2">
          <Field label="Nick"><input value={form.nick} onChange={e => up('nick', e.target.value)} /></Field>
          <Field label="Age"><input type="number" min={1} max={120} value={form.age} onChange={e => up('age', Number(e.target.value))} /></Field>
          <Field label="Gender"><Select value={form.gender} options={GENDER_OPTS} onChange={v => up('gender', v as SimGender)} /></Field>
          <Field label="Gender (detailed)"><Select value={form.genderDetailed} options={GENDER_DETAILED_OPTS} onChange={v => up('genderDetailed', v as SimGenderDetailed)} /></Field>
          <Field label="UserType"><Select value={form.userType} options={USERTYPE_OPTS} onChange={v => up('userType', v as SimUserType)} /></Field>
          <Field label="Status"><Select value={form.status} options={STATUS_OPTS} onChange={v => up('status', v as SimUserStatus)} /></Field>
        </div>

        <h4 style={{ marginBottom: 4 }}>Client</h4>
        <div className="grid2">
          <Field label="ClientType"><Select value={form.clientType} options={CLIENTTYPE_OPTS} onChange={v => up('clientType', v as SimClientType)} /></Field>
          <Check label="K3-Client" checked={form.isK3Client} onChange={v => up('isK3Client', v)} />
        </div>

        <h4 style={{ marginBottom: 4 }}>Permissions</h4>
        <div className="grid2">
          <Check label="ChannelOwner" checked={form.isChannelOwner} onChange={v => up('isChannelOwner', v)} />
          <Check label="ChannelModerator" checked={form.isChannelModerator} onChange={v => up('isChannelModerator', v)} />
          <Check label="ChannelCoreUser" checked={form.isChannelCoreUser} onChange={v => up('isChannelCoreUser', v)} />
          <Check label="EventModerator" checked={form.isEventModerator} onChange={v => up('isEventModerator', v)} />
          <Check label="InTeam" checked={form.isInTeam} onChange={v => up('isInTeam', v)} />
          <Check label="AppManager" checked={form.isAppManager} onChange={v => up('isAppManager', v)} />
          <Field label="ChannelTalkPermission"><Select value={form.channelTalkPermission} options={TALKPERM_OPTS} onChange={v => up('channelTalkPermission', v as SimChannelTalkPermission)} /></Field>
        </div>

        <h4 style={{ marginBottom: 4 }}>State</h4>
        <div className="grid2">
          <Check label="Away" checked={form.isAway} onChange={v => up('isAway', v)} />
          <Check label="Locked" checked={form.isLocked} onChange={v => up('isLocked', v)} />
          <Check label="Muted" checked={form.isMuted} onChange={v => up('isMuted', v)} />
          <Check label="ColorMuted" checked={form.isColorMuted} onChange={v => up('isColorMuted', v)} />
          <Check label="LikingChannel" checked={form.isLikingChannel} onChange={v => up('isLikingChannel', v)} />
          <Check label="StreamingVideo" checked={form.isStreamingVideo} onChange={v => up('isStreamingVideo', v)} />
          <Check label="AgeVerified" checked={form.isAgeVerified} onChange={v => up('isAgeVerified', v)} />
        </div>

        <h4 style={{ marginBottom: 4 }}>Profile</h4>
        <div className="grid2">
          <Field label="ProfilePhoto (URL)"><input value={form.profilePhoto} onChange={e => up('profilePhoto', e.target.value)} /></Field>
          <Field label="AuthenticityClassification"><Select value={form.authenticityClassification} options={AUTH_OPTS} onChange={v => up('authenticityClassification', v as SimAuthenticityClassification)} /></Field>
          <Check label="HasProfilePhoto" checked={form.hasProfilePhoto} onChange={v => up('hasProfilePhoto', v)} />
          <Check label="ProfilePhotoVerified" checked={form.isProfilePhotoVerified} onChange={v => up('isProfilePhotoVerified', v)} />
        </div>
        <Field label="Readme">
          <textarea rows={3} value={form.readme} onChange={e => up('readme', e.target.value)} style={{ width: '100%' }} />
        </Field>

        <h4 style={{ marginBottom: 4 }}>Activity</h4>
        <div className="grid2">
          <Field label="OnlineMinutes"><input type="number" min={0} value={form.onlineMinutes} onChange={e => up('onlineMinutes', Number(e.target.value))} /></Field>
          <Field label="RegDate">
            <input type="datetime-local" value={dateLocalFromMs(form.regDate)} onChange={e => up('regDate', msFromDateLocal(e.target.value))} />
          </Field>
          <Field label="LastOnlineTime">
            <input type="datetime-local" value={dateLocalFromMs(form.lastOnlineTime)} onChange={e => up('lastOnlineTime', msFromDateLocal(e.target.value))} />
          </Field>
        </div>

        <h4 style={{ marginBottom: 4 }}>Knuddel</h4>
        <div className="grid2">
          <Field label="KnuddelAmount"><input type="number" min={0} value={form.knuddelAmount} onChange={e => up('knuddelAmount', Number(e.target.value))} /></Field>
          <Field label="MaxKnuddelToApp"><input type="number" min={0} value={form.maxKnuddelToApp} onChange={e => up('maxKnuddelToApp', Number(e.target.value))} /></Field>
        </div>

        {err && <p className="small" style={{ color: 'var(--red)', marginTop: 8 }}>{err}</p>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onClose} disabled={saving}>Abbrechen</button>
          <button onClick={save} disabled={saving}>{saving ? 'Speichern…' : 'Speichern'}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="small muted">{label}</span>
      {children}
    </label>
  );
}

function Select({ value, options, onChange }: { value: string; options: readonly string[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row small" style={{ gap: 6, alignItems: 'center' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ width: 'auto' }} />
      <span>{label}</span>
    </label>
  );
}
