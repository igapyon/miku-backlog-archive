import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { verifyRuntimeFile, verifyRuntimeModule } from '../backlog/runtime.mjs';
import { writeJsonAtomically, writeWebStreamAtomically } from './atomic-write.mjs';
import { ArchiveFormatError, normalizeBacklogDomain } from './format.mjs';
import {
  normalizeAttachment,
  normalizeComment,
  normalizeIssue,
  normalizeIssueSummary,
  normalizePerson,
  normalizeProject,
  normalizeRelatedIssue,
  normalizeSharedFile,
  normalizeWiki,
  normalizeWikiSummary,
} from './normalize.mjs';
import { createRateLimitScheduler } from './rate-limit.mjs';
import { verifyArchive } from './session.mjs';

const ISSUE_PAGE_SIZE = 100;
const COMMENT_PAGE_SIZE = 100;
const ISSUE_INDEX_SCHEMA = 'miku-backlog-archive/issue-index/v1';
const ISSUE_SCHEMA = 'miku-backlog-archive/issue/v1';
const PROJECT_SCHEMA = 'miku-backlog-archive/project/v1';
const WIKI_INDEX_SCHEMA = 'miku-backlog-archive/wiki-index/v1';
const WIKI_SCHEMA = 'miku-backlog-archive/wiki/v1';
const SHARED_FILE_INDEX_SCHEMA = 'miku-backlog-archive/shared-file-index/v1';
const ASSET_INDEX_SCHEMA = 'miku-backlog-archive/asset-index/v1';
const SHARED_FILE_PAGE_SIZE = 1_000;
const MAX_REQUEST_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;
const requestControls = new WeakMap();
const ISSUE_DETAIL_CACHE_SCHEMA = 'miku-backlog-archive/issue-detail-cache/v1';
const REQUIRED_ISSUE_FIELDS = [
  'id', 'projectId', 'issueKey', 'summary', 'keyId', 'description', 'issueType',
  'status', 'priority', 'resolution', 'assignee', 'category', 'versions', 'milestone',
  'startDate', 'dueDate', 'estimatedHours', 'actualHours', 'parentIssueId',
  'createdUser', 'created', 'updatedUser', 'updated', 'customFields', 'attachments',
  'sharedFiles',
];

export class ArchiveCollectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArchiveCollectionError';
  }
}

class OperationFailure extends ArchiveCollectionError {
  constructor(operation, target, code, httpStatus) {
    super(`Backlog operation failed: ${operation}.`);
    this.operation = operation;
    this.target = target;
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

class RateLimitExhaustedError extends OperationFailure {
  constructor(failure) {
    super(failure.operation, failure.target, failure.code, failure.httpStatus);
    this.requestAttempts = failure.requestAttempts;
    this.stopCollection = true;
  }
}

function waitFor(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(attempt) {
  return RETRY_DELAY_MS * 2 ** (attempt - 1);
}

function requestControl(runtime) {
  return requestControls.get(runtime) ?? null;
}

async function retryRequest(runtime, operation, request) {
  const control = requestControl(runtime);
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof OperationFailure) || !isRetryable(error.httpStatus, error.code)) {
        throw error;
      }
      error.requestAttempts = attempt;
      if (error.httpStatus === 429 && attempt === MAX_REQUEST_ATTEMPTS) {
        throw new RateLimitExhaustedError(error);
      }
      if (attempt === MAX_REQUEST_ATTEMPTS) {
        throw error;
      }
      if (control) {
        await control.scheduler.waitBefore(
          operation,
          error.httpStatus === 429 ? 'rate-limit' : 'retry',
          error.httpStatus === 429 ? 0 : retryDelay(attempt),
        );
      } else {
        await waitFor(error.httpStatus === 429 ? 60_000 : retryDelay(attempt));
      }
    }
  }
  throw new ArchiveCollectionError('Request retry loop ended unexpectedly.');
}

function nowIso(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new ArchiveCollectionError('Collection clock returned an invalid Date.');
  }
  return value.toISOString();
}

function task(progress, key) {
  progress.tasks ??= {};
  return progress.tasks[key];
}

function taskIsComplete(progress, key) {
  return task(progress, key)?.state === 'completed';
}

function isRetryable(httpStatus, code) {
  return httpStatus === 408 || httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599)
    || code === 'UPSTREAM_ERROR';
}

function updateTimestamp(progress, now) {
  progress.updatedAt = nowIso(now);
}

async function saveProgress(paths, progress) {
  await writeJsonAtomically(paths.progress, progress);
}

async function beginTask(paths, progress, key, now, details = {}) {
  const previous = task(progress, key);
  progress.tasks[key] = {
    ...previous,
    ...details,
    state: 'running',
    attempts: (previous?.attempts ?? 0) + 1,
    startedAt: previous?.startedAt ?? nowIso(now),
    updatedAt: nowIso(now),
  };
  updateTimestamp(progress, now);
  await saveProgress(paths, progress);
}

async function completeTask(paths, progress, key, now, details = {}) {
  const previous = task(progress, key) ?? {};
  progress.tasks[key] = {
    ...previous,
    ...details,
    state: 'completed',
    completedAt: nowIso(now),
    updatedAt: nowIso(now),
  };
  updateTimestamp(progress, now);
  await saveProgress(paths, progress);
}

