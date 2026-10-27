import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineSupervisor, type EngineOptions, type EngineState } from '../src/engine/supervisor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_ENGINE = path.resolve(here, '../../test/fixtures/fake-engine.mjs');
export const PRELOAD = path.resolve(here, '../../../engine/bind-loopback.cjs');
const quiet = { info() {}, warn() {}, error() {} };
const supervisors: EngineSupervisor[] = [];

export function fakeEngine(env: Record<string, string>, opts: Partial<EngineOptions> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'engine-test-'));
  const s = new EngineSupervisor({
    script: FAKE_ENGINE,
    preload: PRELOAD,
    appPath: dir,
    log: quiet,
    env: { ...process.env, FAKE_PIDFILE: path.join(dir, 'pids'), FAKE_SETTINGS_LOG: path.join(dir, 'settings.log'), ...env },
    startupTimeoutMs: 3000,
    heartbeatIntervalMs: 100,
    stopTimeoutMs: 500,
    maxBackoffMs: 50,
    ...opts,
  });
  supervisors.push(s);
  return { s, dir };
}

export function waitFor(s: EngineSupervisor, state: EngineState, ms = 5000): Promise<void> {
  if (s.state === state) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${state}, state is ${s.state}`)), ms);
    const on = (st: EngineState) => {
      if (st === state) {
        clearTimeout(t);
        s.off('state', on);
        resolve();
      }
    };
    s.on('state', on);
  });
}

export async function stopAll(): Promise<void> {
  await Promise.all(supervisors.map((s) => s.stop()));
}
