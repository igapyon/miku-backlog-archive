import assert from 'node:assert/strict';
import test from 'node:test';

import { createRateLimitScheduler, rateLimitCategory } from '../src/archive/rate-limit.mjs';

test('assigns Backlog operations to the search and read quota buckets', () => {
  assert.equal(rateLimitCategory('get_issues'), 'search');
  assert.equal(rateLimitCategory('get_wiki_pages'), 'search');
  assert.equal(rateLimitCategory('get_issue'), 'read');
  assert.equal(rateLimitCategory('download_shared_file'), 'read');
});

test('keeps search quota state separate while GET and downloads share read state', async () => {
  let currentTime = new Date('2026-09-30T00:00:00.000Z');
  const waits = [];
  const scheduler = createRateLimitScheduler({
    now: () => currentTime,
    async wait(milliseconds) {
      waits.push(milliseconds);
      currentTime = new Date(currentTime.valueOf() + milliseconds);
    },
  });
  scheduler.observe('get_issues', {
    phase: 'success',
    rateLimit: { limit: 60, remaining: 2, resetAt: '2026-09-30T00:00:30.000Z' },
  });
  const searchNextAllowedAt = scheduler.snapshot().search.nextAllowedAt;
  assert.equal(scheduler.snapshot().read.nextAllowedAt, undefined);

  scheduler.observe('download_shared_file', {
    phase: 'success',
    rateLimit: { limit: 120, remaining: 8, resetAt: '2026-09-30T00:00:30.000Z' },
  });
  assert.equal(scheduler.snapshot().search.nextAllowedAt, searchNextAllowedAt);
  assert.equal(scheduler.snapshot().read.remaining, 8);
  await scheduler.waitBefore('get_issue');
  assert.deepEqual(waits, [Math.ceil(30_000 / 7)]);
});

test('spreads requests across the remaining quota window', async () => {
  let currentTime = new Date('2026-09-30T00:00:00.000Z');
  const waits = [];
  const events = [];
  const scheduler = createRateLimitScheduler({
    now: () => currentTime,
    async wait(milliseconds) {
      waits.push(milliseconds);
      currentTime = new Date(currentTime.valueOf() + milliseconds);
    },
    onWait(event) { events.push(event); },
  });
  scheduler.observe('get_issues', {
    phase: 'success',
    rateLimit: {
      limit: 60,
      remaining: 5,
      resetAt: '2026-09-30T00:00:50.000Z',
    },
  });

  assert.equal(scheduler.snapshot().search.nextAllowedAt, '2026-09-30T00:00:12.500Z');
  await scheduler.waitBefore('get_issues');
  assert.deepEqual(waits, [12_500]);
  assert.deepEqual(events.map((event) => event.phase), ['waiting', 'resumed']);
  assert.equal(scheduler.snapshot().search.nextAllowedAt, undefined);
});

test('blocks a 429 until reset plus a guard, or 60 seconds without a future reset', async () => {
  let currentTime = new Date('2026-09-30T00:00:00.000Z');
  const waits = [];
  const scheduler = createRateLimitScheduler({
    now: () => currentTime,
    async wait(milliseconds) {
      waits.push(milliseconds);
      currentTime = new Date(currentTime.valueOf() + milliseconds);
    },
  });
  scheduler.observe('get_issue', {
    phase: 'failure',
    httpStatus: 429,
    rateLimit: { limit: 100, remaining: 0, resetAt: '2026-09-30T00:00:10.000Z' },
  });
  assert.equal(scheduler.snapshot().read.blockedUntil, '2026-09-30T00:00:11.000Z');
  assert.equal(scheduler.snapshot().read.blockedReason, 'rate-limit');
  await scheduler.waitBefore('get_issue', 'rate-limit');
  assert.deepEqual(waits, [11_000]);

  scheduler.observe('download_issue_attachment', {
    phase: 'failure',
    httpStatus: 429,
    rateLimit: { limit: 100, remaining: 0, resetAt: '2026-09-30T00:00:10.000Z' },
  });
  assert.equal(scheduler.snapshot().read.blockedUntil, '2026-09-30T00:01:11.000Z');
  await scheduler.waitBefore('download_issue_attachment', 'rate-limit');
  assert.deepEqual(waits, [11_000, 60_000]);
});

