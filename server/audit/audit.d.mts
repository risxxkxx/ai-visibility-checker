// Type declarations for audit.mjs (pure HTML analysis; no network access).
import type { PsiResult } from './psi.mjs';

export type Severity = 'critical' | 'important' | 'minor';

export declare const SEVERITY_ORDER: Severity[];
export declare const SEVERITY_WEIGHTS: Record<Severity, number>;
export declare const LIMITS: Record<string, number>;

export interface TagMatch {
  attrs: Record<string, string>;
  index: number;
}

export interface StructuredDataSummary {
  types: string[];
  hasBusiness: boolean;
  invalidBlocks: number;
}

export interface HtmlFacts {
  finalUrl: string;
  isHttps: boolean;
  viewport: { present: boolean; content: string | null; deviceWidth: boolean };
  title: { text: string; length: number } | null;
  metaDescription: { text: string; length: number } | null;
  h1Count: number;
  lang: string;
  structuredData: StructuredDataSummary;
  openGraph: { title: string | null; description: string | null; image: string | null; missing: string[] };
  favicon: boolean;
  telLinks: number;
  images: { total: number; missingAlt: number };
  mixedContent: { count: number; examples: string[] };
  htmlBytes: number;
  truncated: boolean;
  copyright: { year: number; snippet: string; where: string; outdated: boolean } | null;
  cms: { name: string; version: string | null; source: string; raw: string | null } | null;
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  explanation: string;
  evidence: string;
  source: 'html' | 'network' | 'psi';
}

export declare function stripComments(html: string): string;
export declare function decodeEntities(text: string): string;
export declare function parseAttributes(source: string): Record<string, string>;
export declare function findTags(html: string, tagName: string): TagMatch[];
export declare function detectStructuredData(html: string): StructuredDataSummary;
export declare function analyzeHtml(
  rawHtml: string,
  ctx?: { finalUrl?: string; byteLength?: number; truncated?: boolean; now?: Date },
): HtmlFacts;
export declare function buildFindings(facts: HtmlFacts, extras?: Record<string, unknown>): Finding[];
export declare function psiFindings(psi: PsiResult | null): Finding[];
export declare function computeScore(
  findings: Pick<Finding, 'severity' | 'source'>[],
  psi: PsiResult | null,
): { score: number; technicalScore: number; psiScore: number | null; opportunity: string };
