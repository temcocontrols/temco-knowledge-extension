// No command id is registered twice.
//
// A duplicate throws where the *later* one is registered — which is somewhere in the middle of `activate()`, so
// everything below it silently never happens. This cost a whole afternoon once: `temcoKnowledge.runOwed` was
// registered in both `builds.ts` and `extension.ts`, activation died at that line, and the visible symptom was a
// Workspace view that stayed empty, because the `refresh()` at the end of activation never ran. Nothing about
// that symptom points at the mistake, so the mistake has to be caught here instead.
//
// Run by `npm run compile`. No dependencies: it reads the sources as text.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '');

/** Every `.ts` file under a directory, depth first. */
function sourcesIn(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourcesIn(path));
    } else if (entry.name.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found;
}

/** Where each command id is registered, by file and line. */
const registrations = new Map();
for (const file of sourcesIn(join(root, 'src'))) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/registerCommand\(\s*'([^']+)'/g)) {
      const where = `${relative(root, file).replace(/\\/g, '/')}:${index + 1}`;
      registrations.set(match[1], [...(registrations.get(match[1]) ?? []), where]);
    }
  });
}

const duplicated = [...registrations]
  .filter(([, places]) => places.length > 1)
  .map(([id, places]) => `  ${id}\n    registered at ${places.join('\n    registered at ')}`);

if (duplicated.length > 0) {
  console.error(
    `A command id can only be registered once, or activation throws where the second one is registered:\n` +
      `${duplicated.join('\n')}`
  );
  process.exit(1);
}

console.log(`${registrations.size} commands, each registered once.`);
