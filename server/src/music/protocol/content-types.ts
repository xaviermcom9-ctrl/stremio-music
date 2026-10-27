// Adapted from Resonance (~/resonance/server/src/protocol/content-types.ts).
import type { Meta } from './types.js';
import type { MusicKind } from '../../music-sources/sdk.js';

/** Only addons declaring this type are used as music sources (brief: `"music"` in `types`). */
export const MUSIC_TYPE = 'music';

/**
 * What a meta item is. Our own sources set `music.kind`; for third-party addons without it:
 * `videos` -> album (videos are tracks), otherwise a single track.
 */
export function classifyMeta(meta: Pick<Meta, 'videos'> & { music?: { kind?: string } }): MusicKind {
  const kind = meta.music?.kind;
  if (kind === 'artist' || kind === 'album' || kind === 'track' || kind === 'station' || kind === 'playlist') return kind;
  return meta.videos && meta.videos.length > 0 ? 'album' : 'track';
}
