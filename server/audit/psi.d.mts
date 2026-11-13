// Type declarations for psi.mjs (Google PageSpeed Insights v5 helper).

export declare const PSI_ENDPOINT: string;
export declare const PSI_CATEGORY_PARAMS: string[];
export declare const PSI_CATEGORY_IDS: ['performance', 'seo', 'accessibility', 'best-practices'];
export declare const PSI_TIMEOUT_MS: number;

export interface PsiResult {
  strategy: 'mobile';
  categories: {
    performance: number | null;
    seo: number | null;
    accessibility: number | null;
    'best-practices': number | null;
  };
  metrics: {
    lcpMs: number | null;
    cls: number | null;
    tbtMs: number | null;
    fcpMs: number | null;
    speedIndexMs: number | null;
    inpMs: number | null;
  };
  display: { lcp: string | null; cls: string | null; tbt: string | null; fcp: string | null };
  fieldDataCategory: string | null;
  lighthouseVersion: string | null;
  fetchTime: string | null;
}

export declare function buildPsiUrl(targetUrl: string, apiKey?: string): URL;

export declare function parsePsiResponse(body: unknown): { ok: true; psi: PsiResult } | { ok: false; reason: string };

export type PsiFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

/** Never throws. The API key is never included in `reason`. */
export declare function runPsi(
  targetUrl: string,
  options?: { apiKey?: string; fetchImpl?: PsiFetch; timeoutMs?: number },
): Promise<{ psi: PsiResult | null; reason: string | null }>;
