import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { parseSize } from '../src/config.js';
import { rewriteEngineUrls } from '../src/engine/proxy.js';
import type { EngineState } from '../src/engine/supervisor.js';
import { fakeEngine, stopAll, waitFor } from './helpers.js';

after(stopAll);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(fn: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('EngineSupervisor', () => {
  test('starts, waits for the readiness line and applies settings', async () => {
    const { s, dir } = fakeEngine({}, { cacheSize: 20e9 });
    s.start();
    await waitFor(s, 'running');
    assert.match(s.url!, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const st = s.status();
    assert.equal(st.version, 'fake-1.0');
    assert.ok(st.pid);
    const posted = JSON.parse(readFileSync(path.join(dir, 'settings.log'), 'utf8').trim());
    assert.deepEqual(posted, { cacheRoot: dir, cacheSize: 20e9 });
    const hb = await fetch(new URL('heartbeat', s.url!));
    assert.equal(hb.status, 200);
    await s.stop();
  });

  test('the preload binds the engine to loopback only', async () => {
    const { s } = fakeEngine({});
    s.start();
    await waitFor(s, 'running');
    const port = new URL(s.url!).port;
    const tcp = readFileSync('/proc/net/tcp', 'utf8') + readFileSync('/proc/net/tcp6', 'utf8');
    const hexPort = Number(port).toString(16).toUpperCase().padStart(4, '0');
    const listeners = tcp.split('\n').filter((l) => l.includes(`:${hexPort} `) && l.split(/\s+/)[4] === '0A');
    assert.ok(listeners.length > 0, 'listener found');
    for (const l of listeners) assert.match(l.split(/\s+/)[2]!, /^0100007F:/, `bound to loopback: ${l}`);
    await s.stop();
  });

  test('stop() terminates the whole process group, including grandchildren', async () => {
    const { s, dir } = fakeEngine({});
    s.start();
    await waitFor(s, 'running');
    const [pid, grandchild] = readFileSync(path.join(dir, 'pids'), 'utf8').split(' ').map(Number) as [number, number];
    assert.ok(alive(pid) && alive(grandchild));
    const t0 = Date.now();
    await s.stop();
    assert.equal(s.state, 'stopped');
    await eventually(() => !alive(pid) && !alive(grandchild));
    assert.ok(Date.now() - t0 < 1500);
  });

  test('stop() escalates to SIGKILL when the engine ignores SIGTERM', async () => {
    const { s, dir } = fakeEngine({ FAKE_MODE: 'ignore-sigterm' });
    s.start();
    await waitFor(s, 'running');
    const [pid] = readFileSync(path.join(dir, 'pids'), 'utf8').split(' ').map(Number) as [number];
    await s.stop();
    await eventually(() => !alive(pid));
    assert.equal(s.status().lastExit?.signal, 'SIGKILL');
  });

  test('restarts after a crash and gives up into "failed" after maxCrashes', async () => {
    const { s } = fakeEngine({ FAKE_MODE: 'crash' }, { maxCrashes: 3, failedRetryMs: 60_000 });
    const states: EngineState[] = [];
    s.on('state', (st: EngineState) => states.push(st));
    s.start();
    await waitFor(s, 'failed');
    assert.equal(s.status().restarts, 3);
    assert.equal(states.filter((x) => x === 'restarting').length, 2);
    assert.equal(s.status().lastExit?.code, 3);
    assert.match(s.status().lastError!, /3 crashes/);
    await s.stop();
  });

  test('kills and restarts an engine that never becomes ready', async () => {
    const { s } = fakeEngine({ FAKE_MODE: 'no-ready' }, { startupTimeoutMs: 300 });
    s.start();
    await waitFor(s, 'restarting');
    assert.equal(s.status().lastExit?.reason, 'startup timeout');
    await s.stop();
  });

  test('restarts an engine whose heartbeat stops answering', async () => {
    const { s } = fakeEngine({ FAKE_MODE: 'hang' }, { heartbeatIntervalMs: 50, heartbeatMisses: 2 });
    s.start();
    await waitFor(s, 'running');
    await waitFor(s, 'restarting', 10_000);
    assert.equal(s.status().lastExit?.reason, 'unresponsive');
    await s.stop();
  });

  test('reports spawn failures as crashes', async () => {
    const { s } = fakeEngine({}, { nodeBin: '/nonexistent/node', maxCrashes: 1 });
    s.start();
    await waitFor(s, 'failed');
    assert.match(s.status().lastError!, /crashes|spawn failed/);
    assert.equal(s.url, null);
  });
});

describe('rewriteEngineUrls', () => {
  const engine = 'http://127.0.0.1:11470/';
  test('rewrites public engine URLs on our host to loopback', () => {
    const q = '?' + new URLSearchParams({ mediaURL: 'http://192.168.0.13:8095/engine/abcdef/0?x=1', other: 'y' });
    const out = new URLSearchParams(rewriteEngineUrls(q, ['192.168.0.13:8095'], engine));
    assert.equal(out.get('mediaURL'), 'http://127.0.0.1:11470/abcdef/0?x=1');
    assert.equal(out.get('other'), 'y');
  });
  test('handles a sub-path behind a reverse proxy', () => {
    const q = new URLSearchParams({ from: 'https://media.example.com/stremio/engine/subtitles.srt' }).toString();
    const out = new URLSearchParams(rewriteEngineUrls(q, ['media.example.com'], engine));
    assert.equal(out.get('from'), 'http://127.0.0.1:11470/subtitles.srt');
  });
  test('leaves other hosts and non-engine paths alone', () => {
    const q = new URLSearchParams({ a: 'http://other.host/engine/x', b: 'http://myhost/api/x', c: 'plain' }).toString();
    assert.equal(rewriteEngineUrls(q, ['myhost'], engine), q);
  });
});

describe('parseSize', () => {
  test('units', () => {
    assert.equal(parseSize('20GB'), 20e9);
    assert.equal(parseSize('512MiB'), 512 * 2 ** 20);
    assert.equal(parseSize('0'), 0);
    assert.equal(parseSize('unlimited'), null);
    assert.throws(() => parseSize('lots'));
  });
});
