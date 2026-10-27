// Opens an upstream media URL for the proxy and the transcoder: Node's http(s) client, redirects
// followed by hand so every hop is checked. Hosts a source explicitly allows (e.g. its server URL,
// which may be on the Docker network) may be private; anything else (radio stations from a public
// directory…) must resolve to a public address, pinned by publicOnlyLookup.
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { isPrivateAddress, publicOnlyLookup } from './icy.js';

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 15_000;
/** where a URL redirected to recently: archive.org & co. redirect every request to a storage host */
const REDIRECT_TTL_MS = 10 * 60_000;

// keep-alive: ffmpeg seeks with several range requests in a row; reusing the TLS connection saves
// a handshake each (≈ 3 round trips, a second or more from Australia to the US/Europe)
const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 15_000 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 15_000 }),
};
const redirects = new Map<string, { to: string; at: number }>();

function rememberRedirect(from: string, to: string): void {
  redirects.set(from, { to, at: Date.now() });
  if (redirects.size > 2000) redirects.delete(redirects.keys().next().value!);
}

export interface UpstreamOptions {
  headers?: Record<string, string>;
  /** true for hosts the source allows (may be private); others must be public */
  trustedHost(host: string): boolean;
  /** may untrusted (public) hosts be fetched at all? */
  allowPublic: boolean;
  signal?: AbortSignal;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

export async function openUpstream(url: string, opts: UpstreamOptions): Promise<IncomingMessage> {
  const known = redirects.get(url);
  let target = new URL(known && Date.now() - known.at < REDIRECT_TTL_MS ? known.to : url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new UpstreamError('only http(s) upstreams', 400);
    const trusted = opts.trustedHost(target.host);
    if (!trusted && !opts.allowPublic) throw new UpstreamError(`host not allowed: ${target.host}`, 403);
    // Node skips the lookup function for IP literals, so check those here
    const literal = target.hostname.replace(/^\[|\]$/g, '');
    if (!trusted && isIP(literal) && isPrivateAddress(literal)) throw new UpstreamError(`${target.host} is a private address`, 403);
    const res = await request(target, opts, trusted);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      target = new URL(res.headers.location, target);
      continue;
    }
    // the final hop's checks above apply again whenever the cached target is used
    if (target.href !== url && status < 400) rememberRedirect(url, target.href);
    return res;
  }
  throw new UpstreamError('too many redirects');
}

function request(target: URL, opts: UpstreamOptions, trusted: boolean): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.get(target, {
      agent: trusted ? agents[target.protocol as 'http:' | 'https:'] : undefined,
      headers: { accept: '*/*', ...opts.headers },
      lookup: trusted ? undefined : publicOnlyLookup,
      signal: opts.signal,
    });
    const timer = setTimeout(() => req.destroy(new UpstreamError(`no response from ${target.host}`, 504)), CONNECT_TIMEOUT_MS);
    req.on('response', (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      reject(err instanceof UpstreamError ? err : new UpstreamError(code === 'EPRIVATE' ? `${target.host} resolves to a private address` : `${target.host}: ${err.message}`, code === 'EPRIVATE' ? 403 : 502));
    });
  });
}
