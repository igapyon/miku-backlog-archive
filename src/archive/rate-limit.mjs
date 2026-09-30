const SEARCH_OPERATIONS = new Set(['get_issues', 'get_wiki_pages']);
const RATE_LIMIT_CATEGORIES = ['read', 'search'];
const DEFAULT_INTERVAL_MS = 1_000;
const SEARCH_MINIMUM_INTERVAL_MS = 1_000;
const NO_REMAINING_FALLBACK_MS = 60_000;
const RESET_GUARD_MS = 1_000;

function validDate(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function categoryState() {
  return {
    limit: null,
    remaining: null,
    resetAt: null,
    nextAllowedAt: null,
    blockedUntil: null,
    blockedReason: null,
  };
}

function readBucket(value) {
  const result = categoryState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result;
  }
  for (const key of ['limit', 'remaining']) {
    const counter = validCounter(value[key]);
    if (counter !== null) {
      result[key] = counter;
    }
  }
  for (const key of ['resetAt', 'nextAllowedAt', 'blockedUntil']) {
    if (validDate(value[key]) !== null) {
      result[key] = new Date(value[key]).toISOString();
    }
  }
  if (['rate-limit', 'quota'].includes(value.blockedReason)) {
    result.blockedReason = value.blockedReason;
  }
  if (result.nextAllowedAt === null && result.blockedUntil !== null) {
    result.nextAllowedAt = result.blockedUntil;
  }
  return result;
}

function getNowMilliseconds(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError('Rate-limit clock returned an invalid Date.');
  }
  return value.valueOf();
}

function baseInterval(category, limit) {
  const rateInterval = Number.isSafeInteger(limit) && limit > 0
    ? Math.ceil(60_000 / (limit * 0.8))
    : DEFAULT_INTERVAL_MS;
  return category === 'search'
    ? Math.max(SEARCH_MINIMUM_INTERVAL_MS, rateInterval)
    : rateInterval;
}

/**
 * Backlog has separate search and read quotas. All other operations used by
 * this archive are ordinary GET reads, including streamed file downloads.
 *
 * @param {string} operation
 */
export function rateLimitCategory(operation) {
  return SEARCH_OPERATIONS.has(operation) ? 'search' : 'read';
}

/**
 * Coordinate sequential Backlog requests using response metadata. The wait
 * hook resolves once its delay has elapsed; tests may replace it with a
 * virtual-clock implementation.
 *
 * @param {{ now?: () => Date, wait?: (milliseconds: number) => Promise<void>, onWait?: (event: Record<string, unknown>) => unknown }} [options]
 */
export function createRateLimitScheduler(options = {}) {
  const now = options.now ?? (() => new Date());
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const onWait = options.onWait ?? (() => {});
  const state = Object.fromEntries(RATE_LIMIT_CATEGORIES.map((category) => [category, categoryState()]));

  function snapshot() {
    const result = {};
    for (const category of RATE_LIMIT_CATEGORIES) {
      const bucket = state[category];
      const stored = {};
      for (const key of ['limit', 'remaining', 'resetAt', 'nextAllowedAt', 'blockedUntil', 'blockedReason']) {
        if (bucket[key] !== null) {
          stored[key] = bucket[key];
        }
      }
      result[category] = stored;
    }
    return result;
  }

  function restore(value) {
    for (const category of RATE_LIMIT_CATEGORIES) {
      state[category] = readBucket(value?.[category]);
    }
  }

  function observe(operation, event) {
    if (!event || (event.phase !== 'success' && event.phase !== 'failure')) {
      return;
    }
    const category = rateLimitCategory(operation);
    const bucket = state[category];
    const metadata = event.rateLimit && typeof event.rateLimit === 'object'
      && !Array.isArray(event.rateLimit)
      ? event.rateLimit
      : {};
    const limit = validCounter(metadata.limit);
    const remaining = validCounter(metadata.remaining);
    const resetAtMs = validDate(metadata.resetAt);
    if (limit !== null) {
      bucket.limit = limit;
    }
    if (remaining !== null) {
      bucket.remaining = remaining;
    }
    if (resetAtMs !== null) {
      bucket.resetAt = new Date(resetAtMs).toISOString();
    }

    const nowMs = getNowMilliseconds(now);
    const resetIsFuture = resetAtMs !== null && resetAtMs > nowMs;
    if ((resetAtMs !== null && !resetIsFuture)
      || (bucket.resetAt !== null && Date.parse(bucket.resetAt) <= nowMs)) {
      bucket.remaining = null;
      bucket.resetAt = null;
    }
    if (event.httpStatus === 429) {
      const blockedUntilMs = resetIsFuture
        ? resetAtMs + RESET_GUARD_MS
        : nowMs + NO_REMAINING_FALLBACK_MS;
      bucket.nextAllowedAt = new Date(blockedUntilMs).toISOString();
      bucket.blockedUntil = bucket.nextAllowedAt;
      bucket.blockedReason = 'rate-limit';
      if (!resetIsFuture) {
        bucket.remaining = 0;
        bucket.resetAt = null;
      }
      return;
    }

    if (bucket.remaining !== null && bucket.remaining <= 1) {
      const currentResetAt = validDate(bucket.resetAt);
      const blockedUntilMs = currentResetAt !== null && currentResetAt > nowMs
        ? currentResetAt + RESET_GUARD_MS
        : nowMs + NO_REMAINING_FALLBACK_MS;
      bucket.nextAllowedAt = new Date(blockedUntilMs).toISOString();
      bucket.blockedUntil = bucket.nextAllowedAt;
      bucket.blockedReason = 'quota';
      return;
    }

    const intervalMs = baseInterval(category, bucket.limit);
    const distributedMs = resetIsFuture && remaining !== null && remaining > 1
      ? Math.ceil((resetAtMs - nowMs) / (remaining - 1))
      : 0;
    bucket.nextAllowedAt = new Date(nowMs + Math.max(intervalMs, distributedMs)).toISOString();
    bucket.blockedUntil = null;
    bucket.blockedReason = null;
  }

  async function waitBefore(operation, reason = 'pacing', minimumDelayMs = 0) {
    const category = rateLimitCategory(operation);
    const bucket = state[category];
    const nowMs = getNowMilliseconds(now);
    const targetMs = Math.max(
      validDate(bucket.nextAllowedAt) ?? nowMs,
      nowMs + Math.max(0, Number.isFinite(minimumDelayMs) ? minimumDelayMs : 0),
    );
    const delayMs = Math.max(0, Math.ceil(targetMs - nowMs));
    if (delayMs === 0) {
      bucket.nextAllowedAt = null;
      bucket.blockedUntil = null;
      bucket.blockedReason = null;
      return;
    }

    const event = {
      category,
      reason: bucket.blockedUntil !== null ? (bucket.blockedReason ?? 'rate-limit') : reason,
      startedAt: new Date(nowMs).toISOString(),
      retryAt: new Date(targetMs).toISOString(),
      delayMs,
    };
    await onWait({ phase: 'waiting', ...event });
    await wait(delayMs);
    bucket.nextAllowedAt = null;
    bucket.blockedUntil = null;
    bucket.blockedReason = null;
    await onWait({ phase: 'resumed', ...event });
  }

  return { observe, restore, snapshot, waitBefore };
}
