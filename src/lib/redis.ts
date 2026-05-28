import Redis, { RedisOptions } from "ioredis";
import logger from "../config/logger";

/**
 * Singleton Redis connection for BullMQ queues, pre-cache services, and the
 * rate limiter. One ioredis instance is constructed at server boot via
 * initRedis() and shared by every consumer thereafter.
 *
 * BullMQ requirement: `maxRetriesPerRequest: null` is mandatory on any
 * connection used for blocking commands (BRPOPLPUSH etc.). Setting it on the
 * singleton means every BullMQ queue, worker, and QueueEvents instance can
 * reuse this client without surprises.
 *
 * TLS: Upstash and most managed providers serve Redis over TLS at a
 * `rediss://` URL. ioredis auto-detects the scheme; we additionally pass an
 * explicit `tls: {}` so misconfigured non-rediss URLs against TLS endpoints
 * fail loudly rather than hanging.
 *
 * Boot semantics: REDIS_URL is required; initRedis() throws if missing or
 * if the initial PING fails. The caller (src/index.ts) crashes the process
 * on failure — we never silently degrade to "queues don't work".
 */

const REDIS_URL = process.env.REDIS_URL || "";

let _redis: Redis | null = null;

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

export const initRedis = async (): Promise<void> => {
  if (_redis) {
    logger.warn("initRedis called twice — ignoring second call");
    return;
  }

  if (!REDIS_URL) {
    throw new Error(
      "Redis init failed: REDIS_URL is not set. Provision an Upstash instance and add the rediss:// URL to .env."
    );
  }

  let client: Redis;
  try {
    client = new Redis(REDIS_URL, buildOptions(REDIS_URL));
  } catch (err) {
    throw new Error(
      `Redis init failed during connection construction: ${(err as Error).message}`
    );
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
  });
  client.on("reconnecting", (delayMs: number) => {
    logger.warn({ delayMs }, "Redis reconnecting");
  });

  // PING blocks until the connection is fully open AND authenticated.
  // If REDIS_URL is wrong, this is where we find out.
  try {
    await client.ping();
  } catch (err) {
    throw new Error(`Redis init failed: PING rejected — ${(err as Error).message}`);
  }

  _redis = client;
  logger.info(`Redis connected: ${safeHost(REDIS_URL)}`);
};

/**
 * The shared Redis client for general-purpose use (rate limiter, pre-cache,
 * ad-hoc Redis commands). Access only after initRedis() has resolved —
 * Proxy throws a clear error otherwise.
 *
 * DO NOT pass this Proxy to BullMQ. BullMQ does `.duplicate()` and direct
 * internal method binding which the Proxy disrupts ("client[name] is not a
 * function"). For BullMQ Queue/Worker construction, use
 * `createBullmqConnection()` below — each Queue/Worker gets its own real
 * ioredis instance per BullMQ's official recommendation.
 */
export const redis: Redis = new Proxy({} as Redis, {
  get(_target, prop, receiver) {
    if (!_redis) {
      throw new Error(
        "redis accessed before initRedis() ran. Add `await initRedis()` to src/index.ts before server.listen()."
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
 */
export const createBullmqConnection = (): Redis => {
  if (!REDIS_URL) {
    throw new Error(
      "createBullmqConnection called before REDIS_URL was set in env."
    );
  }
  return new Redis(REDIS_URL, buildOptions(REDIS_URL));
};

/**
 * Minimal "is Redis reachable" probe used by GET /api/health/redis.
 * Issues a PING against the live singleton and reports round-trip latency.
 */
export const pingRedis = async (): Promise<{ latencyMs: number }> => {
  if (!_redis) {
    throw new Error("pingRedis called before initRedis().");
  }
  const t0 = Date.now();
  await _redis.ping();
  return { latencyMs: Date.now() - t0 };
};
