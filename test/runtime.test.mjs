import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RuntimeCompatibilityError,
  verifyRuntimeFile,
  verifyRuntimeModule,
} from '../src/backlog/runtime.mjs';

const requiredOperation = {
  name: 'get_issue_participants',
  mutationClass: 'read',
  requiredPermission: 'READ',
};

test('validates the required participant operation as READ-only', () => {
  const result = verifyRuntimeModule(
    {
      product: { name: 'fixture-runtime', version: '1.0.0' },
      listOperations() { return [requiredOperation]; },
      runOperation() {},
      openDownload() {},
    },
    {
      expectedProduct: { name: 'fixture-runtime', version: '1.0.0' },
      requiredOperations: ['get_issue_participants'],
    },
  );

  assert.deepEqual(result, {
    product: { name: 'fixture-runtime', version: '1.0.0' },
    operationCount: 1,
    requiredOperationCount: 1,
  });
});

test('rejects a runtime that omits the participant operation', () => {
  assert.throws(
    () => verifyRuntimeModule(
      {
        product: { name: 'fixture-runtime', version: '1.0.0' },
        listOperations() { return []; },
        runOperation() {},
        openDownload() {},
      },
      {
        expectedProduct: { name: 'fixture-runtime', version: '1.0.0' },
        requiredOperations: ['get_issue_participants'],
      },
    ),
    /missing required operations: get_issue_participants/,
  );
});

test('checks a Runtime file before importing it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'miku-backlog-archive-runtime-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const runtimePath = join(directory, 'fixture-runtime.mjs');
  const source = `export const product = { name: 'fixture-runtime', version: '1.0.0' };\nexport function listOperations() { return [{ name: 'get_issue_participants', mutationClass: 'read', requiredPermission: 'READ' }]; }\nexport function runOperation() {}\nexport function openDownload() {}\n`;
  await writeFile(runtimePath, source);
  const digest = createHash('sha256').update(source).digest('hex');

  const result = await verifyRuntimeFile(runtimePath, {
    expectedSha256: digest,
    expectedProduct: { name: 'fixture-runtime', version: '1.0.0' },
    requiredOperations: ['get_issue_participants'],
  });
  assert.equal(result.sha256, digest);
  assert.equal(typeof result.runtime.runOperation, 'function');

  await assert.rejects(
    verifyRuntimeFile(runtimePath, {
      expectedSha256: '0'.repeat(64),
      expectedProduct: { name: 'fixture-runtime', version: '1.0.0' },
      requiredOperations: ['get_issue_participants'],
    }),
    RuntimeCompatibilityError,
  );
});
