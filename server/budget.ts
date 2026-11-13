import type { EngineId } from '../src/lib/types.ts';

type Env = Record<string, string | undefined>;

/** Minimal counter store so the budget logic is testable without Netlify Blobs. */
export interface CounterStore {
  get(key: string): Promise<number>;
  set(key: string, value: number): Promise<void>;
}

/**
 * Default monthly request caps per engine. Gemini's paid tier includes 5,000 grounded
 * requests a month, so 4,500 leaves headroom. Paid engines get a lower default.
 * Override with MONTHLY_LIMIT_<ENGINE> (e.g. MONTHLY_LIMIT_GEMINI=2000); 0 disables an engine.
 */
export const DEFAULT_MONTHLY_LIMITS: Record<EngineId, number> = {
  anthropic: 1_000,
  openai: 1_000,
  perplexity: 1_000,
  gemini: 4_500,
};

/** Separate cap for website audits (each one may call PageSpeed). */
export const DEFAULT_MONTHLY_AUDIT_LIMIT = 300;

/** UTC calendar month, e.g. "2026-11". Counters reset when the month changes. */
export function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

function readLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 1_000_000) : fallback;
}

export function monthlyLimit(engine: EngineId, env: Env): number {
  return readLimit(env[`MONTHLY_LIMIT_${engine.toUpperCase()}`], DEFAULT_MONTHLY_LIMITS[engine]);
}

export function monthlyAuditLimit(env: Env): number {
  return readLimit(env.MONTHLY_LIMIT_AUDIT, DEFAULT_MONTHLY_AUDIT_LIMIT);
}

export interface Reservation<T extends string> {
  allowed: T[];
  blocked: T[];
}

/**
 * Reserves one request per engine before calling it (counted even if the call then fails,
 * so a broken upstream can't be retried past the cap). Engines at their cap are blocked.
 * The store isn't transactional, so concurrent requests can overshoot by a handful;
 * the cap sits below the real limit for that reason, and Google's own quota is the hard stop.
 */
export async function reserve<T extends string>(
  store: CounterStore,
  names: T[],
  limitFor: (name: T) => number,
  now: Date,
): Promise<Reservation<T>> {
  const month = monthKey(now);
  const allowed: T[] = [];
  const blocked: T[] = [];
  for (const name of names) {
    const key = `${month}:${name}`;
    const used = await store.get(key);
    if (used >= limitFor(name)) {
      blocked.push(name);
      continue;
    }
    await store.set(key, used + 1);
    allowed.push(name);
  }
  return { allowed, blocked };
}

/** In-memory store for tests and local runs without Netlify. */
export function memoryCounterStore(): CounterStore & { dump(): Record<string, number> } {
  const data = new Map<string, number>();
  return {
    async get(key) {
      return data.get(key) ?? 0;
    },
    async set(key, value) {
      data.set(key, value);
    },
    dump: () => Object.fromEntries(data),
  };
}

/** Netlify Blobs store (site-wide, survives deploys). Loaded lazily so tests never touch it. */
export function blobsCounterStore(): CounterStore {
  let storePromise: Promise<{ get: (k: string, o: { type: 'json' }) => Promise<unknown>; setJSON: (k: string, v: unknown) => Promise<unknown> }> | null =
    null;
  const store = () => {
    storePromise ??= import('@netlify/blobs').then(({ getStore }) => getStore({ name: 'usage-counters', consistency: 'strong' }));
    return storePromise;
  };
  return {
    async get(key) {
      const value = await (await store()).get(key, { type: 'json' });
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    },
    async set(key, value) {
      await (await store()).setJSON(key, value);
    },
  };
}
