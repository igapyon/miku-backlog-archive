import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PINNED_RUNTIME = Object.freeze({
  name: 'miku-backlog-api',
  version: '0.7.10',
  sha256: '7a8d9b78296009b204341ca49da2cd3a382f7b2bc656f607f670b69ef85601ec',
  url: 'https://github.com/igapyon/miku-backlog-api/releases/download/v0.7.10/miku-backlog-api-runtime-0.7.10.mjs',
});

export const REQUIRED_RUNTIME_OPERATIONS = Object.freeze([
  'get_project',
  'get_project_users',
  'get_project_statuses',
  'get_categories',
  'get_custom_fields',
  'get_issue_types',
  'get_version_milestone_list',
  'get_issues',
  'get_issue',
  'get_issue_comments',
  'get_issue_participants',
  'get_related_issues',
  'get_wiki_pages',
  'get_wiki',
  'get_shared_files',
  'download_issue_attachment',
  'download_wiki_attachment',
  'download_shared_file',
]);

export class RuntimeCompatibilityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeCompatibilityError';
  }
}

/**
 * @param {Uint8Array} contents
 */
export function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new RuntimeCompatibilityError(`Runtime does not export ${name}().`);
  }
}

/**
 * Check the module interface before any Backlog operation is allowed to run.
 *
 * @param {unknown} runtime
 * @param {{ expectedProduct?: { name: string, version: string }, requiredOperations?: readonly string[] }} [options]
 */
export function verifyRuntimeModule(runtime, options = {}) {
  if (!runtime || typeof runtime !== 'object') {
    throw new RuntimeCompatibilityError('Runtime module is not an object.');
  }

  const expectedProduct = options.expectedProduct ?? PINNED_RUNTIME;
  const requiredOperations = options.requiredOperations ?? REQUIRED_RUNTIME_OPERATIONS;
  const module = /** @type {{ product?: unknown, listOperations?: unknown, runOperation?: unknown, openDownload?: unknown }} */ (runtime);
  const product = module.product;
  if (!product || typeof product !== 'object') {
    throw new RuntimeCompatibilityError('Runtime does not export product metadata.');
  }
  const productRecord = /** @type {Record<string, unknown>} */ (product);
  if (productRecord.name !== expectedProduct.name || productRecord.version !== expectedProduct.version) {
    throw new RuntimeCompatibilityError(
      `Expected ${expectedProduct.name} ${expectedProduct.version}, but found ${String(productRecord.name)} ${String(productRecord.version)}.`,
    );
  }

  assertFunction(module.listOperations, 'listOperations');
  assertFunction(module.runOperation, 'runOperation');
  assertFunction(module.openDownload, 'openDownload');

  const operations = module.listOperations();
  if (!Array.isArray(operations)) {
    throw new RuntimeCompatibilityError('Runtime listOperations() did not return an array.');
  }

  const operationsByName = new Map(
    operations
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => [entry.name, entry]),
  );
  const missing = requiredOperations.filter((name) => !operationsByName.has(name));
  if (missing.length > 0) {
    throw new RuntimeCompatibilityError(`Runtime is missing required operations: ${missing.join(', ')}.`);
  }

  const nonRead = requiredOperations.filter((name) => {
    const entry = /** @type {Record<string, unknown>} */ (operationsByName.get(name));
    return entry.mutationClass !== 'read' || entry.requiredPermission !== 'READ';
  });
  if (nonRead.length > 0) {
    throw new RuntimeCompatibilityError(
      `Required operations must remain READ-only: ${nonRead.join(', ')}.`,
    );
  }

  return {
    product: {
      name: expectedProduct.name,
      version: expectedProduct.version,
    },
    operationCount: operations.length,
    requiredOperationCount: requiredOperations.length,
  };
}

/**
 * Verify the exact published runtime asset, then load its Node Core exports.
 * This function never calls Backlog and does not read credentials.
 *
 * @param {string} runtimePath
 * @param {{ expectedSha256?: string, expectedProduct?: { name: string, version: string }, requiredOperations?: readonly string[] }} [options]
 */
export async function verifyRuntimeFile(runtimePath, options = {}) {
  if (typeof runtimePath !== 'string' || runtimePath.trim() === '') {
    throw new RuntimeCompatibilityError('Runtime file path is required.');
  }

  const path = resolve(runtimePath);
  const contents = await readFile(path);
  const actualSha256 = sha256(contents);
  const expectedSha256 = options.expectedSha256 ?? PINNED_RUNTIME.sha256;
  if (actualSha256 !== expectedSha256) {
    throw new RuntimeCompatibilityError(
      `Runtime SHA-256 mismatch: expected ${expectedSha256}, found ${actualSha256}.`,
    );
  }

  let runtime;
  try {
    runtime = await import(`${pathToFileURL(path).href}?sha256=${actualSha256}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RuntimeCompatibilityError(`Could not load runtime module: ${message}`);
  }

  return {
    path,
    sha256: actualSha256,
    runtime,
    ...verifyRuntimeModule(runtime, options),
  };
}
