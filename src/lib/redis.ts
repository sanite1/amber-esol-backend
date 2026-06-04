import Redis, { RedisOptions } from "ioredis";
import logger from "../config/logger";

/**
 * Singleton Redis connection for BullMQ queues, pre-cache services, and the
 * rate limiter.
 *
 * Soft-dependency design
 * ──────────────────────
 * Redis is treated as a SOFT dependency. If it is unreachable at boot
 * (Upstash quota exceeded, network blip, mis-set REDIS_URL) the process
 * still starts — features that depend on Redis degrade gracefully:
 *
 *   • Rate limiters fall back to in-memory (per-container, see
 *     config/rateLimiter.ts). Less precise than fleet-wide counters
 *     but functional.
 *   • Cache-aside reads (safeguarding messages, postcode lookups, FALA
 *     data) miss → fall through to Mongo.
 *   • BullMQ enqueue attempts log + drop. Acceptable for pilot — the
 *     daily crons that depend on the queue are idempotent and will
 *     catch up on the next run.
 *
 * The single error case where we still hard-fail: REDIS_URL not set in
 * production. That's a deploy mistake worth crashing for.
 *
 * BullMQ requirement
 * ──────────────────
 * `maxRetriesPerRequest: null` is mandatory on any connection used for
 * blocking commands (BRPOPLPUSH etc.). Setting it on the singleton means
 * every BullMQ queue, worker, and QueueEvents instance can reuse this
 * client without surprises.
 *
 * TLS
 * ───
 * Upstash and most managed providers serve Redis over TLS at a
 * `rediss://` URL. ioredis auto-detects the scheme; we additionally pass
 * an explicit `tls: {}` so misconfigured non-rediss URLs against TLS
 * endpoints fail loudly rather than hanging.
 */

const REDIS_URL = process.env.REDIS_URL || "";

let _redis: Redis | null = null;
let _available = false;

const buildOptions = (url: string): RedisOptions => {
  const opts: RedisOptions = {
    // Non-negotiable for BullMQ. Without this, blocking workers throw.
    maxRetriesPerRequest: null,
    // Don't queue commands before ready — surfaces connection problems
    // immediately rather than as cryptic timeouts on first use.
    enableReadyCheck: true,
    // Sensible default reconnect strategy: exponential backoff capped at 5s.
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  };

  // Explicit TLS for rediss:// URLs. ioredis would infer this, but being
  // explicit means the options object can be reused as a BullMQ
  // ConnectionOptions and the intent is documented.
  if (url.startsWith("rediss://")) {
    opts.tls = {};
  }
  return opts;
};

/**
 * Parse the host out of a Redis URL for logging. Never logs the full URL —
 * the password is embedded in `userinfo` and should not appear in any log.
 */
const safeHost = (url: string): string => {
  try {
    const u = new URL(url);
    return u.host || "(unknown)";
  } catch {
    return "(unparseable)";
  }
};

/**
 * Attempt to connect to Redis at boot.
 *
 * Resolves to `true` on success, `false` on failure. Failure cases that
 * are silently tolerated:
 *   • REDIS_URL missing in dev / test (developers without a local
 *     Upstash instance can still iterate)
 *   • Connection refused / timed out
 *   • Authentication rejected
 *   • PING rejected
 *
 * The only hard failure is missing REDIS_URL in production — that's a
 * deploy mistake we want surfaced immediately.
 */
