// Built-in music sources, in default priority order. `npm run new-source <name>` adds entries here.
import type { MusicSource } from './sdk.js';
import freeMusicArchive from './free-music-archive/index.js';
import internetArchive from './internet-archive/index.js';
import jamendo from './jamendo/index.js';
import navidrome from './navidrome/index.js';
import radioBrowser from './radio-browser/index.js';

export const BUILTIN_SOURCES: MusicSource[] = [
  navidrome,
  internetArchive,
  jamendo,
  freeMusicArchive,
  radioBrowser,
];
