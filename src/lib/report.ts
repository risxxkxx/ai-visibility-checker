import type { AuditStatus, BusinessInput, EngineAnswer, EngineStatus, KnownFacts, SiteAudit, VisibilityReport } from './types.ts';
import { analyzeAnswers, topCitedDomains } from './analyze.ts';
import { computeScore, computeShareOfVoice } from './scoring.ts';
import { buildRecommendations } from './recommendations.ts';
import { checkFacts, hasKnownFacts } from './facts.ts';
import { computeReadiness } from './readiness.ts';

export interface BuildReportInput {
  business: BusinessInput;
  prompts: string[];
  engines: EngineStatus[];
  answers: EngineAnswer[];
  demo: boolean;
  generatedAt?: string;
  facts?: KnownFacts | null;
  audit?: SiteAudit | null;
  auditStatus?: AuditStatus;
  auditError?: string | null;
}

/** Runs the whole analysis pipeline on raw answers. Pure: same input, same report. */
export function buildReport(input: BuildReportInput): VisibilityReport {
  const analyses = analyzeAnswers(input.answers, input.business);
  const score = computeScore(analyses);
  const shareOfVoice = computeShareOfVoice(analyses, input.business);
  const cited = topCitedDomains(input.answers);
  const knownFacts = hasKnownFacts(input.facts) ? input.facts : null;
  const audit = input.audit ?? null;
  const auditStatus: AuditStatus = audit ? 'done' : (input.auditStatus ?? 'off');
  const factCheck = checkFacts({ business: input.business, facts: knownFacts, answers: input.answers, analyses });
  const readiness = computeReadiness(audit, input.business, knownFacts);
  const recommendations = buildRecommendations({
    business: input.business,
    analyses,
    score,
    shareOfVoice,
    topCitedDomains: cited,
    audit,
    auditStatus,
    factCheck,
    facts: knownFacts,
  });
  return {
    version: 2,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    demo: input.demo,
    business: input.business,
    prompts: input.prompts,
    engines: input.engines,
    answers: input.answers,
    analyses,
    score,
    shareOfVoice,
    topCitedDomains: cited,
    knownFacts,
    factCheck,
    audit,
    auditStatus,
    auditError: input.auditError ?? null,
    readiness,
    recommendations,
  };
}
