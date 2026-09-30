import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { writeJsonAtomically } from './atomic-write.mjs';
import {
  ArchiveFormatError,
  createInitialManifest,
  createInitialProgress,
  validateManifest,
  validateProgress,
} from './format.mjs';

export const ARCHIVE_DIRECTORIES = ['assets', 'data', 'site', 'state'];

/** @param {string} output */
export function archivePaths(output) {
  const root = resolve(output);
  return {
    root,
    manifest: join(root, 'manifest.json'),
    progress: join(root, 'state', 'progress.json'),
    assets: join(root, 'assets'),
    data: join(root, 'data'),
    site: join(root, 'site'),
    state: join(root, 'state'),
  };
}

async function assertEmptyOrMissingDirectory(root) {
  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      throw new ArchiveFormatError(`Archive output is not a directory: ${root}`);
    }
    const entries = await readdir(root);
    if (entries.length > 0) {
      throw new ArchiveFormatError(
        `Archive output must be empty to initialize safely: ${root}`,
      );
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Initialize a new archive without making any network request. The resulting
 * archive is deliberately not considered collected or complete.
 *
 * @param {{ output: string, domain: string, projectKey: string, now?: Date, toolVersion?: string }} input
 */
export async function initializeArchive(input) {
  if (typeof input.output !== 'string' || input.output.trim() === '') {
    throw new ArchiveFormatError('Archive output directory is required.');
  }

  const paths = archivePaths(input.output);
  await assertEmptyOrMissingDirectory(paths.root);

  const manifest = createInitialManifest(input);
  const progress = createInitialProgress(manifest.archive, input.now);

  await Promise.all(
    ARCHIVE_DIRECTORIES.map((directory) => mkdir(paths[directory], { recursive: true })),
  );

  await writeJsonAtomically(paths.manifest, manifest);
  await writeJsonAtomically(paths.progress, progress);

  return { paths, manifest, progress };
}

async function readJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ArchiveFormatError(`Required archive file is missing: ${path}`);
    }
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ArchiveFormatError(`Invalid JSON: ${path}`);
  }
}

/**
 * @param {string} output
 */
export async function verifyArchive(output) {
  const paths = archivePaths(output);
  const manifest = validateManifest(await readJson(paths.manifest));
  const archive = /** @type {Record<string, unknown>} */ (manifest.archive);
  const progress = validateProgress(await readJson(paths.progress), archive.id);

  for (const directory of ARCHIVE_DIRECTORIES) {
    try {
      const directoryStat = await stat(paths[directory]);
      if (!directoryStat.isDirectory()) {
        throw new ArchiveFormatError(`Expected archive directory is not a directory: ${paths[directory]}`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new ArchiveFormatError(`Required archive directory is missing: ${paths[directory]}`);
      }
      throw error;
    }
  }

  return { paths, manifest, progress };
}
