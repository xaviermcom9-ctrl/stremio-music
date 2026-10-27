// `npm run test:sources [plugin-dir…]`: the contract suite for every built-in source, the template,
// and any folder plugin directories given (run in their sandboxed process, like in production).
import '../../src/net.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_SOURCES } from '../../src/music-sources/index.js';
import template from '../../src/music-sources/_template/index.js';
import { FolderPlugin } from '../../src/music/folder.js';
import { contractSuite } from './contract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// fixtures live next to the sources' TypeScript, not in dist/
const srcDir = path.resolve(here, '../../../src/music-sources');

const args = process.argv.slice(2);
// --record <source id>: run that built-in source against the real service and save fixtures.json
const recordIdx = args.indexOf('--record');
const record = recordIdx >= 0 ? args.splice(recordIdx, 2)[1] : undefined;
const dirs = args;

// with plugin directories given, test only those (e.g. sm-test-source in the container)
if (dirs.length === 0) {
  if (!record) contractSuite('_template', async () => ({ impl: template, dir: path.join(srcDir, '_template') }));
  for (const impl of BUILTIN_SOURCES.filter((s) => !record || s.manifest.id === record)) {
    contractSuite(impl.manifest.id, async () => ({ impl, dir: path.join(srcDir, impl.manifest.id) }), { record: !!record });
  }
}

for (const dir of dirs) {
  const abs = path.resolve(dir);
  contractSuite(`folder plugin ${abs}`, async () => {
    const plugin = new FolderPlugin(abs);
    await plugin.start();
    return { impl: plugin.asSource(), dir: abs, close: () => plugin.stop() };
  });
}
