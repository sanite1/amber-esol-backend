import rateLimit, { Store, IncrementResponse } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";

import { redis, isRedisAvailable, RedisUnavailableError } from "../lib/redis";
import logger from "./logger";

/**
 * Build a Redis-backed store for one limiter — with lazy construction
 * and in-memory fallback.
 *
 * Design constraints
 * ──────────────────
 * 1. `rate-limit-redis` v4's RedisStore constructor synchronously calls
 *    `loadIncrementScript` and `loadGetScript` — both issue `SCRIPT LOAD`
 *    via `sendCommand`. If we construct RedisStore eagerly at module-
 *    load time (the obvious approach), those calls run BEFORE
 *    `initRedis()` and crash the boot.
 *
 * 2. Redis is a soft dependency (see lib/redis.ts). The rate limiter
 *    must degrade gracefully: if Upstash is over quota, dropped, or
 *    just not provisioned in dev, the API still serves — with in-memory
 *    per-container counters instead of fleet-wide Redis ones. Less
 *    precise (a load-balanced abuser gets N × the limit where N is
 *    the container count), but functional.
 *
 * Solution: a custom `LazyRedisStore` that defers construction of the
 * real RedisStore until the first `.increment()` call (by which time
 * initRedis has finished) AND falls back to express-rate-limit's
 * built-in MemoryStore when Redis is unavailable.
 *
 * The `prefix` argument scopes each limiter's keys in Redis so multiple
 * limiters can share one instance without colliding ("rl:ai-turn:<ip>"
 * vs "rl:session-start:<ip>").
 *
 * Multi-instance deploys: when Redis IS available, every API container
 * shares the same counter — 80/hour means 80/hour across the fleet.
 * When Redis is NOT available, each container counts independently —
 * a degraded mode the ops dashboard should surface.
 */

/**
 * Express-rate-limit's MemoryStore isn't exported as a class; we use
 * `rateLimit({}).store` to get an instance. This is brittle but the
 * library has no public path. If it ever changes shape, our lazy
 * wrapper falls back to a no-op rather than crashing.
 */
const makeMemoryStore = (): Store | null => {
  try {
    const limiter = rateLimit({ windowMs: 1, max: 1 });
    return (limiter as unknown as { store: Store }).store ?? null;
  } catch {
    return null;
  }
};

class LazyRedisStore implements Store {
  private readonly keyPrefix: string;
  private real: Store | null = null;
  private fallback: Store | null = null;
  private warnedFallback = false;
  /**
   * Captured `init` args from express-rate-limit so we can replay them
   * onto the real store / fallback store the moment we construct one.
   * The library calls `init({ windowMs })` exactly once per limiter,
   * during the first request after construction, on whichever store is
   * mounted on the limiter at that moment.
   */
  private initArgs: { windowMs: number } | null = null;

  constructor(prefix: string) {
    this.keyPrefix = prefix;
  }

  /**
   * Resolve which underlying store to use right now. Called from every
   * Store method. Re-checks `isRedisAvailable()` on each invocation so
   * a transient Redis outage doesn't permanently lock the limiter into
   * fallback mode — the next request after Redis recovers gets the
   * real store.
   */
  private resolve(): Store {
    if (isRedisAvailable()) {
      if (!this.real) {
        try {
          this.real = new RedisStore({
            sendCommand: (async (...args: string[]) => {
              return await (redis as unknown as {
                call: (...a: string[]) => Promise<unknown>;
              }).call(...args);
            }) as never,
            prefix: this.keyPrefix,
          });
          if (this.initArgs) this.real.init?.(this.initArgs as never);
          if (this.warnedFallback) {
            logger.info(
              { prefix: this.keyPrefix },
              "Rate limiter back on Redis-backed store"
            );
            this.warnedFallback = false;
          }
        } catch (err) {
          logger.error(
            { err: (err as Error).message, prefix: this.keyPrefix },
            "RedisStore construction failed — using in-memory fallback"
          );
          this.real = null;
        }
      }
      if (this.real) return this.real;
    }

    // Redis unavailable — construct (and reuse) the in-memory fallback.
    if (!this.fallback) {
      this.fallback = makeMemoryStore();
      if (this.fallback && this.initArgs) {
        this.fallback.init?.(this.initArgs as never);
      }
    }
    if (!this.warnedFallback) {
      logger.warn(
        { prefix: this.keyPrefix },
        "Rate limiter using in-memory fallback (Redis unavailable) — " +
          "counters are per-container, not fleet-wide"
      );
      this.warnedFallback = true;
    }
    return this.fallback ?? this.noopStore();
  }

  /**
   * Last-resort no-op store for the case where even the in-memory
   * fallback couldn't be constructed. Returns hits=1 so the limiter
   * always lets traffic through — better to undercount than to 500.
   */
  private noopStore(): Store {
    return {
      increment: async (): Promise<IncrementResponse> => ({
        totalHits: 1,
        resetTime: new Date(Date.now() + 60_000),
      }),
      decrement: async () => undefined,
      resetKey: async () => undefined,
    };
  }

  // ── Store interface delegation ───────────────────────────────────