export const initRedis = async (): Promise<boolean> => {
  if (_redis) {
    logger.warn("initRedis called twice — ignoring second call");
    return _available;
  }

  if (!REDIS_URL) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Redis init failed: REDIS_URL is not set in production. " +
          "Provision an Upstash instance and add the rediss:// URL to the deploy env."
      );
    }
    logger.warn(
      "REDIS_URL not set — Redis-backed features disabled (rate limiters " +
        "fall back to in-memory, cache reads fall through to DB, queue " +
        "enqueues will no-op). Set REDIS_URL in .env to enable."
    );
    _available = false;
    return false;
  }

  let client: Redis;
  try {
    client = new Redis(REDIS_URL, buildOptions(REDIS_URL));
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "Redis init failed during connection construction — continuing with " +
        "in-memory fallbacks"
    );
    _available = false;
    return false;
  }

  // Surface connection lifecycle events. These help diagnose intermittent
  // Upstash failures in production without needing to attach a debugger.
  client.on("error", (err: Error) => {
    // Logged but not thrown — ioredis emits errors during reconnect attempts
    // that are recoverable; the process should not crash on every blip.
    logger.error({ err: err.message }, "Redis error");
  });
  client.on("end", () => {
    logger.warn("Redis connection ended");
    _available = false;
  });
  client.on("reconnecting", (delayMs: number) => {
    logger.warn({ delayMs }, "Redis reconnecting");
  });
  client.on("ready", () => {
    _available = true;
    logger.info("Redis ready (reconnect)");
  });

  // PING blocks until the connection is fully open AND authenticated.
  // If REDIS_URL is wrong, this is where we find out.
  try {
    await client.ping();
  } catch (err) {
    logger.error(
      { err: (err as Error).message, host: safeHost(REDIS_URL) },
      "Redis init PING failed — continuing with in-memory fallbacks. " +
        "Check the Upstash dashboard for quota / connection-limit alerts."
    );
    // Disconnect cleanly so we don't leak a half-open socket retrying
    // forever in the background.
    try {
      client.disconnect();
    } catch {
      /* noop */
    }
    _available = false;
    return false;
  }

  _redis = client;
  _available = true;
  logger.info(`Redis connected: ${safeHost(REDIS_URL)}`);
  return true;
};

/**
 * Returns true iff Redis is currently connected AND was successfully
 * pinged at boot. Used by:
 *   • config/rateLimiter.ts to decide between RedisStore and in-memory
 *   • cache-aside services to skip the cache lookup on outage
 *   • BullMQ queue producers to no-op enqueue when Redis is down
 *
 * Note: this does NOT do a live PING — it just reflects the last
 * known state. Callers should treat this as a hint, not a guarantee:
 * a `redis.get()` immediately after may still throw if Redis went
 * down between this check and the call.
 */
export const isRedisAvailable = (): boolean => _available;

/**
 * Shared Redis client for general-purpose use (rate limiter, pre-cache,
 * ad-hoc commands).
 *
 * When Redis is unavailable, accessing any method throws a tagged
 * `REDIS_UNAVAILABLE` error so callers can `try/catch` and fall through
 * to their alternative path (in-memory, DB, no-op).
 *
 * DO NOT pass this Proxy to BullMQ. BullMQ does `.duplicate()` and direct
 * internal method binding which the Proxy disrupts ("client[name] is not a
 * function"). For BullMQ Queue/Worker construction, use
 * `createBullmqConnection()` below — each Queue/Worker gets its own real
 * ioredis instance per BullMQ's official recommendation.
 */
export class RedisUnavailableError extends Error {
  readonly code = "REDIS_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "RedisUnavailableError";
  }
}

export const redis: Redis = new Proxy({} as Redis, {
  get(_target, prop, receiver) {
    if (!_redis || !_available) {
      throw new RedisUnavailableError(
        `Redis not available (accessed property "${String(prop)}"). ` +
          "Caller should catch RedisUnavailableError and use its fallback path."
      );
    }
    return Reflect.get(_redis, prop, receiver);
  },
});

/**
 * Construct a fresh ioredis connection for BullMQ.
 *
 * BullMQ best practice: each Worker MUST have its own dedicated connection
 * because workers issue blocking commands (BRPOPLPUSH etc.) that monopolise
 * the connection. Queues can share a connection but worker sharing causes:
 *   - "client[name] is not a function" errors (internal binding fails)
 *   - MaxListenersExceededWarning (each worker adds 3+ listeners)
 *   - Mysterious worker stalls
 *
 * Call this once per consumer: one for the queue producers, one per Worker.
 * The returned client uses the same TLS / retry / backoff config as the
 * singleton — only the connection lifecycle is independent.
 *
 * Returns null if REDIS_URL isn't set — callers should treat queue
 * producers as no-ops in that case rather than crashing.
 */
export const createBullmqConnection = (): Redis | null => {
  if (!REDIS_URL) {
    logger.warn(
      "createBullmqConnection called without REDIS_URL — returning null. " +
        "BullMQ queue producers / workers will no-op."
    );
    return null;
  }
  return new Redis(REDIS_URL, buildOptions(REDIS_URL));
};

/**
 * Minimal "is Redis reachable" probe used by GET /api/health/redis.
 * Issues a PING against the live singleton and reports round-trip latency.
 */
export const pingRedis = async (): Promise<{ latencyMs: number }> => {
  if (!_redis || !_available) {
    throw new RedisUnavailableError("pingRedis: Redis not connected.");
  }
  const t0 = Date.now();
  await _redis.ping();
  return { latencyMs: Date.now() - t0 };
};
