// Stand-in for server.js: same readiness line, /heartbeat and /settings, plus a long-lived
// grandchild (like ffmpeg) to check that the whole process group is stopped.
// Behaviour via env: FAKE_MODE=ok|crash|hang|no-ready|ignore-sigterm, FAKE_PORT, FAKE_PIDFILE.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';

const mode = process.env.FAKE_MODE ?? 'ok';
const port = Number(process.env.FAKE_PORT ?? 0);
let settings = { serverVersion: 'fake-1.0', cacheSize: 2147483648 };

if (mode === 'crash') process.exit(3);
if (mode === 'ignore-sigterm') process.on('SIGTERM', () => {});

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, `${process.pid} ${grandchild.pid}`);

const server = http.createServer((req, res) => {
  if (req.url === '/heartbeat') {
    if (mode === 'hang') return; // never answers
    return res.end('{"success":true}');
  }
  if (req.url === '/settings' && req.method === 'GET') {
    return res.end(JSON.stringify({ options: [], values: settings }));
  }
  if (req.url === '/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      settings = { ...settings, ...JSON.parse(body) };
      if (process.env.FAKE_SETTINGS_LOG) appendFileSync(process.env.FAKE_SETTINGS_LOG, body + '\n');
      res.end('{"success":true}');
    });
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ path: req.url }));
});
server.listen(port, () => {
  if (mode !== 'no-ready') console.log(`EngineFS server started at http://127.0.0.1:${server.address().port}`);
});
