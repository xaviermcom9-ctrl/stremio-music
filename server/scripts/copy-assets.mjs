// Copies non-TypeScript files of built-in sources (icons) and the plugin SDK types into dist/.
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const src = 'src/music-sources';
const out = 'dist/src/music-sources';
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : [path.join(dir, n)]));
for (const file of walk(src).filter((f) => /\.(svg|png|md)$/.test(f))) {
  const dest = path.join(out, path.relative(src, file));
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(file, dest);
}
// sdk.ts is types only, so it is also valid as a declaration file for folder plugins
copyFileSync(path.join(src, 'sdk.ts'), path.join(out, 'sdk.d.ts'));
