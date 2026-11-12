import type { BusinessInput, EngineAnswer, EngineStatus, VisibilityReport } from './types.ts';
import { analyzeAnswers, topCitedDomains } from './analyze.ts';
import { computeScore, computeShareOfVoice } from './scoring.ts';
import { buildRecommendations } from './recommendations.ts';

export interface BuildReportInput {
  business: BusinessInput;
  prompts: string[];
  engines: EngineStatus[];
  answers: EngineAnswer[];
  demo: boolean;
  generatedAt?: string;
}

/** Runs the whole analysis pipeline on raw answers. Pure: same input, same report. */
export function buildReport(input: BuildReportInput): VisibilityReport {
  const analyses = analyzeAnswers(input.answers, input.business);
  const score = computeScore(analyses);
  const shareOfVoice = computeShareOfVoice(analyses, input.business);
  const cited = topCitedDomains(input.answers);
  const recommendations = buildRecommendations({
    business: input.business,
    analyses,
    score,
    shareOfVoice,
    topCitedDomains: cited,
  });
  return {
    version: 1,
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
    recommendations,
  };
}