async function failTask(paths, progress, key, error, now) {
  const previous = task(progress, key) ?? {};
  const failure = {
    task: key,
    operation: error instanceof OperationFailure ? error.operation : 'local',
    target: error instanceof OperationFailure ? error.target : {},
    code: error instanceof OperationFailure ? error.code : 'LOCAL_ERROR',
    ...(error instanceof OperationFailure && error.httpStatus !== undefined
      ? { httpStatus: error.httpStatus }
      : {}),
    ...(error instanceof OperationFailure && Number.isSafeInteger(error.requestAttempts)
      ? { requestAttempts: error.requestAttempts }
      : {}),
    retryable: error instanceof OperationFailure
      ? isRetryable(error.httpStatus, error.code)
      : false,
    at: nowIso(now),
  };
  progress.tasks[key] = {
    ...previous,
    state: 'failed',
    updatedAt: failure.at,
    failure,
  };
  progress.failures ??= [];
  progress.failures.push(failure);
  updateTimestamp(progress, now);
  await saveProgress(paths, progress);
}

function assertRuntimeEnvironment(env, manifest) {
  if (typeof env.BACKLOG_API_KEY !== 'string' || env.BACKLOG_API_KEY.trim() === '') {
    throw new ArchiveCollectionError('BACKLOG_API_KEY must be provided at runtime.');
  }
  const domain = normalizeBacklogDomain(env.BACKLOG_DOMAIN);
  if (domain !== manifest.source.domain) {
    throw new ArchiveCollectionError('BACKLOG_DOMAIN does not match the archive manifest.');
  }
}

function safeTarget(input) {
  const target = {};
  for (const key of [
    'projectId', 'projectKey', 'issueId', 'issueKey', 'wikiId', 'attachmentId',
    'sharedFileId', 'offset', 'minId',
  ]) {
    const value = input[key];
    if (typeof value === 'string' || typeof value === 'number') {
      target[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
      target[key] = value;
    }
  }
  return target;
}

async function recordAccessEvents(runtime, operation, accessEvents) {
  const control = requestControl(runtime);
  if (!control) {
    return;
  }
  for (const event of accessEvents) {
    control.scheduler.observe(operation, event);
  }
  control.progress.rateLimit = control.scheduler.snapshot();
  if (accessEvents.some((event) => event?.phase === 'failure' && event.httpStatus === 429)) {
    updateTimestamp(control.progress, control.now);
    await saveProgress(control.paths, control.progress);
  }
}

async function callOnce(runtime, operation, input, env) {
  const control = requestControl(runtime);
  if (control) {
    await control.scheduler.waitBefore(operation);
  }
  const accessEvents = [];
  let response;
  try {
    response = await runtime.runOperation(operation, input, {
      env,
      allowedPermissions: ['READ'],
      onAccess(event) {
        accessEvents.push(event);
      },
    });
  } catch {
    await recordAccessEvents(runtime, operation, accessEvents);
    const accessFailure = accessEvents.find((event) => event?.phase === 'failure');
    throw new OperationFailure(
      operation,
      safeTarget(input),
      'RUNTIME_ERROR',
      Number.isFinite(accessFailure?.httpStatus) ? accessFailure.httpStatus : undefined,
    );
  }

  await recordAccessEvents(runtime, operation, accessEvents);

  if (!response || response.success !== true) {
    const diagnostic = response?.diagnostics?.[0];
    const accessFailure = accessEvents.find((event) => event?.phase === 'failure');
    throw new OperationFailure(
      operation,
      safeTarget(input),
      typeof diagnostic?.code === 'string' ? diagnostic.code : 'UPSTREAM_ERROR',
      Number.isFinite(accessFailure?.httpStatus) ? accessFailure.httpStatus : undefined,
    );
  }
  return response.result;
}

async function call(runtime, operation, input, env) {
  return retryRequest(runtime, operation, () => callOnce(runtime, operation, input, env));
}

async function openDownloadOnce(runtime, operation, input, env) {
  const control = requestControl(runtime);
  if (control) {
    await control.scheduler.waitBefore(operation);
  }
  const accessEvents = [];
  let response;
  try {
    response = await runtime.openDownload(operation, input, {
      env,
      allowedPermissions: ['READ'],
      onAccess(event) {
        accessEvents.push(event);
      },
    });
  } catch {
    const accessFailure = accessEvents.find((event) => event?.phase === 'failure');
    await recordAccessEvents(runtime, operation, accessEvents);
    throw new OperationFailure(
      operation,
      safeTarget(input),
      'RUNTIME_ERROR',
      Number.isFinite(accessFailure?.httpStatus) ? accessFailure.httpStatus : undefined,
    );
  }

  await recordAccessEvents(runtime, operation, accessEvents);

  if (!response || response.success !== true) {
    const diagnostic = response?.diagnostics?.[0];
    const accessFailure = accessEvents.find((event) => event?.phase === 'failure');
    throw new OperationFailure(
      operation,
      safeTarget(input),
      typeof diagnostic?.code === 'string' ? diagnostic.code : 'UPSTREAM_ERROR',
      Number.isFinite(accessFailure?.httpStatus) ? accessFailure.httpStatus : undefined,
    );
  }

  const transfer = response.transfer;
  if (!transfer || !transfer.body || typeof transfer.body.getReader !== 'function'
    || !transfer.completed || typeof transfer.completed.then !== 'function') {
    throw new OperationFailure(operation, safeTarget(input), 'UPSTREAM_ERROR');
  }
  return transfer;
}

async function openDownload(runtime, operation, input, env) {
  return retryRequest(runtime, operation, () => openDownloadOnce(runtime, operation, input, env));
}

function requireArray(value, operation) {
  if (!Array.isArray(value)) {
    throw new ArchiveCollectionError(`${operation} returned a non-array result.`);
  }
  return value;
}

async function readJson(path, name) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ArchiveCollectionError(`Required saved ${name} is missing.`);
    }
    throw new ArchiveCollectionError(`Could not read saved ${name}.`);
  }
}

async function isRegularFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function saveManifest(paths, manifest) {
  await writeJsonAtomically(paths.manifest, manifest);
}

