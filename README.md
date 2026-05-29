# Knuddels UserApps Test-Umgebung

Lokale Sandbox zum Entwickeln und Testen von Knuddels UserApps ohne FTP-Upload.

## Setup

```bash
npm install
npm run dev
```

Das öffnet:
- Den **Test-Server** auf http://localhost:3000 (UserApp-Sandbox + Frontend-Hosting)
- Die **Debug-UI** auf http://localhost:5173 (React-SPA für Event-Simulation)

## UserApp registrieren

### Externe Ordner (empfohlen)

Die UserApp bleibt in ihrem eigenen Projektordner — egal wo auf der Platte, mit
eigenem Git-Repo, eigener Build-Pipeline. Du registrierst nur den Pfad, der
Watcher zieht Änderungen live rein. Kein Kopieren, keine Symlinks, kein
Vermischen mit dem Server-Repo.

Registriert wird das **Repo-Root** der App (der Ordner mit `package.json`). Die
gebauten Artefakte werden daraus als `<repo-root>/dist` abgeleitet (`main.js` +
`www`). Den App-Namen (= App-ID, unter der die App im Server registriert wird)
gibst du beim Registrieren direkt mit an — eine `app.config` ist nicht nötig.

Drei Wege, einen Pfad zu registrieren:

1. **Debug-UI → Apps-Panel → "Externen Ordner hinzufügen"**
   App-Namen + Pfad eingeben (oder Ordner per Drag-&-Drop / Picker auswählen,
   App-Name wird aus dem Ordnernamen vorgeschlagen). Auswahl wird in
   `.test-env/external-apps.json` persistiert und beim nächsten Start
   automatisch wieder eingehängt.
2. **Env-Var `KS_EXTERNAL_APPS`** — komma-separiert. Pro Eintrag entweder
   `/pfad/zur/app` (App-Name = Ordnername) oder `appname=/pfad/zur/app` für
   einen abweichenden Namen:
   ```bash
   KS_EXTERNAL_APPS=/Users/me/work/my-app,other=/Users/me/work/foo npm run dev
   ```
3. **Direkt die JSON editieren** — `.test-env/external-apps.json` enthält
   ein Array `entries: [{ path, appId, liveSource?, frontendDevPort? }, …]`.
   `path` ist das Repo-Root. Mit `liveSource: true` aktivierst du den
   Live-Source-Modus (siehe unten), `frontendDevPort` setzt den Port des
   Dev-Servers (Default `3100`). Der alte Schlüssel `hotReload` wird weiterhin
   als `liveSource` gelesen (Back-Compat).

### `apps/`-Ordner (Fallback, FTP-Style)

Wer keinen externen Ordner nutzen will, kann eine App direkt unter
`apps/<app-id>/` ablegen — wie ein FTP-Upload. Der Ordnername IST die App-ID:

```
apps/
└── meine-app/
    ├── main.js          # Server-Logik
    └── www/
        └── index.html   # Frontend
```

Eine `app.config` darf weiterhin liegen (z.B. mit `appName=` / `appVersion=`
für Metadaten), wird aber nicht mehr für die Registrierung benötigt.

Inhalte von `apps/` sind per `.gitignore` ausgeschlossen, der Ordner selbst
bleibt versioniert (via `.gitkeep`).

In beiden Fällen lädt der Watcher Änderungen automatisch neu.

## Live Source (Frontend HMR + Backend)

**„Live Source"** bezeichnet, woher *diese Test-Umgebung* eine App bedient:
entweder **live** aus zwei Watch-Prozessen (Frontend `ks start` mit HMR +
Backend `yarn watch`) oder **eingefroren** aus dem gebauten `dist/`-Ordner.

> Nicht zu verwechseln mit dem Knuddels-Plattform-Konzept „Hot Reload" (das die
> App-eigene Debug-UI dauerhaft als „an" anzeigt). Das ist eine andere Sache und
> wird hier nur gemockt; der Live-Source-Schalter steuert ausschließlich die
> lokale Quelle.

Für externe Apps mit `"liveSource": true` startet der Test-Server beim `npm run
dev` automatisch zwei Watch-Prozesse im Repo-Root der App (du musst im
App-Repo selbst nichts starten):

- **Frontend:** `ks start` (CRA Dev-Server mit React Fast Refresh) auf
  `frontendDevPort` (Default `3100`). Der Test-Server proxyt diesen Dev-Server
  über seine `/app/:appId/*`-Route, ersetzt dabei im HTML den echten
  Knuddels-API-Loader (statischer `<script>`-Tag **und** der inline per
  `document.write` injizierte cdnc-Apploader) durch den lokalen `Client`-Shim —
  so spricht das HMR-Frontend mit dem **lokalen** Backend (über `/__ws`), nicht
  mit der Knuddels-Infrastruktur. Frontend-Änderungen erscheinen per HMR direkt
  im iframe, ohne Full-Rebuild.
- **Backend:** `yarn watch` (inkrementeller webpack-Build) schreibt
  `dist/main.js`; der bestehende Datei-Watcher lädt daraufhin die Sandbox neu.
  Backend-Änderungen brauchen so Sekunden statt eines vollen Builds.

