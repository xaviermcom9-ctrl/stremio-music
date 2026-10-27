// Lidarr/Prowlarr settings (admin): stored in app_settings, API keys encrypted with the source-secret key.
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { SecretBox } from '../music/secrets.js';
import { sentOnly } from '../settings-patch.js';

export const LidarrSettingsSchema = z.object({
  lidarr: z
    .object({
      url: z.string().max(500).default('http://lidarr:8686'),
      apiKey: z.string().max(200).default(''),
      /** where Lidarr puts new artists; best the library Navidrome reads */
      rootFolderPath: z.string().max(1000).default(''),
      qualityProfileId: z.number().int().min(0).default(0),
      metadataProfileId: z.number().int().min(0).default(0),
    })
    .default({ url: 'http://lidarr:8686', apiKey: '', rootFolderPath: '', qualityProfileId: 0, metadataProfileId: 0 }),
  prowlarr: z
    .object({
      url: z.string().max(500).default('http://prowlarr:9696'),
      apiKey: z.string().max(200).default(''),
    })
    .default({ url: 'http://prowlarr:9696', apiKey: '' }),
  /** non-admin users may request albums too */
  allowUsers: z.boolean().default(true),
});

export type LidarrSettings = z.infer<typeof LidarrSettingsSchema>;

const KEY = 'lidarr';

export class LidarrSettingsStore {
  private cache: LidarrSettings | null = null;

  constructor(
    private db: DatabaseSync,
    private box: SecretBox,
  ) {}

  get(): LidarrSettings {
    if (this.cache) return this.cache;
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    const raw = row ? (JSON.parse(row.value) as { lidarr?: { apiKey?: string }; prowlarr?: { apiKey?: string } }) : {};
    for (const part of [raw.lidarr, raw.prowlarr]) {
      if (part?.apiKey) {
        try {
          part.apiKey = this.box.decrypt(part.apiKey);
        } catch {
          part.apiKey = '';
        }
      }
    }
    this.cache = LidarrSettingsSchema.parse(raw);
    return this.cache;
  }

  /** Requests can be made: Lidarr address, key and where to put new artists are known. */
  ready(): boolean {
    const l = this.get().lidarr;
    return !!(l.url && l.apiKey && l.rootFolderPath && l.qualityProfileId && l.metadataProfileId);
  }

  /** For the browser: API keys are never sent back, only whether they're set. */
  public() {
    const s = this.get();
    const { apiKey: lk, ...lidarr } = s.lidarr;
    const { apiKey: pk, ...prowlarr } = s.prowlarr;
    return { ...s, lidarr: { ...lidarr, hasApiKey: !!lk }, prowlarr: { ...prowlarr, hasApiKey: !!pk }, ready: this.ready() };
  }

  /** Partial update; empty API keys keep the saved ones. */
  set(input: unknown): LidarrSettings {
    const cur = this.get();
    const patch = z
      .object({
        lidarr: LidarrSettingsSchema.shape.lidarr.unwrap().partial().optional(),
        prowlarr: LidarrSettingsSchema.shape.prowlarr.unwrap().partial().optional(),
        allowUsers: z.boolean().optional(),
      })
      .parse(input);
    const raw = (input ?? {}) as { lidarr?: unknown; prowlarr?: unknown };
    const pl = patch.lidarr ? sentOnly(patch.lidarr, raw.lidarr) : {};
    const pp = patch.prowlarr ? sentOnly(patch.prowlarr, raw.prowlarr) : {};
    const lidarr = { ...cur.lidarr, ...pl, apiKey: pl.apiKey || cur.lidarr.apiKey };
    const prowlarr = { ...cur.prowlarr, ...pp, apiKey: pp.apiKey || cur.prowlarr.apiKey };
    const next = LidarrSettingsSchema.parse({ ...cur, ...sentOnly(patch, input), lidarr, prowlarr });
    const enc = (k: string) => (k ? this.box.encrypt(k) : '');
    const stored = { ...next, lidarr: { ...next.lidarr, apiKey: enc(next.lidarr.apiKey) }, prowlarr: { ...next.prowlarr, apiKey: enc(next.prowlarr.apiKey) } };
    this.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(stored));
    this.cache = next;
    return next;
  }
}
