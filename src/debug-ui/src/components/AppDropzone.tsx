import React, { useCallback, useRef, useState } from 'react';
import { postJson } from '../api/http.js';

type DroppedFile = { path: string; base64: string };
type Status = { kind: 'idle' } | { kind: 'busy'; msg: string } | { kind: 'ok'; msg: string } | { kind: 'err'; msg: string };

const APP_ID_RE = /^[a-zA-Z0-9._-]+$/;

export function AppDropzone() {
  const [hover, setHover] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [pending, setPending] = useState<{ defaultId: string; files: DroppedFile[] } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (entries: DroppedFile[], suggestedAppId: string) => {
    if (entries.length === 0) {
      setStatus({ kind: 'err', msg: 'Keine Dateien gefunden.' });
      return;
    }
    setPending({ defaultId: suggestedAppId, files: entries });
  }, []);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setHover(false);
    const items = Array.from(e.dataTransfer.items ?? []);
    setStatus({ kind: 'busy', msg: 'lese Dateien…' });
    try {
      let files: DroppedFile[] = [];
      let suggestedAppId = '';
      // Prefer DataTransferItem.webkitGetAsEntry for folder traversal.
      const entries = items.map(it => (it as any).webkitGetAsEntry?.()).filter(Boolean);
      if (entries.length > 0) {
        // If exactly one folder dropped, its name becomes the appId.
        if (entries.length === 1 && entries[0].isDirectory) {
          suggestedAppId = entries[0].name;
          files = await walkFolder(entries[0], '');
        } else {
          // Mixed top-level files: use first file's parent (i.e. unknown) — let user name it.
          for (const e of entries) {
            if (e.isFile) files.push(...await readFile(e, e.name));
            else if (e.isDirectory) files.push(...await walkFolder(e, e.name + '/'));
          }
        }
      } else if (e.dataTransfer.files?.length) {
        // Fallback for browsers without webkitGetAsEntry (rare today).
        for (const f of Array.from(e.dataTransfer.files)) {
          files.push({ path: f.name, base64: await fileToBase64(f) });
        }
      }
      if (!suggestedAppId) {
        // Try to derive from the longest common prefix of files like "<id>/main.js".
        const first = files[0]?.path.split('/')[0] ?? '';
        if (first && files.every(f => f.path.startsWith(first + '/'))) {
          suggestedAppId = first;
          files = files.map(f => ({ ...f, path: f.path.slice(first.length + 1) }));
        }
      }
      handleFiles(files, suggestedAppId);
      setStatus({ kind: 'idle' });
    } catch (err: any) {
      setStatus({ kind: 'err', msg: err?.message ?? String(err) });
    }
  }, [handleFiles]);

  const onPick = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    setStatus({ kind: 'busy', msg: 'lese Dateien…' });
    try {
      const files: DroppedFile[] = [];
      let commonRoot = '';
      const filesArr = Array.from(fileList);
      // webkitRelativePath is set by <input webkitdirectory>.
      const useRel = filesArr.every(f => (f as any).webkitRelativePath);
      if (useRel) {
        const rel0 = (filesArr[0] as any).webkitRelativePath as string;
        commonRoot = rel0.split('/')[0] ?? '';
        for (const f of filesArr) {
          const rel = ((f as any).webkitRelativePath as string).slice(commonRoot.length + 1);
          if (!rel) continue;
          files.push({ path: rel, base64: await fileToBase64(f) });
        }
      } else {
        for (const f of filesArr) files.push({ path: f.name, base64: await fileToBase64(f) });
      }
      handleFiles(files, commonRoot);
      setStatus({ kind: 'idle' });
    } catch (err: any) {
      setStatus({ kind: 'err', msg: err?.message ?? String(err) });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }, [handleFiles]);

  async function commit(appId: string, replace: boolean) {
    if (!pending) return;
    if (!APP_ID_RE.test(appId)) {
      setStatus({ kind: 'err', msg: 'appId darf nur a-z A-Z 0-9 . _ - enthalten' });
      return;
    }
    setStatus({ kind: 'busy', msg: `lade ${pending.files.length} Datei(en) hoch…` });
    try {
      const r = await postJson<{ ok: boolean; fileCount: number; hasMain: boolean }>(
        '/api/debug/uploadApp',
        { appId, files: pending.files, replace },
      );
      let msg = `${r.fileCount} Datei(en) → ${appId}`;
      if (!r.hasMain) msg += '  ⚠ keine main.js';
      setStatus({ kind: 'ok', msg });
      setPending(null);
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message ?? String(e) });
    }
  }

  return (
    <div>
      <h2>App installieren</h2>
      <div
        onDragOver={e => { e.preventDefault(); setHover(true); }}
        onDragLeave={() => setHover(false)}
        onDrop={onDrop}
        onClick={() => fileInput.current?.click()}
        style={{
          border: `2px dashed ${hover ? 'var(--accent)' : 'var(--border)'}`,
          background: hover ? 'rgba(122,167,255,0.08)' : 'var(--panel-2)',
          borderRadius: 8,
          padding: '14px 12px',
          textAlign: 'center',
          cursor: 'pointer',
          fontSize: 12,
          color: 'var(--muted)',
          transition: 'background 0.15s, border-color 0.15s',
        }}>
        <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
          App-Ordner hier ablegen
        </div>
        <div>oder klicken zum Auswählen</div>
        <div style={{ marginTop: 6, fontSize: 11 }}>
          ein Ordner mit <code>main.js</code> — den App-Namen vergibst du im nächsten Schritt
        </div>
      </div>
      <input ref={fileInput}
             type="file"
             multiple
             style={{ display: 'none' }}
             {...({ webkitdirectory: '', directory: '' } as any)}
             onChange={onPick} />

      {status.kind === 'busy' && <p className="small muted" style={{ marginTop: 6 }}>{status.msg}</p>}
      {status.kind === 'ok'   && <p className="small" style={{ marginTop: 6, color: 'var(--green)' }}>{status.msg}</p>}
      {status.kind === 'err'  && <p className="small" style={{ marginTop: 6, color: 'var(--red)' }}>{status.msg}</p>}

      {pending && (
        <ConfirmUpload
          defaultAppId={pending.defaultId}
          fileCount={pending.files.length}
          onCancel={() => setPending(null)}
          onConfirm={commit}
        />
      )}
    </div>
  );
}

