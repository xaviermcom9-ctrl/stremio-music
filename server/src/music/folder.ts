// Folder plugins: /config/music-sources/<name>/index.js, each running in its own sandboxed child
// process (plugin-host.ts). This side exposes the child as a MusicSource for SourceRuntime.
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MusicSource, SourceContext, SourceManifest } from '../music-sources/sdk.js';
import { validateSourceManifest } from './runtime.js';

const HOST = fileURLToPath(new URL('./plugin-host.js', import.meta.url));
const READY_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 35_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60_000;

export interface FolderCandidate {
  name: string;
  dir: string;
}

/** Subfolders with an index.js; names starting with "." or "_" are skipped (e.g. "_disabled"). */
export function scanPluginDir(root: string): FolderCandidate[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
    .map((name) => ({ name, dir: path.join(root, name) }))
    .filter((c) => statSync(c.dir).isDirectory() && existsSync(path.join(c.dir, 'index.js')))
    .sort((a, b) => a.name.localeCompare(b.name));
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; ctx: SourceContext; timer: NodeJS.Timeout };

/** One plugin process. `start()` resolves with the validated manifest or rejects with load errors. */
export class FolderPlugin {
  private child: ChildProcess | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private restarts: number[] = [];
  private ops: string[] = [];
  private hookNames: string[] = [];
  manifest: SourceManifest | null = null;
  lastError: string | null = null;
  readonly output: string[] = [];

  constructor(
    readonly dir: string,
    private readonly onLog: (level: string, message: string) => void = () => {},
  ) {}

  start(): Promise<SourceManifest> {
    return new Promise((resolve, reject) => {
      const child = fork(HOST, [this.dir], {
        execArgv: [
          '--permission',
          `--allow-fs-read=${this.dir}/`,
          `--allow-fs-read=${HOST}`,
          '--max-old-space-size=128',
          '--disable-warning=ExperimentalWarning',
        ],
        // nothing from our environment (secrets, paths) leaks into plugin code
        env: { NODE_ENV: 'production', TZ: process.env.TZ ?? 'UTC' },
        cwd: this.dir,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      this.child = child;
      const capture = (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          this.output.push(line);
          if (this.output.length > 200) this.output.shift();
          this.onLog('info', `[stdout] ${line}`);
        }
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`plugin didn't start within ${READY_TIMEOUT_MS / 1000}s`));
      }, READY_TIMEOUT_MS);

      child.on('message', (raw) => {
        const msg = raw as Record<string, unknown> & { t: string };
        if (msg.t === 'ready') {
          clearTimeout(timer);
          const v = validateSourceManifest(msg.manifest);
          if (!v.ok) {
            child.kill('SIGKILL');
            const id = (msg.manifest as { id?: unknown } | null)?.id;
            reject(new Error(`invalid manifest${typeof id === 'string' ? ` (id "${id.slice(0, 60)}")` : ''}: ${v.errors.join('; ')}`));
            return;
          }
          this.manifest = v.manifest;
          this.ops = msg.ops as string[];
          this.hookNames = msg.hooks as string[];
          resolve(v.manifest);
        } else if (msg.t === 'load-error') {
          clearTimeout(timer);
          reject(new Error(String(msg.message)));
        } else this.onMessage(msg);
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (this.child !== child) return;
        this.child = null;
        const reason = `plugin process exited (code ${code}, signal ${signal})`;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(reason));
        }
        this.pending.clear();
        if (this.manifest) {
          this.lastError = reason;
          this.onLog('error', reason);
        }
        reject(new Error(reason + (this.output.length ? `: ${this.output.slice(-3).join(' | ')}` : '')));
      });
    });
  }

  private onMessage(msg: Record<string, unknown> & { t: string }): void {
    if (msg.t === 'result' || msg.t === 'error') {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      if (msg.t === 'result') p.resolve(msg.value);
      else p.reject(new Error(String(msg.message)));
    } else if (msg.t === 'log') {
      const p = this.pending.get(msg.callId as number);
      const level = String(msg.level);
      if (p) (p.ctx.log as unknown as Record<string, (m: string) => void>)[level]?.(String(msg.message));
      else this.onLog(level, String(msg.message));
    } else if (msg.t === 'fetch') {
      const p = this.pending.get(msg.callId as number);
      const fid = msg.fid;
      if (!p) {
        this.child?.send({ t: 'fetch-error', fid, message: 'call already finished' });
        return;
      }
      p.ctx
        .fetch(String(msg.url), msg.init as Parameters<SourceContext['fetch']>[1])
        .then(async (res) =>
          this.child?.send({ t: 'fetch-result', fid, ok: res.ok, status: res.status, url: res.url, headers: res.headers, body: await res.text() }),
        )
        .catch((err: Error) => this.child?.send({ t: 'fetch-error', fid, message: err.message }));
    }
  }

  private async ensureRunning(): Promise<void> {
    if (this.child) return;
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) throw new Error(`plugin crashed ${MAX_RESTARTS} times in 5 minutes; use "Reload plugins"`);
    this.restarts.push(now);
    this.onLog('warn', 'restarting plugin process');
    await this.start();
  }

  private async call(op: string, args: unknown[], ctx: SourceContext): Promise<unknown> {
    await this.ensureRunning();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op} took longer than ${CALL_TIMEOUT_MS / 1000}s`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, ctx, timer });
      this.child!.send({ t: 'call', id, op, args, ctx: { settings: ctx.settings, user: ctx.user } });
    });
  }

  /** A MusicSource whose methods run in the plugin process. */
  asSource(): MusicSource {
    if (!this.manifest) throw new Error('plugin not started');
    const has = (op: string) => this.ops.includes(op);
    const source: MusicSource = { manifest: this.manifest };
    if (has('catalog')) source.catalog = (req, ctx) => this.call('catalog', [req], ctx) as never;
    if (has('meta')) source.meta = (id, ctx) => this.call('meta', [id], ctx) as never;
    if (has('streams')) source.streams = (id, ctx) => this.call('streams', [id], ctx) as never;
    if (has('test')) source.test = (ctx) => this.call('test', [], ctx) as never;
    if (this.hookNames.length) {
      source.hooks = Object.fromEntries(
        this.hookNames.map((h) => [h, (...a: unknown[]) => this.call(`hooks.${h}`, a.slice(0, -1), a.at(-1) as SourceContext)]),
      );
    }
    return source;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    child?.kill('SIGTERM');
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('plugin stopped'));
    }
    this.pending.clear();
  }
}
