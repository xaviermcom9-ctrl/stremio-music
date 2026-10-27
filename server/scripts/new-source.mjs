#!/usr/bin/env node
// Scaffolds a music source from src/music-sources/_template (see PLUGINS.md).
//
//   npm run new-source <name>                 built-in (TypeScript) in src/music-sources/<name>,
//                                             registered in src/music-sources/index.ts
//   npm run new-source <name> -- --folder <dir>
//   sm-new-source <name>                      (in the container) folder plugin (JavaScript) in
//                                             <dir>/<name> = /config/music-sources/<name>
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--folder');
const folderIdx = args.indexOf('--folder');
const folder = folderIdx >= 0 ? args[folderIdx + 1] : null;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!name || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
  die('usage: new-source <name> [--folder <dir>]\n  name: lowercase letters, digits and dashes, e.g. "my-radio"');
}
if (name === 'example' || name.startsWith('_')) die(`"${name}" is reserved`);

const title = name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Gives the copy its own id and name. */
function personalise(code) {
  return code
    .replace("const ID = 'example';", `const ID = '${name}';`)
    .replace("name: 'Example',", `name: '${title}',`)
    .replace(/description: 'An example source[^']*',/, `description: 'TODO: describe ${title}.',`);
}

if (folder) {
  // folder plugin: JavaScript compiled from the template (dist/), plus the SDK types for editors
  const compiled = path.join(root, 'dist/src/music-sources/_template/index.js');
  const sdk = path.join(root, 'dist/src/music-sources/sdk.d.ts');
  if (!existsSync(compiled)) die('build first (npm run build): dist/src/music-sources/_template/index.js is missing');
  const dest = path.join(path.resolve(folder), name);
  if (existsSync(dest)) die(`${dest} already exists`);
  mkdirSync(dest, { recursive: true });
  let js = personalise(readFileSync(compiled, 'utf8'))
    .replace(/^\/\/# sourceMappingURL=.*$/m, '')
    .replace('const source = {', "/** @type {import('./sdk').MusicSource} */\nconst source = {");
  js = `// @ts-check
// ${title}: a Stremio Music source plugin (folder plugin, plain JavaScript ES module).
// Started from the template: replace the demo data with calls to your service through ctx.fetch.
// Types for editors are in ./sdk.d.ts. Guide: PLUGINS.md in the stremio-music repository.
${js}`;
  writeFileSync(path.join(dest, 'index.js'), js);
  copyFileSync(sdk, path.join(dest, 'sdk.d.ts'));
  copyFileSync(path.join(root, 'dist/src/music-sources/_template/icon.svg'), path.join(dest, 'icon.svg'));
  writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }, null, 2) + '\n');
  const inContainer = root === '/app/server';
  console.log(`Created folder plugin ${dest}
Next: edit index.js, then "Reload plugins" on the Sources page (or restart the container).
Test it: ${inContainer ? `docker exec -it stremio-music sm-test-source ${dest}` : `node --disable-warning=ExperimentalWarning ${path.join(root, 'dist/test/contract/run.js')} ${dest}`}`);
} else {
  const dest = path.join(root, 'src/music-sources', name);
  if (existsSync(dest)) die(`${dest} already exists`);
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, 'index.ts'), personalise(readFileSync(path.join(root, 'src/music-sources/_template/index.ts'), 'utf8')));
  copyFileSync(path.join(root, 'src/music-sources/_template/icon.svg'), path.join(dest, 'icon.svg'));
  const indexFile = path.join(root, 'src/music-sources/index.ts');
  const ident = name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()).replace(/^(\d)/, '_$1');
  let index = readFileSync(indexFile, 'utf8');
  index = index.replace("import type { MusicSource } from './sdk.js';", `import type { MusicSource } from './sdk.js';\nimport ${ident} from './${name}/index.js';`);
  index = index.replace(/export const BUILTIN_SOURCES: MusicSource\[\] = \[\n/, (m) => `${m}  ${ident},\n`);
  writeFileSync(indexFile, index);
  console.log(`Created built-in source src/music-sources/${name}/ and registered it in src/music-sources/index.ts
Next: implement it, record fixtures.json, then: npm run build && npm run test:sources`);
}
