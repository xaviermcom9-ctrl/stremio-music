import './net.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { EngineSupervisor } from './engine/supervisor.js';

const config = loadConfig();
const db = openDb(config.dbPath);

let log = { info: console.log, warn: console.warn, error: console.error };
const engine = new EngineSupervisor({
  script: config.engine.script,
  preload: config.engine.preload,
  appPath: config.engine.appPath,
  cacheSize: config.engine.cacheSize,
  ffmpeg: config.engine.ffmpeg,
  ffprobe: config.engine.ffprobe,
  log: { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) },
});

const app = await buildApp({ config, db, engine });
const engineLog = app.log.child({ component: 'engine' });
log = {
  info: (m) => engineLog.info(m),
  warn: (m) => engineLog.warn(m),
  error: (m) => engineLog.error(m),
};
engine.on('log', (line: string) => engineLog.debug(line));
engine.on('state', (state: string) => engineLog.info({ state }, 'engine state'));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const hardExit = setTimeout(() => process.exit(1), 10_000);
  hardExit.unref();
  try {
    // stop the engine first: closing the HTTP server waits for open streams to finish
    await engine.stop();
    await app.close();
    db.close();
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
if (config.engine.enabled) engine.start();
