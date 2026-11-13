import type { EngineId, EngineStatus } from '../src/lib/types.ts';
import { ENGINE_IDS, ENGINE_LABELS } from '../src/lib/types.ts';

/** Defaults checked against provider docs in Nov 2026. Override with env vars; models change often. */
export const DEFAULT_MODELS: Record<EngineId, string> = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-6-luna',
  perplexity: 'sonar',
  gemini: 'gemini-3.8-flash',
};

/** Previous-generation Flash model: usually less busy when the newest one answers "high demand". */
export const DEFAULT_GEMINI_FALLBACK = 'gemini-3.7-flash';

export interface EngineConfig {
  id: EngineId;
  apiKey: string;
  model: string;
}

export interface ServerConfig {
  engines: Partial<Record<EngineId, EngineConfig>>;
  timeoutMs: number;
  maxOutputTokens: number;
  openaiReasoningEffort: string;
  openaiWebSearch: boolean;
  perplexityUrl: string;
  /** Adds the google_search tool (Grounding with Google Search), closer to the consumer Gemini app. */
  geminiGrounding: boolean;
  /** Sent as generationConfig.thinkingConfig.thinkingLevel; empty omits it. */
  geminiThinkingLevel: string;
  /** Tried when the main Gemini model is busy (429/5xx). Empty disables the fallback. */
  geminiFallbackModel: string;
  rateLimitRequests: number;
  rateLimitWindowMs: number;
}

type Env = Record<string, string | undefined>;

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const KEY_VARS: Record<EngineId, [key: string, model: string]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'],
  openai: ['OPENAI_API_KEY', 'OPENAI_MODEL'],
  perplexity: ['PERPLEXITY_API_KEY', 'PERPLEXITY_MODEL'],
  gemini: ['GEMINI_API_KEY', 'GEMINI_MODEL'],
};

export function loadConfig(env: Env = process.env): ServerConfig {
  const engines: ServerConfig['engines'] = {};
  for (const id of ENGINE_IDS) {
    const [keyVar, modelVar] = KEY_VARS[id];
    const apiKey = env[keyVar]?.trim();
    const model = (env[modelVar]?.trim() || DEFAULT_MODELS[id]).replace(/^models\//, '');
    if (apiKey) engines[id] = { id, apiKey, model };
  }
  return {
    engines,
    timeoutMs: int(env.ENGINE_TIMEOUT_MS, 20_000, 2_000, 28_000),
    maxOutputTokens: int(env.MAX_OUTPUT_TOKENS, 900, 200, 4_000),
    openaiReasoningEffort: (env.OPENAI_REASONING_EFFORT ?? 'low').trim(),
    openaiWebSearch: env.OPENAI_WEB_SEARCH?.trim().toLowerCase() === 'true',
    perplexityUrl: env.PERPLEXITY_API_URL?.trim() || 'https://api.perplexity.ai/v1/sonar',
    geminiGrounding: env.GEMINI_GROUNDING?.trim().toLowerCase() === 'true',
    geminiThinkingLevel: (env.GEMINI_THINKING_LEVEL ?? 'low').trim().toLowerCase(),
    geminiFallbackModel: (env.GEMINI_FALLBACK_MODEL ?? DEFAULT_GEMINI_FALLBACK).trim().replace(/^models\//, ''),
    rateLimitRequests: int(env.RATE_LIMIT_REQUESTS, 45, 1, 1_000),
    rateLimitWindowMs: int(env.RATE_LIMIT_WINDOW_MS, 15 * 60_000, 10_000, 24 * 60 * 60_000),
  };
}

/** Public engine list. Never includes keys. */
export function engineStatuses(config: ServerConfig): EngineStatus[] {
  return ENGINE_IDS.map((id) => {
    const engine = config.engines[id];
    return { id, label: ENGINE_LABELS[id], available: Boolean(engine), model: engine?.model ?? null };
  });
}
