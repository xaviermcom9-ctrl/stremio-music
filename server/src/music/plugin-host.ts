// Child-process host for one folder plugin. Started by folder.ts with Node's permission model:
// it may read only the plugin's folder and this file, may not write files, start processes or
// load native addons. It loads <plugin dir>/index.js and answers calls over IPC; ctx.fetch and
// ctx.log are relayed to the parent, which applies the source's rate limit and host allow-list.
// Self-contained on purpose: no imports beyond Node built-ins.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Msg = Record<string, unknown> & { t: string };

const send = (msg: Msg) => process.send?.(msg);
const dir = process.argv[2]!;
let fetchSeq = 0;
const pendingFetches = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

interface Plugin {
  manifest: unknown;
  [op: string]: unknown;
  hooks?: Record<string, unknown>;
}

function makeContext(callId: number, ctx: { settings: unknown; user: unknown }) {
  const log = (level: string) => (message: unknown) => send({ t: 'log', callId, level, message: String(message) });
  return {
    settings: ctx.settings,
    user: ctx.user,
    // same placeholder as SourceRuntime (PROXY_MARKER); the parent checks the host and encrypts it
    proxyUrl: (url: string, opts?: { headers?: Record<string, string> }) =>
      'smproxy:' + Buffer.from(JSON.stringify({ u: new URL(url).href, h: opts?.headers })).toString('base64url'),
    log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    fetch: (url: string, init?: unknown) =>
      new Promise((resolve, reject) => {
        const fid = ++fetchSeq;
        pendingFetches.set(fid, { resolve, reject });
        send({ t: 'fetch', callId, fid, url: String(url), init: init ?? {} });
      }).then((r) => {
        const res = r as { ok: boolean; status: number; url: string; headers: Record<string, string>; body: string };
        return {
          ok: res.ok,
          status: res.status,
          url: res.url,
          headers: res.headers,
          text: async () => res.body,
          json: async () => JSON.parse(res.body),
        };
      }),
  };
}

async function main() {
  let plugin: Plugin;
  try {
    const mod = (await import(pathToFileURL(path.join(dir, 'index.js')).href)) as { default?: Plugin };
    if (!mod.default || typeof mod.default !== 'object' || !mod.default.manifest) {
      throw new Error('index.js must `export default` an object with a `manifest`');
    }
    plugin = mod.default;
  } catch (err) {
    send({ t: 'load-error', message: err instanceof Error ? `${err.message}` : String(err) });
    setTimeout(() => process.exit(1), 50);
    return;
  }

  process.on('message', async (raw) => {
    const msg = raw as Msg;
    if (msg.t === 'fetch-result' || msg.t === 'fetch-error') {
      const p = pendingFetches.get(msg.fid as number);
      pendingFetches.delete(msg.fid as number);
      if (!p) return;
      if (msg.t === 'fetch-result') p.resolve(msg);
      else p.reject(new Error(String(msg.message)));
      return;
    }
    if (msg.t !== 'call') return;
    const id = msg.id as number;
    const op = String(msg.op);
    try {
      const fn = op.startsWith('hooks.') ? plugin.hooks?.[op.slice(6)] : plugin[op];
      if (typeof fn !== 'function') throw new Error(`plugin has no ${op}()`);
      const ctx = makeContext(id, msg.ctx as { settings: unknown; user: unknown });
      const args = [...(msg.args as unknown[]), ctx];
      const value = await (fn as (...a: unknown[]) => Promise<unknown>).apply(op.startsWith('hooks.') ? plugin.hooks : plugin, args);
      send({ t: 'result', id, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
    } catch (err) {
      send({ t: 'error', id, message: err instanceof Error ? err.message : String(err) });
    }
  });

  const ops = ['catalog', 'meta', 'streams', 'test'].filter((op) => typeof plugin[op] === 'function');
  const hooks = Object.keys(plugin.hooks ?? {}).filter((h) => typeof plugin.hooks?.[h] === 'function');
  send({ t: 'ready', manifest: JSON.parse(JSON.stringify(plugin.manifest)), ops, hooks });
}

process.on('uncaughtException', (err) => {
  send({ t: 'log', callId: 0, level: 'error', message: `uncaught: ${err.message}` });
});
process.on('unhandledRejection', (err) => {
  send({ t: 'log', callId: 0, level: 'error', message: `unhandled rejection: ${err instanceof Error ? err.message : String(err)}` });
});
// the parent going away (IPC closed) ends this process
process.on('disconnect', () => process.exit(0));

void main();
