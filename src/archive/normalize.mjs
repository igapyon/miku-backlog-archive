import { ArchiveFormatError } from './format.mjs';

const PRIVATE_USER_FIELDS = new Set([
  'mailAddress',
  'lastLoginTime',
  'nulabAccount',
  'roleType',
  'lang',
]);

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArchiveFormatError(`${name} must be an object.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ArchiveFormatError(`${name} must be a positive integer.`);
  }
  return value;
}

function stringValue(value) {
  return typeof value === 'string' ? value : null;
}

function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Keep an intentionally narrow person shape throughout archive data.
 *
 * @param {unknown} value
 */
export function normalizePerson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const person = /** @type {Record<string, unknown>} */ (value);
  const id = numberValue(person.id);
  const userId = stringValue(person.userId);
  const name = stringValue(person.name);
  if (id === null || userId === null || name === null) {
    return null;
  }
  return { id, userId, name };
}

function normalizeDisplay(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const source = /** @type {Record<string, unknown>} */ (value);
  const result = {};
  for (const key of ['id', 'name', 'color', 'displayOrder', 'projectId']) {
    const item = source[key];
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      result[key] = item;
    }
  }
  return Object.keys(result).length === 0 ? null : result;
}

function sanitizeJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeJson);
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const source = /** @type {Record<string, unknown>} */ (value);
  const result = {};
  for (const [key, item] of Object.entries(source)) {
    if (!PRIVATE_USER_FIELDS.has(key)) {
      result[key] = sanitizeJson(item);
    }
  }
  return result;
}

export function normalizeAttachment(value) {
  const source = record(value, 'attachment');
  return {
    id: positiveInteger(source.id, 'attachment.id'),
    name: stringValue(source.name),
    size: numberValue(source.size),
    createdUser: normalizePerson(source.createdUser),
    created: stringValue(source.created),
  };
}

export function normalizeSharedFile(value) {
  const source = record(value, 'shared file');
  return {
    id: positiveInteger(source.id, 'sharedFile.id'),
    projectId: numberValue(source.projectId),
    type: stringValue(source.type),
    dir: stringValue(source.dir),
    name: stringValue(source.name),
    size: numberValue(source.size),
    createdUser: normalizePerson(source.createdUser),
    created: stringValue(source.created),
    updatedUser: normalizePerson(source.updatedUser),
    updated: stringValue(source.updated),
  };
}

/** @param {unknown} value */
export function normalizeProject(value) {
  const source = record(value, 'project');
  return {
    id: positiveInteger(source.id, 'project.id'),
    projectKey: stringValue(source.projectKey),
    name: stringValue(source.name),
    description: stringValue(source.description),
    chartEnabled: source.chartEnabled === true,
    subtaskingEnabled: source.subtaskingEnabled === true,
    projectLeader: normalizePerson(source.projectLeader),
  };
}

/** @param {unknown} value */
export function normalizeIssueSummary(value) {
  const source = record(value, 'issue summary');
  return {
    id: positiveInteger(source.id, 'issue.id'),
    projectId: positiveInteger(source.projectId, 'issue.projectId'),
    issueKey: stringValue(source.issueKey),
    summary: stringValue(source.summary),
  };
}

/** @param {unknown} value */
export function normalizeIssue(value) {
  const source = record(value, 'issue');
  const identity = normalizeIssueSummary(source);
  return {
    ...identity,
    keyId: numberValue(source.keyId),
    description: stringValue(source.description),
    issueType: normalizeDisplay(source.issueType),
    status: normalizeDisplay(source.status),
    priority: normalizeDisplay(source.priority),
    resolution: normalizeDisplay(source.resolution),
    assignee: normalizePerson(source.assignee),
    category: arrayValue(source.category).map(normalizeDisplay).filter(Boolean),
    versions: arrayValue(source.versions).map(normalizeDisplay).filter(Boolean),
    milestone: arrayValue(source.milestone).map(normalizeDisplay).filter(Boolean),
    startDate: stringValue(source.startDate),
    dueDate: stringValue(source.dueDate),
    estimatedHours: numberValue(source.estimatedHours),
    actualHours: numberValue(source.actualHours),
    parentIssueId: numberValue(source.parentIssueId),
    createdUser: normalizePerson(source.createdUser),
    created: stringValue(source.created),
    updatedUser: normalizePerson(source.updatedUser),
    updated: stringValue(source.updated),
    customFields: arrayValue(source.customFields).map((field) => sanitizeJson(field)),
    attachments: arrayValue(source.attachments).map(normalizeAttachment),
    sharedFiles: arrayValue(source.sharedFiles).map(normalizeSharedFile),
  };
}

/** @param {unknown} value */
export function normalizeComment(value) {
  const source = record(value, 'comment');
  return {
    id: positiveInteger(source.id, 'comment.id'),
    issueId: positiveInteger(source.issueId, 'comment.issueId'),
    projectId: positiveInteger(source.projectId, 'comment.projectId'),
    content: stringValue(source.content),
    changeLog: sanitizeJson(source.changeLog),
    createdUser: normalizePerson(source.createdUser),
    created: stringValue(source.created),
    updated: stringValue(source.updated),
  };
}

/** @param {unknown} value */
export function normalizeRelatedIssue(value) {
  const source = record(value, 'related issue');
  return {
    id: positiveInteger(source.id, 'relatedIssue.id'),
    issueKey: stringValue(source.issueKey),
    summary: stringValue(source.summary),
    type: stringValue(source.type),
  };
}

/** @param {unknown} value */
export function normalizeWikiSummary(value) {
  const source = record(value, 'wiki summary');
  return {
    id: positiveInteger(source.id, 'wiki.id'),
    projectId: positiveInteger(source.projectId, 'wiki.projectId'),
    name: stringValue(source.name),
    tags: arrayValue(source.tags).filter((tag) => typeof tag === 'string'),
    createdUser: normalizePerson(source.createdUser),
    created: stringValue(source.created),
    updatedUser: normalizePerson(source.updatedUser),
    updated: stringValue(source.updated),
  };
}

/** @param {unknown} value */
export function normalizeWiki(value) {
  const source = record(value, 'wiki');
  return {
    ...normalizeWikiSummary(source),
    content: stringValue(source.content),
    attachments: arrayValue(source.attachments).map(normalizeAttachment),
    sharedFiles: arrayValue(source.sharedFiles).map(normalizeSharedFile),
  };
}
