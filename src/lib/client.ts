import type { EngineAnswer, EngineId, EngineStatus } from './types.ts';
import { ENGINE_IDS, ENGINE_LABELS } from './types.ts';

const OFFLINE: EngineStatus[] = ENGINE_IDS.map((id) => ({ id, label: ENGINE_LABELS[id], available: false, model: null }));

/** Asks the server which engines have keys. Falls back to "none" when the function is not running. */
export async function fetchEngines(signal?: AbortSignal): Promise<{ engines: EngineStatus[]; reachable: boolean }> {
  try {
    const res = await fetch('/api/engines', { signal, headers: { accept: 'application/json' } });
    if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) {
      return { engines: OFFLINE, reachable: false };
    }
    const data = (await res.json()) as { engines?: EngineStatus[] };
    return { engines: Array.isArray(data.engines) ? data.engines : OFFLINE, reachable: true };
  } catch {
    return { engines: OFFLINE, reachable: false };
  }
}

export class AskError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function askOne(prompt: string, engines: EngineId[], runId: string, signal: AbortSignal): Promise<EngineAnswer[]> {
  const res = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, engines, runId }),
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as { answers?: EngineAnswer[]; error?: string };
  if (!res.ok) throw new AskError(data.error ?? `Request failed (HTTP ${res.status})`, res.status);
  return data.answers ?? [];
}

export interface RunOptions {
  prompts: string[];
  engines: EngineId[];
  concurrency?: number;
  signal: AbortSignal;
  onAnswers: (answers: EngineAnswer[]) => void;
}

/**
 * Sends each prompt to the server (which fans out to the engines) with limited concurrency.
 * A failing prompt becomes failed answers instead of stopping the run, except for
 * rate-limit errors, which stop the run because every later request would fail too.
 */
export async function runCheck({ prompts, engines, concurrency = 3, signal, onAnswers }: RunOptions): Promise<void> {
  const runId = crypto.randomUUID();
  let next = 0;
  let fatal: AskError | null = null;

  const worker = async () => {
    while (next < prompts.length && !signal.aborted && !fatal) {
      const prompt = prompts[next++]!;
      try {
        onAnswers(await askOne(prompt, engines, runId, signal));
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof AskError && err.status === 429) {
          fatal = err;
          return;
        }
        const message = err instanceof Error ? err.message : 'Request failed';
        onAnswers(
          engines.map((engine) => ({ engine, model: '', prompt, ok: false, text: '', citations: [], error: message, latencyMs: 0 })),
        );
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, prompts.length) }, worker));
  if (fatal) throw fatal;
}
