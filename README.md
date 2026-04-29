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

Den App-Namen (= App-ID, unter der die App im Server registriert wird) gibst
du beim Registrieren des Pfades direkt mit an — eine `app.config` ist nicht
mehr nötig.

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
   ein Array `entries: [{ path, appId }, …]`.

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
