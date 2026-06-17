export type RateLimitPolicy = {
  windowMs: number;
  maxFailures: number;
  lockoutThreshold: number;
  lockoutMs: number;
  backoffBaseMs: number;
};

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export type RateLimiter = {
  check(key: string): RateLimitDecision;
  fail(key: string): void;
  reset(key: string): void;
};

export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  windowMs: 60_000,
  maxFailures: 5,
  lockoutThreshold: 10,
  lockoutMs: 15 * 60_000,
  backoffBaseMs: 1_000
};

type Bucket = {
  recentFailures: number;
  totalFailures: number;
  windowStartedAt: number;
  pauseUntil: number;
  lockoutUntil: number;
};

function mergePolicy(policy: Partial<RateLimitPolicy> | undefined): RateLimitPolicy {
  return { ...DEFAULT_RATE_LIMIT_POLICY, ...(policy ?? {}) };
}

function retryAfter(targetTime: number, now: number): number {
  return Math.max(1, targetTime - now);
}

function currentBucket(buckets: Map<string, Bucket>, key: string, now: number, policy: RateLimitPolicy): Bucket {
  const existing = buckets.get(key);
  if (existing) {
    if (now - existing.windowStartedAt >= policy.windowMs) {
      existing.recentFailures = 0;
      existing.windowStartedAt = now;
      existing.pauseUntil = 0;
    }
    return existing;
  }
  const bucket: Bucket = {
    recentFailures: 0,
    totalFailures: 0,
    windowStartedAt: now,
    pauseUntil: 0,
    lockoutUntil: 0
  };
  buckets.set(key, bucket);
  return bucket;
}

export function createRateLimiter(policyInput?: Partial<RateLimitPolicy>, now: () => number = Date.now): RateLimiter {
  const policy = mergePolicy(policyInput);
  const buckets = new Map<string, Bucket>();
  return {
    check(key) {
      const timestamp = now();
      const bucket = currentBucket(buckets, key, timestamp, policy);
      if (bucket.lockoutUntil > timestamp) {
        return { allowed: false, retryAfterMs: retryAfter(bucket.lockoutUntil, timestamp) };
      }
      if (bucket.pauseUntil > timestamp) {
        return { allowed: false, retryAfterMs: retryAfter(bucket.pauseUntil, timestamp) };
      }
      return { allowed: true };
    },
    fail(key) {
      const timestamp = now();
      const bucket = currentBucket(buckets, key, timestamp, policy);
      bucket.recentFailures += 1;
      bucket.totalFailures += 1;
      if (bucket.totalFailures >= policy.lockoutThreshold) {
        bucket.lockoutUntil = timestamp + policy.lockoutMs;
        bucket.pauseUntil = 0;
        return;
      }
      if (bucket.recentFailures >= policy.maxFailures) {
        bucket.pauseUntil = timestamp + policy.backoffBaseMs;
      }
    },
    reset(key) {
      buckets.delete(key);
    }
  };
}
