import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { isPrivateAddress, parseStreamTitle, readNowPlaying } from '../src/music/icy.js';

describe('ICY now playing', () => {
  let server: http.Server;
  let base = '';

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://10.1.2.3/stream' });
        return res.end();
      }
      const metaint = 16;
      if (req.headers['icy-metadata'] !== '1') return res.end('no metadata requested');
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'icy-metaint': String(metaint), 'icy-name': 'Test FM' });
      const meta = Buffer.from("StreamTitle='The Band - It's A Song';StreamUrl='';");
      const blocks = Math.ceil(meta.length / 16);
      const padded = Buffer.concat([meta, Buffer.alloc(blocks * 16 - meta.length)]);
      res.write(Buffer.concat([Buffer.alloc(metaint, 0xff), Buffer.from([blocks]), padded, Buffer.alloc(64, 0xff)]));
      // keep the connection open like a real stream
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  test('parses StreamTitle, including apostrophes', () => {
    assert.equal(parseStreamTitle("StreamTitle='A - B';StreamUrl='x';"), 'A - B');
    assert.equal(parseStreamTitle("StreamTitle='Don't Stop - Band';"), "Don't Stop - Band");
    assert.equal(parseStreamTitle("StreamTitle='';"), null);
  });

  test('private address detection', () => {
    for (const a of ['127.0.0.1', '10.0.0.5', '172.18.0.5', '192.168.0.13', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      assert.ok(isPrivateAddress(a), a);
    }
    for (const a of ['91.98.4.78', '8.8.8.8', '2a01:4f8:1c1d:699::1']) assert.ok(!isPrivateAddress(a), a);
  });

  test('reads the title from the first metadata block', async () => {
    const np = await readNowPlaying(`${base}/stream`, { userAgent: 'test', allowPrivate: true });
    assert.deepEqual(np, { title: "The Band - It's A Song", station: 'Test FM' });
  });

  test('refuses private addresses (also after a redirect)', async () => {
    await assert.rejects(readNowPlaying(`${base}/stream`, { userAgent: 'test' }), /private/);
    await assert.rejects(readNowPlaying('http://localhost:9/stream', { userAgent: 'test' }), /private/);
    await assert.rejects(readNowPlaying(`${base}/redirect`, { userAgent: 'test', allowPrivate: false }), /private/);
  });
});
