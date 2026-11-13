import type { EngineAnswer, EngineId, EngineStatus, SiteAudit } from './types.ts';
import { ENGINE_IDS, ENGINE_LABELS } from './types.ts';

const ACCESS_STORAGE_KEY = 'avc.accessCode';

/** The owner's access code, kept in this browser only. Storage can throw (privacy modes), so it's guarded. */
export function getAccessCode(): string {
  try {
    return localStorage.getItem(ACCESS_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAccessCode(code: string): void {
  try {
    if (code) localStorage.setItem(ACCESS_STORAGE_KEY, code);
    else localStorage.removeItem(ACCESS_STORAGE_KEY);
  } catch {
    /* not persisted; still used for this page via the caller's state */
  }
}

const authHeaders = (code: string): Record<string, string> => (code ? { 'x-access-code': code } : {});

const OFFLINE: EngineStatus[] = ENGINE_IDS.map((id) => ({ id, label: ENGINE_LABELS[id], available: false, model: null }));

/** Asks the server which engines have keys. Falls back to "none" when the function is not running. */
export async function fetchEngines(
  signal?: AbortSignal,
): Promise<{ engines: EngineStatus[]; reachable: boolean; accessConfigured: boolean }> {
  try {
    const res = await fetch('/api/engines', { signal, headers: { accept: 'application/json' } });
    if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) {
      return { engines: OFFLINE, reachable: false, accessConfigured: false };
    }
    const data = (await res.json()) as { engines?: EngineStatus[]; accessConfigured?: boolean };
    return {
      engines: Array.isArray(data.engines) ? data.engines : OFFLINE,
      reachable: true,
      accessConfigured: data.accessConfigured === true,
    };
  } catch {
    return { engines: OFFLINE, reachable: false, accessConfigured: false };
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

async function askOne(
  prompt: string,
  engines: EngineId[],
  runId: string,
  signal: AbortSignal,
  accessCode: string,
): Promise<EngineAnswer[]> {
  const res = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(accessCode) },
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
  accessCode?: string;
}

/**
 * Sends each prompt to the server (which fans out to the engines) with limited concurrency.
 * A failing prompt becomes failed answers instead of stopping the run, except for
 * rate-limit errors, which stop the run because every later request would fail too.
 */
export async function runCheck({ prompts, engines, concurrency = 3, signal, onAnswers, accessCode = '' }: RunOptions): Promise<void> {
  const runId = crypto.randomUUID();
  let next = 0;
  let fatal: AskError | null = null;

  const worker = async () => {
    while (next < prompts.length && !signal.aborted && !fatal) {
      const prompt = prompts[next++]!;
      try {
        onAnswers(await askOne(prompt, engines, runId, signal, accessCode));
      } catch (err) {
        if (signal.aborted) return;
        // Rate limits, a wrong/missing access code or a locked server fail every later request too.
        if (err instanceof AskError && [401, 429, 503].includes(err.status)) {
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

/** Runs the website audit for a domain. Throws an Error with a readable message on failure. */
export async function auditSite(domain: string, signal?: AbortSignal, accessCode = ''): Promise<SiteAudit> {
  const res = await fetch('/api/audit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(accessCode) },
    body: JSON.stringify({ domain }),
    signal,
  });
  if (!res.headers.get('content-type')?.includes('application/json')) {
    throw new Error('The audit function is not running here (use netlify dev or a Netlify deploy).');
  }
  const data = (await res.json().catch(() => ({}))) as { audit?: SiteAudit; error?: string };
  if (!res.ok || !data.audit) throw new Error(data.error ?? `The audit failed (HTTP ${res.status}).`);
  return data.audit;
}
