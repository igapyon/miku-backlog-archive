import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFileAtomically } from '../archive/atomic-write.mjs';

const UI_SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

/**
 * Write the shared stylesheet into a generated archive site.
 *
 * @param {string} siteDirectory
 */
export async function writeUiAssets(siteDirectory) {
  const [tokens, styles] = await Promise.all([
    readFile(join(UI_SOURCE_DIRECTORY, 'tokens.css'), 'utf8'),
    readFile(join(UI_SOURCE_DIRECTORY, 'archive.css'), 'utf8'),
  ]);
  await writeFileAtomically(join(siteDirectory, 'assets', 'style.css'), `${tokens.trim()}\n\n${styles.trim()}\n`);
}