**Pro Session umschaltbar:** Im Tab *Apps & Sessions* hat jede Session-Kachel
neben ↻ / × einen **`● LIVE` / `○ dist`**-Schalter. Er wirkt App-weit (eine
Dev-Server-Instanz pro App) und ist nur für externe App-Ordner mit Repo-Root
verfügbar. Der Schalter ändert nur, **was angezeigt wird** (Proxy auf den
Dev-Server vs. statisches `dist/`) — die Watch-Prozesse werden beim ersten
Einschalten **einmal** gestartet und bleiben danach **warm**. Das erste
Einschalten zeigt daher kurz „booting…" (bis `ks start` antwortet, dann lädt das
iframe automatisch neu); jedes spätere Umschalten ist sofort. Gestoppt werden
die Prozesse erst beim Entfernen der App oder beim Beenden des Servers. Die Wahl
wird in `external-apps.json` persistiert (außer bei per Env-Var registrierten
Apps).

Hinweis: Im `dist`-Modus läuft `yarn watch` im Hintergrund weiter, d.h. das
Backend bleibt live (rebuildet `dist/main.js`); nur das **Frontend** wird aus dem
gebauten `dist/www` statt vom HMR-Dev-Server bedient.

Wichtig zu den Ports: Der Test-Server selbst belegt `:3000`, deshalb läuft
`ks start` lokal auf `:3100`. Der Port wird vom Test-Server per `PORT`-Env beim
Spawnen gesetzt — im App-Repo wird nichts geändert. Dein normaler
Knuddels-Workflow (`yarn start` auf `:3000` + `/userapphotreload …:3000`)
bleibt unberührt.

Voraussetzung: Im App-Repo sind die Dependencies installiert (`ks`-Bin unter
`node_modules/.bin`) und es existieren die Scripts `start` (= `ks start`) und
`watch` (webpack `--watch` des Backends). `ks start` spawnt intern
`react-devtools`; fehlt das Binary, würde der Dev-Server crashen — der
Test-Server stellt deshalb einen No-op-Stub via `PATH` voran
(`src/server/dev/stubs/`).

### Start aus dem App-Repo (`yarn start-local`)

Die App kann den Test-Server auch selbst hochfahren — als Alternative zum
klassischen `yarn start` (Knuddels-Dev-Server). Dafür im App-Repo:

- `local-test-env.json` (Repo-Root):
  `{ "testEnvPath": "C:/…/KnuddelsServerLocal", "appId": "Crash", "frontendDevPort": 3100 }`.
  Diese Datei ist **git-ignored** (pro-Dev unterschiedlicher Pfad); committed
  ist `local-test-env.example.json` als Vorlage. `start-local` legt die Datei
  beim ersten Lauf automatisch aus der Vorlage an — danach nur noch
  `testEnvPath` anpassen.
- `scripts/start-local.mjs` liest diese Config und spawnt im `testEnvPath`
  `npm run dev:local` mit `KS_EXTERNAL_APPS=<appId>=<repoRoot>`,
  `KS_LIVE_SOURCE=1`, `KS_FRONTEND_DEV_PORT` und
  `KS_BACKEND_WATCH_SCRIPT=watch-local`.
- `package.json`-Scripts `"start-local": "node scripts/start-local.mjs"` und
  `"watch-local"` (webpack `--watch` **ohne** das `update-version-timestamp`-
  Bracketing, damit die Versionsdatei lokal nicht „dirty" wird).

**Backend-Watch-Script (`KS_BACKEND_WATCH_SCRIPT`):** Welches yarn-Script den
inkrementellen Backend-Build fährt, ist konfigurierbar (Default `watch`). Crashs
`watch`-Script klammert webpack mit `update-version-timestamp.js` (set → build →
reset) — da `webpack --watch` aber nie zurückkehrt, läuft der Reset nie und die
Versionsdatei bleibt verändert. `start-local` zeigt deshalb auf `watch-local`,
das die Versionierung gar nicht erst anfasst (wie das klassische `yarn start`).

`yarn start-local` registriert die App also automatisch im Live-Source-Modus
(Quelle: Env-Var, read-only — überschreibt/dedupliziert einen persistierten
Eintrag mit gleichem `dist/`-Pfad). Der Test-Server bleibt generisch: jedes
App-Repo kann ihn auf die gleiche Weise mit seinem eigenen Pfad starten.

## Was simuliert werden kann

Über die Debug-UI:
- User anlegen, in Channel joinen / leaven
- Public/Private Messages, Action Messages senden
- Slash-Commands (`/...`) triggern
- Beliebige `appEvent`-Frames vom Frontend simulieren
- AppContent-Frame im iframe öffnen + Frontend-↔-Backend-Events live verfolgen
- Persistenz-JSON (`.test-env/persistence/<appId>.json`) live einsehen + editieren

## Nicht-Ziele

Keine 100%ige Knuddels-Treue (kein Rhino, keine ES5-Limits, kein echtes Threading-Modell). Sinn ist schnelles iteratives Entwickeln.
