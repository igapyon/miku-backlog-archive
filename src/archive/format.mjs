import { randomUUID } from 'node:crypto';

export const MANIFEST_SCHEMA_VERSION = 'miku-backlog-archive/manifest/v1';
export const PROGRESS_SCHEMA_VERSION = 'miku-backlog-archive/progress/v1';

export class ArchiveFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArchiveFormatError';
  }
}

/**
 * The domain is intentionally stored without a scheme or path. This makes a
 * resume check unambiguous and prevents an accidentally pasted API URL from
 * becoming part of the archive identity.
 *
 * @param {string} value
 */
export function normalizeBacklogDomain(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ArchiveFormatError('Backlog domain is required.');
  }

  const candidate = value.trim().toLowerCase();
  let parsed;
  try {
    parsed = new URL(`https://${candidate}`);
  } catch {
    throw new ArchiveFormatError('Backlog domain must be a valid hostname.');
  }

  if (
    parsed.hostname !== candidate ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new ArchiveFormatError(
      'Backlog domain must be a hostname only, without a scheme, path, port, or credentials.',
    );
  }

  return candidate;
}

/**
 * @param {string} value
 */
export function normalizeProjectKey(value) {
  if (typeof value !== 'string') {
    throw new ArchiveFormatError('Project key is required.');
  }

  const key = value.trim();
  if (key === '' || /[\\/\u0000-\u001f]/u.test(key)) {
    throw new ArchiveFormatError('Project key must be a non-empty single-line value.');
  }

  return key;
}

/**
 * @param {{ domain: string, projectKey: string, now?: Date, toolVersion?: string }} input
 */
export function createInitialManifest(input) {
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new ArchiveFormatError('Archive creation time must be a valid Date.');
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    archive: {
      id: randomUUID(),
      createdAt: now.toISOString(),
      toolVersion: input.toolVersion ?? '0.1.0',
    },
    source: {
      domain: normalizeBacklogDomain(input.domain),
      project: {
        key: normalizeProjectKey(input.projectKey),
        id: null,
      },
    },
    collection: {
      status: 'initialized',
      startedAt: null,
      completedAt: null,
      counts: null,
    },
  };
}

/**
 * @param {{ id: string }} manifest
 * @param {Date} [now]
 */
export function createInitialProgress(manifest, now = new Date()) {
  return {
    schemaVersion: PROGRESS_SCHEMA_VERSION,
    archiveId: manifest.id,
    updatedAt: now.toISOString(),
    phase: 'initialized',
    tasks: {},
    failures: [],
  };
}

/**
 * Validate only the invariants needed before this tool resumes an archive.
 * Unknown fields are deliberately retained for forward-compatible readers.
 *
 * @param {unknown} value
 */
export function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArchiveFormatError('manifest.json must contain an object.');
  }

  const manifest = /** @type {Record<string, unknown>} */ (value);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ArchiveFormatError(`Unsupported manifest schema: ${String(manifest.schemaVersion)}.`);
  }

  const archive = manifest.archive;
  if (!archive || typeof archive !== 'object' || Array.isArray(archive)) {
    throw new ArchiveFormatError('manifest.json is missing archive metadata.');
  }
  const archiveRecord = /** @type {Record<string, unknown>} */ (archive);
  if (typeof archiveRecord.id !== 'string' || archiveRecord.id === '') {
    throw new ArchiveFormatError('manifest.json has no archive id.');
  }

  const source = manifest.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new ArchiveFormatError('manifest.json is missing source metadata.');
  }
  const sourceRecord = /** @type {Record<string, unknown>} */ (source);
  normalizeBacklogDomain(sourceRecord.domain);

  const project = sourceRecord.project;
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new ArchiveFormatError('manifest.json is missing project metadata.');
  }
  normalizeProjectKey((/** @type {Record<string, unknown>} */ (project)).key);

  return /** @type {typeof value} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} archiveId
 */
export function validateProgress(value, archiveId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArchiveFormatError('progress.json must contain an object.');
  }

  const progress = /** @type {Record<string, unknown>} */ (value);
  if (progress.schemaVersion !== PROGRESS_SCHEMA_VERSION) {
    throw new ArchiveFormatError(`Unsupported progress schema: ${String(progress.schemaVersion)}.`);
  }
  if (progress.archiveId !== archiveId) {
    throw new ArchiveFormatError('progress.json belongs to a different archive.');
  }
  if (typeof progress.phase !== 'string' || progress.phase === '') {
    throw new ArchiveFormatError('progress.json has no phase.');
  }

  return /** @type {typeof value} */ (value);
}