test('uses the 60 second fallback for missing, invalid, or expired 429 reset times', async () => {
  for (const resetAt of [undefined, 'not-a-date', '2026-09-29T23:59:00.000Z']) {
    let currentTime = new Date('2026-09-30T00:00:00.000Z');
    const waits = [];
    const scheduler = createRateLimitScheduler({
      now: () => currentTime,
      async wait(milliseconds) {
        waits.push(milliseconds);
        currentTime = new Date(currentTime.valueOf() + milliseconds);
      },
    });
    scheduler.observe('get_project', {
      phase: 'failure',
      httpStatus: 429,
      rateLimit: { limit: 100, remaining: 0, ...(resetAt === undefined ? {} : { resetAt }) },
    });
    await scheduler.waitBefore('get_project', 'rate-limit');
    assert.deepEqual(waits, [60_000]);
  }
});

test('waits when a successful response leaves one request and expires stale reset counts', async () => {
  let currentTime = new Date('2026-09-30T00:00:00.000Z');
  const waits = [];
  const scheduler = createRateLimitScheduler({
    now: () => currentTime,
    async wait(milliseconds) {
      waits.push(milliseconds);
      currentTime = new Date(currentTime.valueOf() + milliseconds);
    },
  });
  scheduler.observe('get_issue', {
    phase: 'success',
    rateLimit: { limit: 100, remaining: 1, resetAt: '2026-09-30T00:00:10.000Z' },
  });
  assert.equal(scheduler.snapshot().read.blockedUntil, '2026-09-30T00:00:11.000Z');
  assert.equal(scheduler.snapshot().read.blockedReason, 'quota');
  await scheduler.waitBefore('get_issue');
  assert.deepEqual(waits, [11_000]);

  scheduler.observe('get_issue', {
    phase: 'success',
    rateLimit: { limit: 100, remaining: 0, resetAt: '2026-09-30T00:00:10.000Z' },
  });
  const refreshed = scheduler.snapshot().read;
  assert.equal(refreshed.remaining, undefined);
  assert.equal(refreshed.resetAt, undefined);
  assert.equal(refreshed.blockedUntil, undefined);
});

test('blocks at zero remaining and discards an expired saved cooldown without waiting', async () => {
  let currentTime = new Date('2026-09-30T00:00:00.000Z');
  const waits = [];
  const scheduler = createRateLimitScheduler({
    now: () => currentTime,
    async wait(milliseconds) {
      waits.push(milliseconds);
      currentTime = new Date(currentTime.valueOf() + milliseconds);
    },
  });
  scheduler.observe('get_issue', {
    phase: 'success',
    rateLimit: { limit: 100, remaining: 0, resetAt: '2026-09-30T00:00:10.000Z' },
  });
  assert.equal(scheduler.snapshot().read.blockedUntil, '2026-09-30T00:00:11.000Z');

  currentTime = new Date('2026-09-30T00:00:12.000Z');
  await scheduler.waitBefore('download_issue_attachment');

  assert.deepEqual(waits, []);
  assert.equal(scheduler.snapshot().read.blockedUntil, undefined);
});

test('restores a saved cooldown before issuing the next request', async () => {
  let currentTime = new Date('2026-09-30T00:00:00.000Z');
  const waits = [];
  const scheduler = createRateLimitScheduler({
    now: () => currentTime,
    async wait(milliseconds) {
      waits.push(milliseconds);
      currentTime = new Date(currentTime.valueOf() + milliseconds);
    },
  });
  scheduler.restore({
    read: { blockedUntil: '2026-09-30T00:00:30.000Z' },
  });

  await scheduler.waitBefore('get_project');

  assert.deepEqual(waits, [30_000]);
  assert.equal(scheduler.snapshot().read.blockedUntil, undefined);
});

test('keeps a one second minimum for search requests without quota metadata', async () => {
  let currentTime = new Date('2026-09-30T00:00:00.000Z');
  const waits = [];
  const scheduler = createRateLimitScheduler({
    now: () => currentTime,
    async wait(milliseconds) {
      waits.push(milliseconds);
      currentTime = new Date(currentTime.valueOf() + milliseconds);
    },
  });
  scheduler.observe('get_wiki_pages', { phase: 'success' });
  await scheduler.waitBefore('get_wiki_pages');
  assert.deepEqual(waits, [1_000]);
});
