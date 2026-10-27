import path from 'node:path';
import { z } from 'zod';

const SIZE_UNITS: Record<string, number> = { '': 1, B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 2 ** 10, MIB: 2 ** 20, GIB: 2 ** 30, TIB: 2 ** 40 };

/** "20GB", "512MiB", "0" (no caching), "unlimited" -> bytes | null (unlimited) */
export function parseSize(value: string): number | null {
  const v = value.trim();
  if (/^(unlimited|infinite|none)$/i.test(v)) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(v);
  const unit = m && SIZE_UNITS[m[2]!.toUpperCase()];
  if (!m || unit === undefined || unit === null) throw new Error(`invalid size "${value}" (examples: 20GB, 512MiB, 0, unlimited)`);
  return Math.round(Number(m[1]) * unit);
}

const bool = z.enum(['true', 'false', '1', '0', 'yes', 'no']).transform((v) => ['true', '1', 'yes'].includes(v));

const Env = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8095),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CONFIG_DIR: z.string().default('/config'),
  CACHE_DIR: z.string().default('/cache'),
  MUSIC_DIR: z.string().default('/music'),
  DOWNLOADS_DIR: z.string().default('/downloads'),
  WEB_ROOT: z.string().default('/app/web'),
  ENGINE_ENABLED: bool.default(true),
  ENGINE_SCRIPT: z.string().default('/app/engine/server.js'),
  ENGINE_PRELOAD: z.string().default('/app/engine/bind-loopback.cjs'),
  ENGINE_CACHE_SIZE: z.string().default('10GB').transform((v, ctx) => {
    try {
      return parseSize(v);
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: (err as Error).message });
      return z.NEVER;
    }
  }),
  FFMPEG_BIN: z.string().default('/usr/bin/ffmpeg'),
  FFPROBE_BIN: z.string().default('/usr/bin/ffprobe'),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    dirs: { config: e.CONFIG_DIR, cache: e.CACHE_DIR, music: e.MUSIC_DIR, downloads: e.DOWNLOADS_DIR },
    dbPath: path.join(e.CONFIG_DIR, 'app.db'),
    webRoot: e.WEB_ROOT,
    engine: {
      enabled: e.ENGINE_ENABLED,
      script: e.ENGINE_SCRIPT,
      preload: e.ENGINE_PRELOAD,
      appPath: path.join(e.CACHE_DIR, 'engine'),
      cacheSize: e.ENGINE_CACHE_SIZE,
      ffmpeg: e.FFMPEG_BIN,
      ffprobe: e.FFPROBE_BIN,
    },
  };
}
