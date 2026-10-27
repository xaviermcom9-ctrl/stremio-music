// Settings forms for sources: validate input against the source's schema, encrypt secrets, mask
// them for the browser, and merge defaults <- global <- per-user values.
import type { SettingField, SettingsSchema } from '../music-sources/sdk.js';
import { SecretBox } from './secrets.js';

export type SettingValue = string | number | boolean;
export type StoredSettings = Record<string, SettingValue>;

/** What the browser gets for each field: secrets never leave the server. */
export type MaskedValue = SettingValue | { secret: true; set: boolean } | null;

export const fieldsFor = (schema: SettingsSchema, scope: 'global' | 'user') =>
  Object.entries(schema).filter(([, f]) => (scope === 'user' ? !!f.perUser : !f.perUser));

export function mask(schema: SettingsSchema, stored: StoredSettings, scope: 'global' | 'user'): Record<string, MaskedValue> {
  return Object.fromEntries(
    fieldsFor(schema, scope).map(([key, f]) => [key, f.secret ? { secret: true, set: stored[key] !== undefined && stored[key] !== '' } : (stored[key] ?? null)]),
  );
}

function coerce(key: string, f: SettingField, v: unknown): SettingValue {
  switch (f.type) {
    case 'boolean':
      if (typeof v !== 'boolean') throw new Error(`${f.label}: expected true/false`);
      return v;
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${f.label}: expected a number`);
      return n;
    }
    case 'select':
      if (typeof v !== 'string' || !f.options?.some((o) => o.value === v)) throw new Error(`${f.label}: not one of the options`);
      return v;
    case 'url': {
      if (typeof v !== 'string') throw new Error(`${f.label}: expected a URL`);
      const s = v.trim().replace(/\/+$/, '');
      let u: URL;
      try {
        u = new URL(s);
      } catch {
        throw new Error(`${f.label}: not a valid URL`);
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${f.label}: must be http(s)`);
      return s;
    }
    default:
      if (typeof v !== 'string') throw new Error(`${f.label}: expected text`);
      if (v.length > 2000) throw new Error(`${f.label}: too long`);
      return f.secret ? v : v.trim();
  }
  void key;
}

/**
 * Applies submitted values to stored ones. Unknown keys are rejected; for secrets, `undefined` or a
 * masked object keeps the current value and "" clears it. Returns the new stored object.
 */
export function applyInput(
  schema: SettingsSchema,
  scope: 'global' | 'user',
  stored: StoredSettings,
  input: Record<string, unknown>,
  box: SecretBox,
): StoredSettings {
  const fields = new Map(fieldsFor(schema, scope));
  const out: StoredSettings = { ...stored };
  for (const [key, raw] of Object.entries(input)) {
    const f = fields.get(key);
    if (!f) throw new Error(`unknown setting "${key}"`);
    if (raw === undefined || (typeof raw === 'object' && raw !== null && 'secret' in raw)) continue;
    if (raw === null || raw === '') {
      delete out[key];
      continue;
    }
    const v = coerce(key, f, raw);
    out[key] = f.secret ? box.encrypt(String(v)) : v;
  }
  return out;
}

/** defaults <- global <- per-user, secrets decrypted: what a source sees as ctx.settings. */
export function resolve(schema: SettingsSchema, global: StoredSettings, user: StoredSettings, box: SecretBox): Record<string, SettingValue | undefined> {
  const out: Record<string, SettingValue | undefined> = {};
  for (const [key, f] of Object.entries(schema)) {
    let v: SettingValue | undefined = f.perUser ? (user[key] ?? global[key]) : global[key];
    if (v === undefined) v = f.default;
    if (f.secret && SecretBox.isEncrypted(v)) {
      try {
        v = box.decrypt(v);
      } catch {
        v = undefined; // key changed: the secret must be entered again
      }
    }
    out[key] = v;
  }
  return out;
}

/** Required fields without a value, for "needs setup" status. */
export function missingRequired(schema: SettingsSchema, resolved: Record<string, unknown>, scope?: 'global' | 'user'): string[] {
  return Object.entries(schema)
    .filter(([, f]) => f.required && (scope === undefined || (scope === 'user') === !!f.perUser))
    .filter(([key]) => resolved[key] === undefined || resolved[key] === '')
    .map(([, f]) => f.label);
}