async function resolveProject({ paths, manifest, progress, runtime, env, now }) {
  const key = 'project';
  if (taskIsComplete(progress, key) && Number.isSafeInteger(manifest.source.project.id)) {
    return manifest.source.project.id;
  }

  await beginTask(paths, progress, key, now);
  try {
    const project = normalizeProject(await call(runtime, 'get_project', {
      projectKey: manifest.source.project.key,
    }, env));
    if (project.projectKey !== manifest.source.project.key) {
      throw new ArchiveCollectionError('Resolved project key does not match the archive manifest.');
    }
    await writeJsonAtomically(join(paths.data, 'project.json'), {
      schemaVersion: PROJECT_SCHEMA,
      savedAt: nowIso(now),
      project,
    });
    manifest.source.project.id = project.id;
    manifest.source.project.name = project.name;
    await saveManifest(paths, manifest);
    await completeTask(paths, progress, key, now, { projectId: project.id });
    return project.id;
  } catch (error) {
    await failTask(paths, progress, key, error, now);
    throw error;
  }
}

async function loadIssueIndex(path) {
  const value = await readJson(path, 'issue index');
  if (!value || value.schemaVersion !== ISSUE_INDEX_SCHEMA || !Array.isArray(value.issues)) {
    throw new ArchiveCollectionError('Saved issue index has an unsupported format.');
  }
  return value.issues;
}

function issueHasCompleteListDetail(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !REQUIRED_ISSUE_FIELDS.every((key) => Object.hasOwn(value, key))) {
    return false;
  }
  for (const key of ['category', 'versions', 'milestone', 'customFields', 'attachments', 'sharedFiles']) {
    if (!Array.isArray(value[key])) {
      return false;
    }
  }
  if (!value.attachments.every((attachment) => attachment && typeof attachment === 'object'
    && ['id', 'name', 'size', 'createdUser', 'created']
      .every((key) => Object.hasOwn(attachment, key)))) {
    return false;
  }
  const sharedFileFields = [
    'id', 'projectId', 'type', 'dir', 'name', 'size', 'createdUser', 'created',
    'updatedUser', 'updated',
  ];
  return value.sharedFiles.every((file) => file && typeof file === 'object'
    && sharedFileFields.every((key) => Object.hasOwn(file, key)));
}

function issueDetailCachePath(paths, issueId) {
  return join(paths.state, 'issue-details', `${issueId}.json`);
}

async function saveIssueDetailCache({ paths, archiveId, projectId, issue, source, reusable, now }) {
  await writeJsonAtomically(issueDetailCachePath(paths, issue.id), {
    schemaVersion: ISSUE_DETAIL_CACHE_SCHEMA,
    archiveId,
    projectId,
    savedAt: nowIso(now),
    source,
    reusable,
    issue,
  });
}