function ConfirmUpload({ defaultAppId, fileCount, onCancel, onConfirm }: {
  defaultAppId: string;
  fileCount: number;
  onCancel: () => void;
  onConfirm: (appId: string, replace: boolean) => void;
}) {
  const [appId, setAppId] = useState(defaultAppId);
  const [replace, setReplace] = useState(false);
  return (
    <div style={{ marginTop: 8, padding: 10, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6 }}>
      <div className="small muted" style={{ marginBottom: 6 }}>{fileCount} Datei(en) bereit</div>
      <input value={appId}
             onChange={e => setAppId(e.target.value)}
             placeholder="app-id"
             style={{ marginBottom: 6 }} />
      <label className="row small" style={{ gap: 6, marginBottom: 8 }}>
        <input type="checkbox"
               checked={replace}
               onChange={e => setReplace(e.target.checked)}
               style={{ width: 'auto' }} />
        <span>vorhandene App komplett ersetzen</span>
      </label>
      <div className="row">
        <button onClick={() => onConfirm(appId, replace)} disabled={!appId}>Hochladen</button>
        <button onClick={onCancel}>Abbrechen</button>
      </div>
    </div>
  );
}

// ---- helpers ----------------------------------------------------------------

async function walkFolder(dir: any, prefix: string): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  const reader = dir.createReader();
  // readEntries() may return them in batches; loop until empty.
  for (;;) {
    const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (batch.length === 0) break;
    for (const e of batch) {
      const childPrefix = prefix + e.name;
      if (e.isFile) out.push(...await readFile(e, childPrefix));
      else if (e.isDirectory) out.push(...await walkFolder(e, childPrefix + '/'));
    }
  }
  return out;
}

function readFile(entry: any, path: string): Promise<DroppedFile[]> {
  return new Promise((res, rej) => {
    entry.file(async (file: File) => {
      try { res([{ path, base64: await fileToBase64(file) }]); }
      catch (err) { rej(err); }
    }, rej);
  });
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result as string; // "data:...;base64,XXXX"
      const i = result.indexOf(',');
      res(i >= 0 ? result.slice(i + 1) : '');
    };
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}
