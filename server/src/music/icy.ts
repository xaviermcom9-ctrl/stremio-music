// "Now playing" for internet radio: reads the first ICY metadata block of a stream (Shoutcast /
// Icecast, request header `Icy-MetaData: 1`, metadata every `icy-metaint` bytes) and returns its
// StreamTitle. Station URLs come from a public directory, so connections to private, loopback and
// link-local addresses are refused (on every redirect hop, with the checked address pinned).
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
/** a metadata interval beyond this isn't worth reading for a title */
const MAX_METAINT = 256 * 1024;

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
// (no ::ffff:0:0/96 rule: BlockList applies IPv4-mapped rules to plain IPv4 checks, so it would
// match every IPv4 address; mapped addresses are unwrapped in isPrivateAddress instead)
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPrivateAddress(mapped[1]!);
  const family = isIP(address);
  if (family === 0) return true;
  return PRIVATE.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** DNS lookup that refuses private addresses (the socket connects to the address checked here). */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = (addresses as unknown as { address: string; family: number }[]).filter((a) => !isPrivateAddress(a.address));
    if (list.length === 0) return callback(Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'EPRIVATE' }), '', 0);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

export interface NowPlaying {
  title: string | null;
  /** station name from the icy-name header */
  station?: string;
}

/** `StreamTitle='Artist - Title';StreamUrl='…';` -> "Artist - Title" */
export function parseStreamTitle(block: string): string | null {
  const m = /StreamTitle='((?:[^']|'(?!;))*)';/.exec(block);
  const title = m?.[1]?.trim();
  return title ? title : null;
}

export async function readNowPlaying(url: string, opts: { userAgent: string; allowPrivate?: boolean }): Promise<NowPlaying> {
  let target = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('only http(s) streams');
    if (!opts.allowPrivate && isIP(target.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error('private address');
    }
    const result = await requestOnce(target, opts);
    if ('redirect' in result) {
      target = new URL(result.redirect, target);
      continue;
    }
    return result;
  }
  throw new Error('too many redirects');
}

function requestOnce(target: URL, opts: { userAgent: string; allowPrivate?: boolean }): Promise<NowPlaying | { redirect: string }> {
  return new Promise((resolve, reject) => {
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.get(
      target,
      {
        headers: { 'icy-metadata': '1', 'user-agent': opts.userAgent, accept: '*/*' },
        lookup: opts.allowPrivate ? undefined : publicOnlyLookup,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.destroy();
          return resolve({ redirect: res.headers.location });
        }
        if (status !== 200) {
          res.destroy();
          return reject(new Error(`HTTP ${status}`));
        }
        const station = typeof res.headers['icy-name'] === 'string' ? res.headers['icy-name'] : undefined;
        const metaint = Number(res.headers['icy-metaint']);
        if (!Number.isInteger(metaint) || metaint <= 0 || metaint > MAX_METAINT) {
          res.destroy();
          return resolve({ title: null, station });
        }
        let buf = Buffer.alloc(0);
        res.on('data', (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          if (buf.length <= metaint) return;
          const len = buf[metaint]! * 16;
          if (buf.length < metaint + 1 + len) return;
          res.destroy();
          const block = buf.subarray(metaint + 1, metaint + 1 + len).toString('utf8').replace(/\0+$/, '');
          resolve({ title: parseStreamTitle(block), station });
        });
        res.on('end', () => resolve({ title: null, station }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}
