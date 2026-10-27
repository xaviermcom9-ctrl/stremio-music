// Ported from Resonance (~/resonance/server/src/protocol/manifest.ts).
import type { ExtraProp, Manifest, ManifestCatalog, ResourceDescriptor } from './types.js';

export interface ManifestValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Normalized copy (legacy catalog extras folded into `extra`); set when valid. */
  manifest?: Manifest;
}

const KNOWN_RESOURCES = ['catalog', 'meta', 'stream', 'subtitles', 'addon_catalog'];
// Semantic version 2.0.0 (https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string)
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validates a manifest with the same hard rules as the official
 * stremio-addon-linter (which the SDK runs on every addon), plus warnings for
 * fields the docs mark as required but the linter does not enforce.
 */
export function validateManifest(input: unknown): ManifestValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(input)) return { valid: false, errors: ['manifest must be an object'], warnings };
  const m = input;

  if (typeof m.id !== 'string') errors.push('manifest.id must be a string');
  if (typeof m.name !== 'string') errors.push('manifest.name must be a string');
  if (typeof m.version !== 'string' || !SEMVER.test(m.version))
    errors.push('manifest.version must be a valid semver string');
  if (m.description !== undefined && typeof m.description !== 'string')
    errors.push('manifest.description must be a string');
  else if (m.description === undefined) warnings.push('manifest.description is missing');

  if (!Array.isArray(m.resources)) errors.push('manifest.resources must be an array');
  else
    m.resources.forEach((r, i) => {
      if (typeof r === 'string') {
        if (!KNOWN_RESOURCES.includes(r)) warnings.push(`manifest.resources: unknown value ${r}`);
      } else if (isObj(r) && typeof r.name === 'string') {
        if (r.types !== undefined && !Array.isArray(r.types))
          errors.push(`manifest.resources[${i}].types must be an array`);
        if (r.idPrefixes !== undefined && !Array.isArray(r.idPrefixes))
          errors.push(`manifest.resources[${i}].idPrefixes must be an array`);
        if (!KNOWN_RESOURCES.includes(r.name)) warnings.push(`manifest.resources: unknown value ${r.name}`);
      } else errors.push(`manifest.resources[${i}] must be a string or { name, types, idPrefixes? }`);
    });

  if (!Array.isArray(m.types)) errors.push('manifest.types must be an array');
  if (!Array.isArray(m.catalogs)) errors.push('manifest.catalogs must be an array');
  if (m.idPrefixes !== undefined && m.idPrefixes !== null && !Array.isArray(m.idPrefixes))
    errors.push('manifest.idPrefixes must be an array');

  if (m.behaviorHints !== undefined) {
    if (!isObj(m.behaviorHints)) errors.push('manifest.behaviorHints must be an object');
    else
      for (const k of ['adult', 'configurable', 'configurationRequired', 'p2p'])
        if (k in m.behaviorHints && typeof m.behaviorHints[k] !== 'boolean')
          errors.push(`manifest.behaviorHints.${k} must be a boolean`);
  }

  const catalogs: ManifestCatalog[] = [];
  if (Array.isArray(m.catalogs))
    m.catalogs.forEach((c, i) => {
      const at = `manifest.catalogs[${i}]`;
      if (!isObj(c) || typeof c.id !== 'string' || typeof c.type !== 'string') {
        errors.push(`${at}: id and type must be string properties`);
        return;
      }
      if (c.extra !== undefined) {
        if (!Array.isArray(c.extra)) errors.push(`${at}.extra must be an array`);
        else
          c.extra.forEach((e, j) => {
            if (!isObj(e) || typeof e.name !== 'string') errors.push(`${at}.extra[${j}].name must be a string`);
            else if (e.isRequired !== undefined && typeof e.isRequired !== 'boolean')
              errors.push(`${at}.extra[${j}].isRequired must be a boolean`);
          });
      }
      for (const k of ['extraSupported', 'extraRequired'] as const)
        if (c[k] !== undefined && !Array.isArray(c[k])) errors.push(`${at}.${k} must be an array`);
      if (c.name === undefined) warnings.push(`${at}.name is missing`);
      catalogs.push(normalizeCatalog(c as unknown as ManifestCatalog));
    });

  if (errors.length) return { valid: false, errors, warnings };
  return { valid: true, errors, warnings, manifest: { ...(m as unknown as Manifest), catalogs } };
}

/** Folds the legacy `extraSupported` / `extraRequired` short notation into `extra`. */
function normalizeCatalog(c: ManifestCatalog): ManifestCatalog {
  if (c.extra || (!c.extraSupported && !c.extraRequired)) return c;
  const required = new Set(c.extraRequired ?? []);
  const names = [...new Set([...(c.extraSupported ?? []), ...required])];
  const extra: ExtraProp[] = names.map((name) => ({ name, isRequired: required.has(name) }));
  return { ...c, extra };
}

/** Port of stremio-addon-client's util/isSupported. */
export function isSupported(manifest: Manifest, resource: string, type: string, id: string): boolean {
  if (resource === 'catalog') return manifest.catalogs.some((c) => c.type === type && c.id === id);
  const matched = manifest.resources.find((r) => r === resource || (typeof r === 'object' && r.name === resource));
  if (!matched) return false;
  const { types, idPrefixes } =
    typeof matched === 'string'
      ? { types: manifest.types, idPrefixes: manifest.idPrefixes ?? undefined }
      : (matched as ResourceDescriptor);
  if (!Array.isArray(types) || !types.includes(type)) return false;
  return Array.isArray(idPrefixes) ? idPrefixes.some((p) => id.startsWith(p)) : true;
}

/** True when a catalog can be requested with exactly these extra names. */
export function catalogAccepts(catalog: ManifestCatalog, extraNames: string[]): boolean {
  const extra = catalog.extra ?? [];
  const supported = new Set(extra.map((e) => e.name));
  if (!extraNames.every((n) => supported.has(n))) return false;
  return extra.filter((e) => e.isRequired).every((e) => extraNames.includes(e.name));
}

/**
 * Resolves a configured addon URL to its manifest URL. Accepts the
 * `stremio://host/.../manifest.json` install-link form (mapped to https).
 * Only the HTTP transport is supported.
 */
export function normalizeManifestUrl(raw: string): string {
  const s = raw.trim().replace(/^stremio:\/\//i, 'https://');
  const url = new URL(s);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`unsupported addon transport "${url.protocol}" (only http/https)`);
  if (!url.pathname.endsWith('/manifest.json')) throw new Error('addon URL must end in /manifest.json');
  return url.toString();
}
