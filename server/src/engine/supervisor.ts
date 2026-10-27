// Runs the streaming engine (server.js) as a supervised child process, mirroring what the
// official shells do (stremio-shell stremioprocess.cpp, stremio-shell-ng stremio_server/process.rs):
// readiness from the "EngineFS server started at <url>" stdout line, startup timeout, restart on
// crash. The child gets its own process group so ffmpeg descendants are stopped with it.
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import readline from 'node:readline';

export type EngineState = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed' | 'stopping';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface EngineOptions {
  script: string;
  preload: string;
  appPath: string;
  /** bytes; null = unlimited; undefined = leave the engine's own setting alone */
  cacheSize?: number | null;
  ffmpeg?: string;
  ffprobe?: string;
  nodeBin?: string;
  env?: NodeJS.ProcessEnv;
  log: Logger;
  startupTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatMisses?: number;
  stopTimeoutMs?: number;
  /** crashes within crashWindowMs that switch the state to "failed" */
  maxCrashes?: number;
  crashWindowMs?: number;
  failedRetryMs?: number;
  maxBackoffMs?: number;
}

export interface EngineStatus {
  state: EngineState;
  pid: number | null;
  url: string | null;
  version: string | null;
  uptimeSec: number | null;
  restarts: number;
  lastExit: { code: number | null; signal: string | null; at: string; reason: string } | null;
  lastError: string | null;
}

const READY_RE = /EngineFS server started at (http:\/\/\S+)/;
const LOG_LINES = 500;

export class EngineSupervisor extends EventEmitter {
  private readonly o: Required<Omit<EngineOptions, 'cacheSize' | 'env'>> & Pick<EngineOptions, 'cacheSize' | 'env'>;
  private child: ChildProcess | null = null;
  private _state: EngineState = 'stopped';
  private _url: string | null = null;
  private version: string | null = null;
  private startedAt: number | null = null;
  private restarts = 0;
  private crashes: number[] = [];
  private lastExit: EngineStatus['lastExit'] = null;
  private lastError: string | null = null;
  private timers = new Set<NodeJS.Timeout>();
  private heartbeat: NodeJS.Timeout | null = null;
  private misses = 0;
  private exitReason: string | null = null;
  /** output of the current run, for crash reports */
  private recent: string[] = [];
  readonly logs: string[] = [];

  constructor(opts: EngineOptions) {
    super();
    this.o = {
      nodeBin: process.execPath,
      ffmpeg: '/usr/bin/ffmpeg',
      ffprobe: '/usr/bin/ffprobe',
      startupTimeoutMs: 30_000,
      heartbeatIntervalMs: 10_000,
      heartbeatMisses: 3,
      stopTimeoutMs: 5_000,
      maxCrashes: 5,
      crashWindowMs: 5 * 60_000,
      failedRetryMs: 60_000,
      maxBackoffMs: 30_000,
      ...opts,
    };
  }

  get state(): EngineState {
    return this._state;
  }

  /** base URL with trailing slash while running, e.g. http://127.0.0.1:11470/ */
  get url(): string | null {
    return this._state === 'running' ? this._url : null;
  }

  status(): EngineStatus {
    return {
      state: this._state,
      pid: this.child?.pid ?? null,
      url: this._url,
      version: this.version,
      uptimeSec: this._state === 'running' && this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : null,
      restarts: this.restarts,
      lastExit: this.lastExit,
      lastError: this.lastError,
    };
  }

  start(): void {
    if (this._state !== 'stopped' && this._state !== 'failed' && this._state !== 'restarting') return;
    this.clearTimers();
    this.setState('starting');
    mkdirSync(this.o.appPath, { recursive: true });

    // see src/net.ts: the default 250 ms per address is too short for far-away servers
    const child = spawn(this.o.nodeBin, ['--network-family-autoselection-attempt-timeout=2500', '-r', this.o.preload, this.o.script], {
      cwd: this.o.appPath,
      detached: true, // own process group: stop() signals the engine and its ffmpeg children together
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...(this.o.env ?? process.env),
        HOME: this.o.appPath, // server.js derives some paths from HOME
        APP_PATH: this.o.appPath,
        NO_CORS: '1', // only reachable through our same-origin proxy
        FFMPEG_BIN: this.o.ffmpeg,
        FFPROBE_BIN: this.o.ffprobe,
      },
    });
    this.child = child;
    this.exitReason = null;
    this.recent = [];
    this.misses = 0;

    const startup = this.timer(() => {
      this.lastError = `engine not ready after ${this.o.startupTimeoutMs / 1000}s`;
      this.o.log.warn(this.lastError);
      this.kill(child, 'startup timeout');
    }, this.o.startupTimeoutMs);

    const onLine = (line: string) => {
      this.pushLog(line);
      const m = READY_RE.exec(line);
      if (m && this._state === 'starting' && this.child === child) {
        this.clearTimer(startup);
        void this.onReady(child, m[1]!.endsWith('/') ? m[1]! : `${m[1]}/`);
      }
    };
    readline.createInterface({ input: child.stdout! }).on('line', onLine);
    readline.createInterface({ input: child.stderr! }).on('line', (l) => this.pushLog(l));

