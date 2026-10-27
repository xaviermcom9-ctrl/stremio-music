// Ported from Resonance (~/resonance/server/src/protocol/request.ts).
import { encode } from 'node:querystring';
import type { ExtraArgs } from './types.js';

/**
 * Builds a resource URL from a manifest URL, matching stremio-addon-client's
 * stringifyRequest: `/{resource}/{type}/{id}[/{extra}].json`, each path part
 * encodeURIComponent'd and `extra` serialized with querystring.encode.
 */
export function resourceUrl(
  manifestUrl: string,
  resource: string,
  type: string,
  id: string,
  extra?: ExtraArgs,
): string {
  const url = new URL(manifestUrl);
  const parts = [resource, type, id].map(encodeURIComponent);
  const extraStr = encodeExtra(extra);
  if (extraStr) parts.push(extraStr);
  url.pathname = url.pathname.replace(/\/manifest\.json$/, `/${parts.join('/')}.json`);
  return url.toString();
}

export function encodeExtra(extra?: ExtraArgs): string {
  if (!extra) return '';
  const defined = Object.fromEntries(
    Object.entries(extra).filter(([, v]) => v !== undefined && v !== '') as [string, string | number][],
  );
  return Object.keys(defined).length ? encode(defined) : '';
}

/** The addon's base URL (everything before /manifest.json), used as a cache-key prefix. */
export function addonBaseUrl(manifestUrl: string): string {
  return manifestUrl.replace(/\/manifest\.json(\?.*)?$/, '/');
}
