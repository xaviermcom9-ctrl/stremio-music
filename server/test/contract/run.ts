// `npm run test:sources [plugin-dir…]`: the contract suite for every built-in source, the template,
// and any folder plugin directories given (run in their sandboxed process, like in production).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_SOURCES } from '../../src/music-sources/index.js';
import template from '../../src/music-sources/_template/index.js';
import { FolderPlugin } from '../../src/music/folder.js';
import { contractSuite } from './contract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// fixtures live next to the sources' TypeScript, not in dist/
const srcDir = path.resolve(here, '../../../src/music-sources');

const dirs = process.argv.slice(2);

// with plugin directories given, test only those (e.g. sm-test-source in the container)
if (dirs.length === 0) {
  contractSuite('_template', async () => ({ impl: template, dir: path.join(srcDir, '_template') }));
  for (const impl of BUILTIN_SOURCES) {
    contractSuite(impl.manifest.id, async () => ({ impl, dir: path.join(srcDir, impl.manifest.id) }));
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