async function loadIssueDetailCache({ paths, archiveId, projectId, issueId }) {
  let value;
  try {
    value = JSON.parse(await readFile(issueDetailCachePath(paths, issueId), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw new ArchiveCollectionError(`Could not read issue detail cache ${issueId}.`);
  }
  if (!value || value.schemaVersion !== ISSUE_DETAIL_CACHE_SCHEMA
    || value.archiveId !== archiveId || value.projectId !== projectId
    || !['issue-list', 'issue-detail'].includes(value.source)
    || typeof value.reusable !== 'boolean' || !value.issue || typeof value.issue !== 'object') {
    throw new ArchiveCollectionError(`Issue detail cache ${issueId} has an unsupported format.`);
  }
  const issue = normalizeIssue(value.issue);
  if (issue.id !== issueId || issue.projectId !== projectId) {
    throw new ArchiveCollectionError(`Issue detail cache ${issueId} has a mismatched identity.`);
  }
  return { issue, reusable: value.reusable };
}

async function collectIssueIndex({ paths, progress, runtime, env, projectId, archiveId, now }) {
  const key = 'issue-list';
  const indexPath = join(paths.data, 'issues', 'index.json');
  if (taskIsComplete(progress, key)) {
    return loadIssueIndex(indexPath);
  }

  await mkdir(join(paths.data, 'issues'), { recursive: true });
  await mkdir(join(paths.state, 'issue-details'), { recursive: true });
  const existing = new Map();
  try {
    for (const issue of await loadIssueIndex(indexPath)) {
      existing.set(issue.id, issue);
    }
  } catch (error) {
    if (!(error instanceof ArchiveCollectionError) || !error.message.includes('missing')) {
      throw error;
    }
  }

  let offset = task(progress, key)?.nextOffset ?? 0;
  await beginTask(paths, progress, key, now, { nextOffset: offset });
  try {
    while (true) {
      const page = requireArray(await call(runtime, 'get_issues', {
        projectId: [projectId],
        offset,
        count: ISSUE_PAGE_SIZE,
      }, env), 'get_issues');
      for (const value of page) {
        const summary = normalizeIssueSummary(value);
        if (summary.projectId !== projectId) {
          throw new ArchiveCollectionError('Issue list contains a different project.');
        }
        const issue = normalizeIssue(value);
        const reusable = issueHasCompleteListDetail(value);
        await saveIssueDetailCache({
          paths,
          archiveId,
          projectId,
          issue,
          source: 'issue-list',
          reusable,
          now,
        });
        existing.set(summary.id, summary);
      }
      offset += page.length;
      const issues = [...existing.values()].sort((left, right) => left.id - right.id);
      await writeJsonAtomically(indexPath, {
        schemaVersion: ISSUE_INDEX_SCHEMA,
        projectId,
        savedAt: nowIso(now),
        issues,
      });
      progress.tasks[key] = {
        ...task(progress, key),
        nextOffset: offset,
        updatedAt: nowIso(now),
      };
      updateTimestamp(progress, now);
      await saveProgress(paths, progress);
      if (page.length < ISSUE_PAGE_SIZE) {
        await completeTask(paths, progress, key, now, { nextOffset: offset, issueCount: issues.length });
        return issues;
      }
    }
  } catch (error) {
    await failTask(paths, progress, key, error, now);
    throw error;
  }
}

async function collectComments(runtime, issueId, env) {
  const comments = new Map();
  let minId;
  while (true) {
    const page = requireArray(await call(runtime, 'get_issue_comments', {
      issueId,
      ...(minId === undefined ? {} : { minId }),
      count: COMMENT_PAGE_SIZE,
      order: 'asc',
    }, env), 'get_issue_comments');
    if (page.length === 0) {
      return [...comments.values()];
    }
    let greatestId = minId ?? 0;
    for (const value of page) {
      const comment = normalizeComment(value);
      if (comment.issueId !== issueId) {
        throw new ArchiveCollectionError('Comment belongs to a different issue.');
      }
      comments.set(comment.id, comment);
      greatestId = Math.max(greatestId, comment.id);
    }
    if (page.length < COMMENT_PAGE_SIZE) {
      return [...comments.values()];
    }
    if (greatestId <= (minId ?? 0)) {
      throw new ArchiveCollectionError('Comment pagination did not advance.');
    }
    minId = greatestId + 1;
  }
}

async function collectIssue({ paths, progress, runtime, env, archiveId, issueSummary, now }) {
  const key = `issue:${issueSummary.id}`;
  if (taskIsComplete(progress, key)) {
    return false;
  }
  await beginTask(paths, progress, key, now, {
    issueId: issueSummary.id,
    issueKey: issueSummary.issueKey,
  });
  try {
    const cached = await loadIssueDetailCache({
      paths,
      archiveId,
      projectId: issueSummary.projectId,
      issueId: issueSummary.id,
    });
    let issue;
    if (cached?.reusable) {
      issue = cached.issue;
    } else {
      issue = normalizeIssue(await call(runtime, 'get_issue', { issueId: issueSummary.id }, env));
      if (issue.id !== issueSummary.id || issue.projectId !== issueSummary.projectId) {
        throw new ArchiveCollectionError('Issue detail does not match the saved issue index.');
      }
      await saveIssueDetailCache({
        paths,
        archiveId,
        projectId: issueSummary.projectId,
        issue,
        source: 'issue-detail',
        reusable: true,
        now,
      });
    }
    if (issue.id !== issueSummary.id || issue.projectId !== issueSummary.projectId) {
      throw new ArchiveCollectionError('Issue detail does not match the saved issue index.');
    }
    const comments = await collectComments(runtime, issue.id, env);
    const participants = await call(runtime, 'get_issue_participants', { issueId: issue.id }, env);
    const relatedIssues = await call(runtime, 'get_related_issues', { issueId: issue.id }, env);
    const participantList = requireArray(participants, 'get_issue_participants')
      .map(normalizePerson)
      .filter(Boolean);
    const relatedIssueList = requireArray(relatedIssues, 'get_related_issues')
      .map(normalizeRelatedIssue);
    await writeJsonAtomically(join(paths.data, 'issues', `${issue.id}.json`), {
      schemaVersion: ISSUE_SCHEMA,
      savedAt: nowIso(now),
      issue,
      comments,
      participants: participantList,
      relatedIssues: relatedIssueList,
    });
    await completeTask(paths, progress, key, now, {
      issueId: issue.id,
      issueKey: issue.issueKey,
    });
    return true;
  } catch (error) {
    await failTask(paths, progress, key, error, now);
    if (error?.stopCollection === true) {
      throw error;
    }
    return false;
  }
}

async function loadIssue(path) {
  const value = await readJson(path, 'issue');
  if (!value || value.schemaVersion !== ISSUE_SCHEMA || !value.issue
    || !Array.isArray(value.issue.attachments)) {
    throw new ArchiveCollectionError('Saved issue has an unsupported format.');
  }
  return value;
}

function safeAssetFilename(id, name) {
  let candidate = typeof name === 'string' ? name.normalize('NFC').trim() : '';
  candidate = candidate
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, '_')
    .replace(/\.{2,}/gu, '_')
    .replace(/\s+/gu, ' ')
    .replace(/[. ]+$/u, '');
  if (candidate === '' || candidate === '.' || candidate === '..'
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(candidate)) {
    candidate = 'unnamed';
  }
  return `${id}-${candidate.slice(0, 120)}`;
}

function attachmentAssetPath(kind, parentId, attachment) {
  return `assets/${kind}/${parentId}/${safeAssetFilename(attachment.id, attachment.name)}`;
}

function sharedAssetPath(file) {
  return `assets/shared/${safeAssetFilename(file.id, file.name)}`;
}

function assetIndexPath(paths) {
  return join(paths.data, 'assets', 'index.json');
}

function createAssetIndex(projectId) {
  return {
    schemaVersion: ASSET_INDEX_SCHEMA,
    projectId,
    savedAt: null,
    issueAttachments: [],
    wikiAttachments: [],
    sharedFiles: [],
  };
}

async function loadAssetIndex(paths, projectId) {
  let value;
  try {
    value = await readJson(assetIndexPath(paths), 'asset index');
  } catch (error) {
    if (error instanceof ArchiveCollectionError && error.message.includes('missing')) {
      return createAssetIndex(projectId);
    }
    throw error;
  }
  if (!value || value.schemaVersion !== ASSET_INDEX_SCHEMA || value.projectId !== projectId
    || !Array.isArray(value.issueAttachments) || !Array.isArray(value.wikiAttachments)
    || !Array.isArray(value.sharedFiles)) {
    throw new ArchiveCollectionError('Saved asset index has an unsupported format.');
  }
  return value;
}

function replaceAssetEntry(entries, predicate, value) {
  const index = entries.findIndex(predicate);
  if (index === -1) {
    entries.push(value);
  } else {
    entries[index] = value;
  }
}

async function recordAsset({ paths, assetIndex, kind, parentId, file, localPath, now }) {
  if (kind === 'issue') {
    replaceAssetEntry(
      assetIndex.issueAttachments,
      (entry) => entry?.issueId === parentId && entry?.attachmentId === file.id,
      {
        issueId: parentId,
        attachmentId: file.id,
        name: file.name,
        size: file.size,
        localPath,
      },
    );
  } else if (kind === 'wiki') {
    replaceAssetEntry(
      assetIndex.wikiAttachments,
      (entry) => entry?.wikiId === parentId && entry?.attachmentId === file.id,
      {
        wikiId: parentId,
        attachmentId: file.id,
        name: file.name,
        size: file.size,
        localPath,
      },
    );
  } else {
    replaceAssetEntry(
      assetIndex.sharedFiles,
      (entry) => entry?.sharedFileId === file.id,
      {
        sharedFileId: file.id,
        name: file.name,
        size: file.size,
        localPath,
      },
    );
  }
  assetIndex.savedAt = nowIso(now);
  await writeJsonAtomically(assetIndexPath(paths), assetIndex);
}

async function collectAsset({
  paths,
  progress,
  runtime,
  env,
  now,
  assetIndex,
  taskKey,
  operation,
  input,
  taskDetails,
  kind,
  parentId,
  file,
  localPath,
}) {
  const destination = join(paths.root, ...localPath.split('/'));
  if (taskIsComplete(progress, taskKey) && await isRegularFile(destination)) {
    await recordAsset({ paths, assetIndex, kind, parentId, file, localPath, now });
    return false;
  }

  await beginTask(paths, progress, taskKey, now, { ...taskDetails, localPath });
  try {
    const transfer = await openDownload(runtime, operation, input, env);
    await Promise.all([
      writeWebStreamAtomically(destination, transfer.body),
      transfer.completed,
    ]);
    await recordAsset({ paths, assetIndex, kind, parentId, file, localPath, now });
    await completeTask(paths, progress, taskKey, now, { ...taskDetails, localPath });
    return true;
  } catch (error) {
    await failTask(paths, progress, taskKey, error, now);
    if (error?.stopCollection === true) {
      throw error;
    }
    return false;
  }
}

async function collectIssueAttachments({ paths, progress, runtime, env, now, assetIndex, issue }) {
  let collectedAssetCount = 0;
  for (const attachment of issue.attachments) {
    if (await collectAsset({
      paths,
      progress,
      runtime,
      env,
      now,
      assetIndex,
      taskKey: `issue-attachment:${issue.id}:${attachment.id}`,
      operation: 'download_issue_attachment',
      input: { issueId: issue.id, attachmentId: attachment.id },
      taskDetails: { issueId: issue.id, attachmentId: attachment.id },
      kind: 'issue',
      parentId: issue.id,
      file: attachment,
      localPath: attachmentAssetPath('issues', issue.id, attachment),
    })) {
      collectedAssetCount += 1;
    }
  }
  return collectedAssetCount;
}

async function loadWikiIndex(path) {
  const value = await readJson(path, 'wiki index');
  if (!value || value.schemaVersion !== WIKI_INDEX_SCHEMA || !Array.isArray(value.wikis)) {
    throw new ArchiveCollectionError('Saved wiki index has an unsupported format.');
  }
  return value.wikis;
}

async function collectWikiIndex({ paths, progress, runtime, env, projectId, now }) {
  const key = 'wiki-list';
  const indexPath = join(paths.data, 'wikis', 'index.json');
  if (taskIsComplete(progress, key)) {
    return loadWikiIndex(indexPath);
  }

  await beginTask(paths, progress, key, now);
  try {
    const wikisById = new Map();
    for (const value of requireArray(await call(runtime, 'get_wiki_pages', { projectId }, env), 'get_wiki_pages')) {
      const summary = normalizeWikiSummary(value);
      if (summary.projectId !== projectId) {
        throw new ArchiveCollectionError('Wiki list contains a different project.');
      }
      wikisById.set(summary.id, summary);
    }
    const wikis = [...wikisById.values()];
    await writeJsonAtomically(indexPath, {
      schemaVersion: WIKI_INDEX_SCHEMA,
      projectId,
      savedAt: nowIso(now),
      wikis,
    });
    await completeTask(paths, progress, key, now, { wikiCount: wikis.length });
    return wikis;
  } catch (error) {
    await failTask(paths, progress, key, error, now);
    throw error;
  }
}

async function loadWiki(path) {
  const value = await readJson(path, 'wiki');
  if (!value || value.schemaVersion !== WIKI_SCHEMA || !value.wiki
    || !Array.isArray(value.wiki.attachments)) {
    throw new ArchiveCollectionError('Saved wiki has an unsupported format.');
  }
  return value;
}

async function collectWiki({ paths, progress, runtime, env, wikiSummary, now }) {
  const key = `wiki:${wikiSummary.id}`;
  if (taskIsComplete(progress, key)) {
    return false;
  }
  await beginTask(paths, progress, key, now, { wikiId: wikiSummary.id });
  try {
    const wiki = normalizeWiki(await call(runtime, 'get_wiki', { wikiId: wikiSummary.id }, env));
    if (wiki.id !== wikiSummary.id || wiki.projectId !== wikiSummary.projectId) {
      throw new ArchiveCollectionError('Wiki detail does not match the saved wiki index.');
    }
    await writeJsonAtomically(join(paths.data, 'wikis', `${wiki.id}.json`), {
      schemaVersion: WIKI_SCHEMA,
      savedAt: nowIso(now),
      wiki,
    });
    await completeTask(paths, progress, key, now, { wikiId: wiki.id });
    return true;
  } catch (error) {
    await failTask(paths, progress, key, error, now);
    if (error?.stopCollection === true) {
      throw error;
    }
    return false;
  }
}

function unresolvedWikiAttachmentReferences(wiki) {
  if (typeof wiki.content !== 'string') {
    return [];
  }
  const references = new Set();
  const pattern = /#(image|thumbnail)\(([^()\r\n]+)\)|#attach\(([^():\r\n]+)(?::(\d+))?\)|!\[([^\]\r\n]*)\]\[([^\]\r\n]+)\]/gu;
  let inCodeFence = false;
  for (const line of wiki.content.replace(/\r\n?/gu, '\n').split('\n')) {
    if (/^```/u.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }
    for (const match of line.matchAll(pattern)) {
      const reference = match[1] !== undefined
        ? match[2]
        : match[3] !== undefined
          ? match[4] ?? match[3]
          : match[6];
      if (typeof reference === 'string' && reference !== '') {
        references.add(reference);
      }
    }
  }
  return [...references].filter((reference) => !wiki.attachments.some((attachment) => (
    /^\d+$/u.test(reference)
      ? attachment.id === Number(reference)
      : attachment.name === reference
  )));
}

async function collectWikiAttachmentList({ paths, progress, runtime, env, now, wikiData }) {
  const wiki = wikiData.wiki;
  const key = `wiki-attachment-list:${wiki.id}`;
  if (taskIsComplete(progress, key)) {
    return wikiData;
  }

  const missingReferences = unresolvedWikiAttachmentReferences(wiki);
  await beginTask(paths, progress, key, now, { wikiId: wiki.id });
  try {
    if (missingReferences.length === 0) {
      await completeTask(paths, progress, key, now, {
        wikiId: wiki.id,
        listRequested: false,
        unresolvedReferenceCount: 0,
      });
      return wikiData;
    }

    const listedAttachments = requireArray(
      await call(runtime, 'get_wiki_attachments', { wikiId: wiki.id }, env),
      'get_wiki_attachments',
    );
    const attachmentsById = new Map(wiki.attachments.map((attachment) => [attachment.id, attachment]));
    let addedAttachmentCount = 0;
    for (const value of listedAttachments) {
      const attachment = normalizeAttachment(value);
      const current = attachmentsById.get(attachment.id);
      if (!current) {
        attachmentsById.set(attachment.id, attachment);
        addedAttachmentCount += 1;
        continue;
      }
      attachmentsById.set(attachment.id, {
        id: attachment.id,
        name: current.name ?? attachment.name,
        size: current.size ?? attachment.size,
        createdUser: current.createdUser ?? attachment.createdUser,
        created: current.created ?? attachment.created,
      });
    }

    const updatedWikiData = {
      ...wikiData,
      wiki: { ...wiki, attachments: [...attachmentsById.values()] },
    };
    await writeJsonAtomically(join(paths.data, 'wikis', `${wiki.id}.json`), updatedWikiData);
    await completeTask(paths, progress, key, now, {
      wikiId: wiki.id,
      listRequested: true,
      addedAttachmentCount,
      unresolvedReferenceCount: unresolvedWikiAttachmentReferences(updatedWikiData.wiki).length,
    });
    return updatedWikiData;
  } catch (error) {
    await failTask(paths, progress, key, error, now);
    if (error?.stopCollection === true) {
      throw error;
    }
    return wikiData;
  }
}

async function collectWikiAttachments({ paths, progress, runtime, env, now, assetIndex, wiki }) {
  let collectedAssetCount = 0;
  for (const attachment of wiki.attachments) {
    if (await collectAsset({
      paths,
      progress,
      runtime,
      env,
      now,
      assetIndex,
      taskKey: `wiki-attachment:${wiki.id}:${attachment.id}`,
      operation: 'download_wiki_attachment',
      input: { wikiId: wiki.id, attachmentId: attachment.id },
      taskDetails: { wikiId: wiki.id, attachmentId: attachment.id },
      kind: 'wiki',
      parentId: wiki.id,
      file: attachment,
      localPath: attachmentAssetPath('wikis', wiki.id, attachment),
    })) {
      collectedAssetCount += 1;
    }
  }
  return collectedAssetCount;
}

function normalizeSharedDirectoryPath(path) {
  if (path === '/') {
    return path;
  }
  if (typeof path !== 'string' || !path.startsWith('/') || !path.endsWith('/')
    || path.includes('\\') || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new ArchiveCollectionError('Shared-file directory path is invalid.');
  }
  const segments = path.slice(1, -1).split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ArchiveCollectionError('Shared-file directory path is invalid.');
  }
  return path;
}

function sharedFilesApiPath(path) {
  // Backlog's endpoint appends :path after `/metadata/`; keep nested paths
  // relative so a leading slash does not create an illegal double slash.
  return path === '/' ? './' : path.slice(1);
}

function joinSharedPath(parentPath, name, directory) {
  if (typeof name !== 'string' || name === '' || /[\\/\u0000-\u001f\u007f]/u.test(name)
    || name === '.' || name === '..') {
    throw new ArchiveCollectionError('Shared-file entry name is invalid.');
  }
  return `${normalizeSharedDirectoryPath(parentPath)}${name}${directory ? '/' : ''}`;
}

function sharedDirectoryTaskKey(path) {
  return `shared-directory:${encodeURIComponent(path)}`;
}

function sharedFileIndexPath(paths) {
  return join(paths.data, 'files', 'index.json');
}

function createSharedFileIndex(projectId) {
  return {
    schemaVersion: SHARED_FILE_INDEX_SCHEMA,
    projectId,
    savedAt: null,
    directories: [{ path: '/', parentPath: null, id: null, name: null }],
    files: [],
  };
}

async function loadSharedFileIndex(paths, projectId) {
  let value;
  try {
    value = await readJson(sharedFileIndexPath(paths), 'shared-file index');
  } catch (error) {
    if (error instanceof ArchiveCollectionError && error.message.includes('missing')) {
      return createSharedFileIndex(projectId);
    }
    throw error;
  }
  if (!value || value.schemaVersion !== SHARED_FILE_INDEX_SCHEMA || value.projectId !== projectId
    || !Array.isArray(value.directories) || !Array.isArray(value.files)) {
    throw new ArchiveCollectionError('Saved shared-file index has an unsupported format.');
  }
  return value;
}

function replaceSharedEntry(entries, predicate, value) {
  const index = entries.findIndex(predicate);
  if (index === -1) {
    entries.push(value);
  } else {
    entries[index] = value;
  }
}

async function saveSharedFileIndex(paths, index, now) {
  index.savedAt = nowIso(now);
  await writeJsonAtomically(sharedFileIndexPath(paths), index);
}

async function collectSharedDirectory({ paths, progress, runtime, env, projectId, now, index, path }) {
  const key = sharedDirectoryTaskKey(path);
  if (taskIsComplete(progress, key)) {
    return;
  }

  let offset = task(progress, key)?.nextOffset ?? 0;
  await beginTask(paths, progress, key, now, { projectId, nextOffset: offset });
  try {
    while (true) {
      const page = requireArray(await call(runtime, 'get_shared_files', {
        projectId,
        path: sharedFilesApiPath(path),
        offset,
        count: SHARED_FILE_PAGE_SIZE,
        order: 'asc',
      }, env), 'get_shared_files');
      for (const value of page) {
        const entry = normalizeSharedFile(value);
        if (entry.projectId !== null && entry.projectId !== projectId) {
          throw new ArchiveCollectionError('Shared-file entry belongs to a different project.');
        }
        if (entry.type === 'dir') {
          const childPath = joinSharedPath(path, entry.name, true);
          replaceSharedEntry(
            index.directories,
            (directory) => directory?.path === childPath,
            { ...entry, parentPath: path, path: childPath },
          );
        } else if (entry.type === 'file') {
          const filePath = joinSharedPath(path, entry.name, false);
          replaceSharedEntry(
            index.files,
            (file) => file?.id === entry.id,
            { ...entry, parentPath: path, path: filePath },
          );
        } else {
          throw new ArchiveCollectionError('Shared-file entry has an unsupported type.');
        }
      }
      offset += page.length;
      await saveSharedFileIndex(paths, index, now);
      progress.tasks[key] = {
        ...task(progress, key),
        nextOffset: offset,
        updatedAt: nowIso(now),
      };
      updateTimestamp(progress, now);
      await saveProgress(paths, progress);
      if (page.length < SHARED_FILE_PAGE_SIZE) {
        await completeTask(paths, progress, key, now, { projectId, nextOffset: offset });
        return;
      }
    }
  } catch (error) {
    await failTask(paths, progress, key, error, now);
    if (error?.stopCollection === true) {
      throw error;
    }
  }
}

async function collectSharedFiles({ paths, progress, runtime, env, projectId, now, assetIndex }) {
  const index = await loadSharedFileIndex(paths, projectId);
  const queuedPaths = ['/'];
  const seenPaths = new Set();
  while (queuedPaths.length > 0) {
    const path = normalizeSharedDirectoryPath(queuedPaths.shift());
    if (seenPaths.has(path)) {
      continue;
    }
    seenPaths.add(path);
    await collectSharedDirectory({ paths, progress, runtime, env, projectId, now, index, path });
    for (const directory of index.directories) {
      if (typeof directory?.path === 'string' && !seenPaths.has(directory.path)) {
        queuedPaths.push(directory.path);
      }
    }
  }

  let collectedAssetCount = 0;
  for (const file of index.files) {
    if (await collectAsset({
      paths,
      progress,
      runtime,
      env,
      now,
      assetIndex,
      taskKey: `shared-file:${file.id}`,
      operation: 'download_shared_file',
      input: { projectId, sharedFileId: file.id },
      taskDetails: { projectId, sharedFileId: file.id },
      kind: 'shared',
      parentId: null,
      file,
      localPath: sharedAssetPath(file),
    })) {
      collectedAssetCount += 1;
    }
  }
  return { sharedFileCount: index.files.length, collectedAssetCount };
}

function hasFailedTasks(progress) {
  return Object.values(progress.tasks ?? {}).some((value) => value?.state === 'failed');
}

/**
 * Collect one archive's project and issue data. The caller supplies either a
 * verified Runtime file or a Runtime object for tests; no direct Backlog HTTP
 * client is used here.
 *
 * @param {{ output: string, runtimePath?: string, runtime?: object, env?: Record<string, string | undefined>, now?: () => Date, onProgress?: (event: Record<string, unknown>) => unknown }} input
 */
export async function collectArchive(input) {
  const now = input.now ?? (() => new Date());
  const env = input.env ?? process.env;
  const { paths, manifest, progress } = await verifyArchive(input.output);
  assertRuntimeEnvironment(env, manifest);
  const runtimeInfo = input.runtime
    ? { runtime: input.runtime, ...verifyRuntimeModule(input.runtime) }
    : await verifyRuntimeFile(input.runtimePath);
  const runtime = runtimeInfo.runtime;
  if (input.wait !== undefined && typeof input.wait !== 'function') {
    throw new ArchiveCollectionError('Collection wait hook must be a function.');
  }
  if (input.onProgress !== undefined && typeof input.onProgress !== 'function') {
    throw new ArchiveCollectionError('Collection progress hook must be a function.');
  }
  let scheduler;
  scheduler = createRateLimitScheduler({
    now,
    wait: input.wait ?? waitFor,
    async onWait(event) {
      progress.rateLimit = scheduler.snapshot();
      if (event.phase === 'waiting') {
        progress.waiting = {
          category: event.category,
          reason: event.reason,
          startedAt: event.startedAt,
          retryAt: event.retryAt,
          delayMs: event.delayMs,
        };
        if (event.reason === 'rate-limit' || event.delayMs >= 5_000) {
          updateTimestamp(progress, now);
          await saveProgress(paths, progress);
        }
        if (event.reason === 'rate-limit' || event.delayMs >= 5_000) {
          await input.onProgress?.(event);
        }
        return;
      }
      const hadPersistedWait = progress.waiting !== undefined;
      delete progress.waiting;
      progress.rateLimit = scheduler.snapshot();
      if (hadPersistedWait) {
        updateTimestamp(progress, now);
        await saveProgress(paths, progress);
        await input.onProgress?.(event);
      }
    },
  });
  scheduler.restore(progress.rateLimit);
  if (progress.waiting && Date.parse(progress.waiting.retryAt) <= now().valueOf()) {
    delete progress.waiting;
    progress.rateLimit = scheduler.snapshot();
    updateTimestamp(progress, now);
    await saveProgress(paths, progress);
  }
  requestControls.set(runtime, { scheduler, paths, progress, now });

  manifest.collection.status = 'collecting';
  manifest.collection.startedAt ??= nowIso(now);
  manifest.collection.completedAt = null;
  progress.phase = 'collecting';
  updateTimestamp(progress, now);
  await saveManifest(paths, manifest);
  await saveProgress(paths, progress);

  let issueCount = 0;
  let collectedIssueCount = 0;
  let wikiCount = 0;
  let collectedWikiCount = 0;
  let sharedFileCount = 0;
  let collectedAssetCount = 0;
  let assetCount = 0;
  try {
    const projectId = await resolveProject({ paths, manifest, progress, runtime, env, now });
    const assetIndex = await loadAssetIndex(paths, projectId);
    if (assetIndex.savedAt === null) {
      assetIndex.savedAt = nowIso(now);
      await writeJsonAtomically(assetIndexPath(paths), assetIndex);
    }
    const issues = await collectIssueIndex({
      paths,
      progress,
      runtime,
      env,
      projectId,
      archiveId: manifest.archive.id,
      now,
    });
    issueCount = issues.length;
    for (const issueSummary of issues) {
      if (await collectIssue({
        paths,
        progress,
        runtime,
        env,
        archiveId: manifest.archive.id,
        issueSummary,
        now,
      })) {
        collectedIssueCount += 1;
      }
      if (taskIsComplete(progress, `issue:${issueSummary.id}`)) {
        const savedIssue = await loadIssue(join(paths.data, 'issues', `${issueSummary.id}.json`));
        collectedAssetCount += await collectIssueAttachments({
          paths,
          progress,
          runtime,
          env,
          now,
          assetIndex,
          issue: savedIssue.issue,
        });
      }
    }
    const wikis = await collectWikiIndex({ paths, progress, runtime, env, projectId, now });
    wikiCount = wikis.length;
    for (const wikiSummary of wikis) {
      if (await collectWiki({ paths, progress, runtime, env, wikiSummary, now })) {
        collectedWikiCount += 1;
      }
      if (taskIsComplete(progress, `wiki:${wikiSummary.id}`)) {
        let savedWiki = await loadWiki(join(paths.data, 'wikis', `${wikiSummary.id}.json`));
        savedWiki = await collectWikiAttachmentList({
          paths,
          progress,
          runtime,
          env,
          now,
          wikiData: savedWiki,
        });
        collectedAssetCount += await collectWikiAttachments({
          paths,
          progress,
          runtime,
          env,
          now,
          assetIndex,
          wiki: savedWiki.wiki,
        });
      }
    }
    const sharedFiles = await collectSharedFiles({
      paths,
      progress,
      runtime,
      env,
      projectId,
      now,
      assetIndex,
    });
    sharedFileCount = sharedFiles.sharedFileCount;
    collectedAssetCount += sharedFiles.collectedAssetCount;
    assetCount = assetIndex.issueAttachments.length
      + assetIndex.wikiAttachments.length
      + assetIndex.sharedFiles.length;
  } catch (error) {
    manifest.collection.status = 'incomplete';
    progress.phase = 'incomplete';
    updateTimestamp(progress, now);
    await saveManifest(paths, manifest);
    await saveProgress(paths, progress);
    throw error;
  }

  if (hasFailedTasks(progress)) {
    manifest.collection.status = 'incomplete';
    progress.phase = 'incomplete';
    updateTimestamp(progress, now);
    await saveManifest(paths, manifest);
    await saveProgress(paths, progress);
    throw new ArchiveCollectionError('Collection is incomplete; retry failed tasks to resume.');
  }

  manifest.collection.status = 'completed';
  delete progress.waiting;
  manifest.collection.completedAt = nowIso(now);
  manifest.collection.counts = {
    issues: issueCount,
    wikis: wikiCount,
    sharedFiles: sharedFileCount,
    assets: assetCount,
  };
  progress.phase = 'completed';
  updateTimestamp(progress, now);
  await saveManifest(paths, manifest);
  await saveProgress(paths, progress);
  return {
    projectId: manifest.source.project.id,
    issueCount,
    collectedIssueCount,
    wikiCount,
    collectedWikiCount,
    sharedFileCount,
    assetCount,
    collectedAssetCount,
    runtime: runtimeInfo.product,
  };
}
