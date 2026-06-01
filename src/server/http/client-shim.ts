/**
 * Returns the JS source of the `Client` shim that gets injected into every
 * iframe rendering an UserApp's www/ HTML. Mirrors the surface of
 * knuddels-webapp-frontend-api.d.ts.
 */
export function clientShimSource(opts: {
  sessionId: string;
  appId: string;
  nick: string;
  pageData: Record<string, unknown>;
  appViewMode: string;
  cacheInvalidationId: string;
  wsUrl: string;
  clientType: string;
  isK3Client: boolean;
}): string {
  const json = JSON.stringify(opts);
  return `
;(function() {
  const opts = ${json};
  const listeners = Object.create(null);
  let ws = null;
  let queued = [];
  let connected = false;

  function connect() {
    ws = new WebSocket(opts.wsUrl);
    ws.addEventListener('open', () => {
      connected = true;
      ws.send(JSON.stringify({ type: '__hello', sessionId: opts.sessionId }));
      for (const m of queued.splice(0)) ws.send(m);
    });
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && msg.kind === 'event' && msg.type) dispatch(msg.type, msg.data);
    });
    ws.addEventListener('close', () => {
      connected = false;
      setTimeout(connect, 500);
    });
    ws.addEventListener('error', () => {});
  }
  connect();

  function send(payload) {
    const s = JSON.stringify(payload);
    if (connected && ws && ws.readyState === 1) ws.send(s);
    else queued.push(s);
  }
  function sendHostFrame(op, extra) {
    const p = { kind: 'host-frame', op: op };
    if (extra) for (const k in extra) p[k] = extra[k];
    send(p);
  }

  function dispatch(type, data) {
    const arr = listeners[type] || [];
    for (const cb of arr.slice()) {
      try { cb({ type: type, data: data }); } catch (e) { console.error('[Client] listener threw', e); }
    }
  }

  const ClientType = {
    Applet: { name: 'Applet' }, Browser: { name: 'Browser' }, Android: { name: 'Android' },
    IOS: { name: 'IOS' }, Offline: { name: 'Offline' }, Web: { name: 'Web' }, MobileWeb: { name: 'MobileWeb' },
  };

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/app/' + opts.appId + '/' + src;
      s.onload = () => res();
      s.onerror = e => rej(e);
      document.head.appendChild(s);
    });
  }
  function loadCss(src) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/app/' + opts.appId + '/' + src;
    document.head.appendChild(l);
  }

  // ---- Browser detection (best-effort UA parse) ----
  function detectBrowser() {
    const ua = (navigator && navigator.userAgent) || '';
    const tests = [
      { type: 'Edge',    re: /Edg\\/([\\d.]+)/ },
      { type: 'Chrome',  re: /Chrome\\/([\\d.]+)/ },
      { type: 'Firefox', re: /Firefox\\/([\\d.]+)/ },
      { type: 'Safari',  re: /Version\\/([\\d.]+).*Safari/ },
    ];
    for (const t of tests) {
      const m = ua.match(t.re);
      if (m) return { type: t.type, version: m[1] };
    }
    return { type: 'Unknown', version: '0.0' };
  }
  const browser = detectBrowser();

  // ---- Web Audio sound cache ----
  const soundCache = Object.create(null);
  let audioCtx = null;
  function ctx() {
    if (!audioCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    return audioCtx;
  }
  function fetchSound(name) {
    if (soundCache[name]) return soundCache[name];
    const c = ctx();
    if (!c) return Promise.reject(new Error('no AudioContext'));
    const p = fetch('/app/' + opts.appId + '/' + name)
      .then(r => r.arrayBuffer())
      .then(buf => c.decodeAudioData(buf));
    soundCache[name] = p;
    // Replace cached promise with decoded buffer once resolved (keeps cache small + sync-ish)
    p.then(buf => { soundCache[name] = Promise.resolve(buf); }, () => { delete soundCache[name]; });
    return p;
  }

  const HostFrame = {
    setBackgroundColor: (color, durationMs) => {
      const hex = color && color.asHexString ? color.asHexString() : String(color);
      const dur = Number(durationMs) || 0;
      document.documentElement.style.transition = dur ? ('background-color ' + dur + 'ms') : '';
      document.body.style.transition = dur ? ('background-color ' + dur + 'ms') : '';
      document.documentElement.style.backgroundColor = hex;
      document.body.style.backgroundColor = hex;
      sendHostFrame('setBackgroundColor', { color: hex, durationMs: dur });
    },
    setSize: (w, h) => sendHostFrame('setSize', { width: Number(w), height: Number(h) }),
    setMinSize: (w, h) => sendHostFrame('setMinSize', { width: Number(w), height: Number(h) }),
    setMaxSize: (w, h) => sendHostFrame('setMaxSize', { width: Number(w), height: Number(h) }),
    setResizable: r => sendHostFrame('setResizable', { resizable: !!r }),
    setTitle: t => { document.title = String(t); sendHostFrame('setTitle', { title: String(t) }); },
    setIcons: function() {
      const first = arguments[0];
      if (!first) return;
      const href = '/app/' + opts.appId + '/' + first;
      let link = document.querySelector('link[rel="icon"]');
      if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
      link.href = href;
      sendHostFrame('setIcons', { url: href });
    },
    focus: () => {
      try { window.focus(); } catch (e) {}
      if (window.parent && window.parent !== window) {
        try { window.parent.postMessage({ kind: 'focus', sessionId: opts.sessionId }, '*'); } catch (e) {}
      }
    },
    getAppViewMode: () => opts.appViewMode,
    getBrowserType: () => browser.type,
    getBrowserVersion: () => browser.version,
  };

  const Client = {
    pageData: opts.pageData,
    addEventListener: (type, cb) => {
      (listeners[type] = listeners[type] || []).push(cb);
    },
    removeEventListener: (type, cb) => {
      if (!listeners[type]) return;
      if (typeof cb !== 'function') { listeners[type] = []; return; }
      const idx = listeners[type].indexOf(cb);
      if (idx >= 0) listeners[type].splice(idx, 1);
    },
    dispatchEvent: ev => dispatch(ev.type, ev.data),
    sendEvent: (type, data) => send({ kind: 'event', type: type, data: data }),
    getNick: () => opts.nick,
    getClientType: () => ClientType[opts.clientType] || ClientType.Web,
    getCacheInvalidationId: () => opts.cacheInvalidationId,
    isK3Client: () => opts.isK3Client,
    includeJS: function() {
      const args = Array.prototype.slice.call(arguments);
      args.forEach(loadScript);
    },
    includeCSS: function() {
      const args = Array.prototype.slice.call(arguments);
      args.forEach(loadCss);
    },
    playSound: name => {
      fetchSound(name).then(buf => {
        const c = ctx();
        if (!c) return;
        const src = c.createBufferSource();
        src.buffer = buf;
        src.connect(c.destination);
        src.start(0);
      }).catch(e => console.warn('[Client] playSound failed', name, e));
    },
    prefetchSound: name => {
      fetchSound(name).catch(e => console.warn('[Client] prefetchSound failed', name, e));
    },
    freeSound: name => { delete soundCache[name]; },
    getDirectConnection: () => Promise.resolve(),
    getHostFrame: () => HostFrame,
    addConnectionTypeChangeListener: () => {},
    removeConnectionTypeChangeListener: () => {},
    executeSlashCommand: cmd => send({ kind: 'slash', command: cmd }),
    close: () => {
      send({ kind: 'close' });
      if (window.parent && window.parent !== window) {
        try { window.parent.postMessage({ kind: 'close', sessionId: opts.sessionId }, '*'); } catch (e) {}
      }
    },
  };

  // Knuddels-style classes that some apps reference inside the iframe.
  function Event(type, data) { this.type = type; this.data = data; }
  Client.Event = Event;
  function Color(r, g, b) { this.r = r; this.g = g; this.b = b; }
  Color.fromRGB = (r, g, b) => new Color(r, g, b);
  Color.fromHexString = hex => {
    const m = hex.replace('#', '');
    return new Color(parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16));
  };
  Color.prototype.getRed = function() { return this.r; };
  Color.prototype.getGreen = function() { return this.g; };
  Color.prototype.getBlue = function() { return this.b; };
  Color.prototype.asHexString = function() {
    return '#' + [this.r, this.g, this.b].map(v => v.toString(16).padStart(2, '0')).join('');
  };
  Client.Color = Color;
  Client.HostFrame = HostFrame;
  Client.ClientType = ClientType;

  window.Client = Client;
  window.ClientType = ClientType;
})();
`;
}
