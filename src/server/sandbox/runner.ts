import * as vm from 'node:vm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppRecord, world } from '../state/world.js';
import { buildApi } from '../api/index.js';
import { installKnuddelsStringExtensionsInContext } from './string-extensions.js';

export type LoadedApp = {
  rec: AppRecord;
  shutdown: () => void;
};

export function loadApp(appRec: AppRecord): LoadedApp {
  const api = buildApi(appRec);
  const logger = api.KnuddelsServer.getDefaultLogger();

  // Wrap every async entry-point that takes an app-supplied callback so an
  // exception inside the callback gets logged + scoped to this app instead
  // of bubbling up to Node and crashing the whole test-env. Without this,
  // a single buggy `setTimeout(...)` in a UserApp tears down the dev server.
  const guard = <A extends any[], R>(fn: (...a: A) => R, label: string) =>
    ((...args: A): R => {
      try { return fn(...args); }
      catch (err: any) {
        logger.error(`${label} threw: ${err?.message ?? err}\n${err?.stack ?? ''}`);
        return undefined as unknown as R;
      }
    });

  const safeSetTimeout = (cb: (...a: any[]) => void, delay?: number, ...rest: any[]) =>
    setTimeout(guard(cb, 'setTimeout callback'), delay, ...rest);
  const safeSetInterval = (cb: (...a: any[]) => void, delay?: number, ...rest: any[]) =>
    setInterval(guard(cb, 'setInterval callback'), delay, ...rest);
  const safeQueueMicrotask = (cb: () => void) =>
    queueMicrotask(guard(cb, 'queueMicrotask callback'));

  // Build the global object for the vm context.
  const sandbox: Record<string, unknown> = {
    ...api,
    console: {
      log:   (...args: any[]) => logger.info(...args),
      info:  (...args: any[]) => logger.info(...args),
      warn:  (...args: any[]) => logger.warn(...args),
      error: (...args: any[]) => logger.error(...args),
      debug: (...args: any[]) => logger.debug(...args),
    },
    setTimeout: safeSetTimeout,
    clearTimeout,
    setInterval: safeSetInterval,
    clearInterval,
    queueMicrotask: safeQueueMicrotask,
    Date, JSON, Math, RegExp, Error, TypeError, RangeError, SyntaxError,
    Object, Array, String, Number, Boolean, Function, Symbol, Map, Set, WeakMap, WeakSet, Promise,
    parseInt, parseFloat, isNaN, isFinite,
  };

  // buildApi() may have stored helpers on a placeholder appRec.context — preserve them.
  const placeholder = appRec.context as Record<string, unknown> | undefined;
  const context = vm.createContext(sandbox, { name: `userapp:${appRec.appId}` });
  if (placeholder) Object.assign(context as object, placeholder);
  installKnuddelsStringExtensionsInContext(context);

  // Provide KnuddelsServer.require — must be wired into the same context.
  const requireFile = (file: string) => {
    const filePath = path.resolve(appRec.appDir, file);
    if (!filePath.startsWith(path.resolve(appRec.appDir))) {
      throw new Error(`require() path escapes app dir: ${file}`);
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`require(): file not found: ${file}`);
    }
    const code = fs.readFileSync(filePath, 'utf8');
    vm.runInContext(code, context, { filename: filePath });
  };
  (sandbox as any).KnuddelsServer.require = requireFile;
  // Tracked for KnuddelsServer.execute()
  (context as any).__execute = requireFile;
  appRec.context = context;

  // Run main.js. The app sets a global `App = { ... }`.
  const mainPath = path.join(appRec.appDir, 'main.js');
  const mainCode = fs.readFileSync(mainPath, 'utf8');
  try {
    vm.runInContext(mainCode, context, { filename: mainPath });
  } catch (err: any) {
    api.KnuddelsServer.getDefaultLogger().fatal(`main.js threw: ${err?.message ?? err}\n${err?.stack ?? ''}`);
    throw err;
  }

  const app = (sandbox as any).App;
  if (!app) {
    api.KnuddelsServer.getDefaultLogger().warn('main.js did not define a global `App` object');
  }
  appRec.app = app;

  // Lifecycle: onAppStart
  try { app?.onAppStart?.(); }
  catch (err: any) { api.KnuddelsServer.getDefaultLogger().error(`onAppStart threw: ${err?.message ?? err}`); }

  // Notify world of the new app
  world.emitChange();

  return {
    rec: appRec,
    shutdown: () => {
      try { app?.onShutdown?.(); }
      catch (err: any) { api.KnuddelsServer.getDefaultLogger().error(`onShutdown threw: ${err?.message ?? err}`); }
      const cleanup = (context as any).__cleanup as (() => void) | undefined;
      cleanup?.();
      // Flush persistence
      appRec.persistence.flush();
    },
  };
}