  init(options: { windowMs: number }): void {
    this.initArgs = options;
    // If a store already exists, propagate the init.
    if (this.real) this.real.init?.(options as never);
    if (this.fallback) this.fallback.init?.(options as never);
  }

  async increment(key: string): Promise<IncrementResponse> {
    try {
      return await this.resolve().increment(key);
    } catch (err) {
      // Swallow Redis-unavailable errors and retry through the
      // fallback — never 500 the user just because counters are sad.
      if (
        err instanceof RedisUnavailableError ||
        (err as Error)?.message?.includes("REDIS_UNAVAILABLE")
      ) {
        // Force Redis to be marked unavailable in our local cache so
        // the next call doesn't try the real store again.
        this.real = null;
        if (!this.fallback) this.fallback = makeMemoryStore();
        if (this.fallback) return this.fallback.increment(key);
        return this.noopStore().increment(key);
      }
      throw err;
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await this.resolve().decrement(key);
    } catch {
      // Decrement is best-effort — silent failure is fine.
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await this.resolve().resetKey(key);
    } catch {
      // Reset is best-effort — silent failure is fine.
    }
  }
}

const makeRedisStore = (prefix: string): Store | undefined => {
  if (process.env.NODE_ENV === "test") return undefined;
  return new LazyRedisStore(prefix);
};

/**
 * General API limiter — applies to every /api route.
 * Generous enough for normal usage, blocks obvious abuse.
 */
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // 200 requests per window per IP
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  message: {
    status: 429,
    message: "Too many requests. Please try again later.",
  },
});

/**
 * Auth limiter — login, register, verify.
 * Tight limit to prevent brute-force and account spam.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message:
      "Too many authentication attempts. Please try again in 15 minutes.",
  },
});

/**
 * Password reset / forgot-password limiter.
 * Very tight — prevents email spam to arbitrary addresses.
 */
export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 requests per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many password reset requests. Please try again in an hour.",
  },
});

/**
 * Booking creation limiter.
 * Prevents rapid booking spam while allowing normal multi-slot bookings.
 */
export const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // 15 booking requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many booking requests. Please slow down.",
  },
});

/**
 * Webhook limiter — Stripe webhooks.
 * Higher limit since Stripe can send bursts, but still bounded.
 */
/**
 * ROI calculator submission limiter — Final Addendum §13.
 *
 * Public endpoint, no auth — the only friction against bot floods
 * is this limiter. 20/hour per IP matches the brief verbatim and
 * is generous enough for a real prospect retrying a few times,
 * tight enough that an automated scraper can't generate hundreds
 * of synthetic "leads" overnight.
 *
 * Backed by Redis (see makeRedisStore above) so the cap is
 * fleet-wide, not per-container.
 */
export const roiCalculatorLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore("rl:roi-calc:"),
  message: {
    status: 429,
    message:
      "You've submitted a lot of ROI calculations recently. Try again in an hour, or email hello@ambertraining.co.uk and we'll help directly.",
  },
});

export const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 50, // 50 per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many webhook requests.",
  },
});

/**
 * Referral token verification limiter — POST /api/esol/verify-token.
 *
 * Prevents brute-force of org referral JWTs. A signed JWT is essentially
 * uncrackable by chance, but token-enumeration via guessed (or leaked-
 * and-deactivated) tokens is still a real concern. 20/hour per IP is
 * generous enough for a learner who fat-fingers a few false starts,
 * tight enough that a scripted enumerator gives up.
 */
export const referralTokenLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 attempts per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message:
      "Too many invitation-link verification attempts. Please try again in an hour.",
  },
});

/**
 * AI tutor turn limiter — POST /api/esol/session/turn.
 *
 * Brief Function 7 To-Do 7: 80 turns per IP per hour.
 *
 * Each turn triggers one Gemini call (real money + upstream slot) so
 * we cap aggressively. 80/hour averages out to roughly one turn every
 * 45 seconds sustained — enough for an engaged learner working through
 * a 20-turn scenario, restrictive enough that a scripted abuser hits
 * the ceiling within minutes.
 *
 * Multi-instance: backed by Redis so all API containers share the same
 * counter. Per-IP, not per-user — a shared classroom IP with multiple
 * concurrent learners can brush the limit; if that pattern surfaces in
 * prod, the fix is a custom `keyGenerator` switching to per-learner.
 *
 * The message is in English — the frontend localises before display.
 */
export const aiTurnLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore("rl:ai-turn:"),
  message: {
    status: 429,
    message:
      "You have reached the hourly limit for AI tutor turns. Please try again later.",
  },
});

/**
 * Session start limiter — POST /api/esol/session/start.
 *
 * Brief Function 7 To-Do 7: 5 session starts per IP per day.
 *
 * One session ≈ 20 turns, so this caps a single IP at ≈ 100 turns/day
 * of *new* sessions. Reasonable ceiling — even a daily power-learner
 * doing five 30-minute sessions in a single day is fine; the script
 * that mass-creates sessions to drain the AddHours budget is not.
 *
 * Multi-instance: same Redis-backed store as aiTurnLimiter.
 *
 * The message is in English — the frontend localises before display.
 */
export const sessionStartLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore("rl:session-start:"),
  message: {
    status: 429,
    message:
      "You have reached the daily limit for new sessions. Please try again tomorrow.",
  },
});
