// Built-in music sources, in default priority order. `npm run new-source <name>` adds entries here.
// (Phase 6 adds Navidrome, Internet Archive, Jamendo, Free Music Archive and Radio Browser.)
import type { MusicSource } from './sdk.js';
import internetArchive from './internet-archive/index.js';
import navidrome from './navidrome/index.js';
import radioBrowser from './radio-browser/index.js';

export const BUILTIN_SOURCES: MusicSource[] = [
  navidrome,
  internetArchive,
  radioBrowser,
];