    child.on('error', (err) => {
      this.lastError = `spawn failed: ${err.message}`;
      this.o.log.error(this.lastError);
      // a process that never started emits no 'exit'
      if (child.pid === undefined) {
        this.exitReason = 'spawn failed';
        this.onExit(child, null, null);
      }
    });
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
  }

  async stop(): Promise<void> {
    this.clearTimers();
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      this.setState('stopped');
      return;
    }
    this.setState('stopping');
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    this.signalGroup(child, 'SIGTERM');
    const timeout = new Promise<'timeout'>((resolve) => {
      const t = setTimeout(() => resolve('timeout'), this.o.stopTimeoutMs);
      t.unref();
    });
    if ((await Promise.race([exited, timeout])) === 'timeout') {
      this.o.log.warn(`engine did not exit within ${this.o.stopTimeoutMs / 1000}s, sending SIGKILL`);
      this.signalGroup(child, 'SIGKILL');
      await exited;
    } else {
      // the engine is gone; make sure nothing else in its group (ffmpeg) outlives it
      this.signalGroup(child, 'SIGKILL');
    }
    this.child = null;
    this.setState('stopped');
  }

  private async onReady(child: ChildProcess, url: string): Promise<void> {
    try {
      await this.configure(url);
    } catch (err) {
      this.lastError = `configure failed: ${(err as Error).message}`;
      this.o.log.warn(this.lastError);
    }
    if (this.child !== child || this._state !== 'starting') return;
    this._url = url;
    this.startedAt = Date.now();
    this.lastError = null;
    this.setState('running');
    this.o.log.info(`engine ready at ${url} (pid ${child.pid}, version ${this.version ?? 'unknown'})`);
    this.heartbeat = setInterval(() => void this.checkHeartbeat(child), this.o.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  /** Apply our settings over the engine's own (persisted in APP_PATH/server-settings.json). */
  private async configure(url: string): Promise<void> {
    const current = (await (await fetch(new URL('settings', url), { signal: AbortSignal.timeout(5000) })).json()) as {
      values?: { serverVersion?: string };
    };
    this.version = current.values?.serverVersion ?? null;
    const values: Record<string, unknown> = { cacheRoot: this.o.appPath };
    if (this.o.cacheSize !== undefined) values.cacheSize = this.o.cacheSize;
    const res = await fetch(new URL('settings', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(values),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`POST /settings -> ${res.status}`);
  }

  private async checkHeartbeat(child: ChildProcess): Promise<void> {
    if (this.child !== child || this._state !== 'running' || !this._url) return;
    let ok = false;
    try {
      ok = (await fetch(new URL('heartbeat', this._url), { signal: AbortSignal.timeout(3000) })).ok;
    } catch {
      ok = false;
    }
    if (this.child !== child || this._state !== 'running') return;
    this.misses = ok ? 0 : this.misses + 1;
    if (this.misses >= this.o.heartbeatMisses) {
      this.lastError = `${this.misses} heartbeats missed`;
      this.o.log.warn(`engine unresponsive (${this.lastError}), restarting`);
      this.kill(child, 'unresponsive');
    }
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.signalGroup(child, 'SIGKILL'); // reap leftover ffmpeg processes in the group
    this.child = null;
    this._url = null;
    this.startedAt = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const reason = this.exitReason ?? 'crashed';
    this.lastExit = { code, signal, at: new Date().toISOString(), reason };
    if (this._state === 'stopping' || this._state === 'stopped') return;

    const tail = this.recent.length ? `; last output:\n${this.recent.join('\n')}` : '';
    this.o.log.warn(`engine exited (code ${code}, signal ${signal}, ${reason})${tail}`);
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < this.o.crashWindowMs), now];
    this.restarts++;
    if (this.crashes.length >= this.o.maxCrashes) {
      this.lastError = `${this.crashes.length} crashes within ${this.o.crashWindowMs / 60_000} min`;
      this.o.log.error(`engine failed (${this.lastError}); retrying every ${this.o.failedRetryMs / 1000}s`);
      this.setState('failed');
      this.timer(() => this.start(), this.o.failedRetryMs);
      return;
    }
    const delay = Math.min(this.o.maxBackoffMs, 1000 * 2 ** (this.crashes.length - 1));
    this.setState('restarting');
    this.timer(() => this.start(), delay);
  }

  private kill(child: ChildProcess, reason: string): void {
    this.exitReason = reason;
    this.signalGroup(child, 'SIGKILL');
  }

  private signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // group already gone
    }
  }

  private pushLog(line: string): void {
    this.logs.push(line);
    this.recent.push(line);
    if (this.recent.length > 20) this.recent.shift();
    if (this.logs.length > LOG_LINES) this.logs.splice(0, this.logs.length - LOG_LINES);
    this.emit('log', line);
  }

  private setState(state: EngineState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit('state', state);
  }

  private timer(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref();
    this.timers.add(t);
    return t;
  }

  private clearTimer(t: NodeJS.Timeout): void {
    clearTimeout(t);
    this.timers.delete(t);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
