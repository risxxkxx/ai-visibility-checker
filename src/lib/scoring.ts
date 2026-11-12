import type { AnswerAnalysis, BusinessInput, EngineId, ScoreBreakdown, ShareOfVoiceRow } from './types.ts';

/**
 * Visibility score, 0-100:
 *
 *   score = round(100 × (0.5 × M + 0.3 × P + 0.2 × C))
 *
 *   M  mention rate      share of answered prompts that name the business
 *   P  position quality  average of positionValue() over all answered prompts (0 when not named)
 *   C  engine coverage   share of engines that answered and named the business at least once
 *
 * Failed calls are left out of every denominator, so an outage lowers confidence, not the score.
 */
export const WEIGHTS = { mention: 0.5, position: 0.3, coverage: 0.2 } as const;

/** Value of being named at a given rank. See README for the table. */
export function positionValue(analysis: Pick<AnswerAnalysis, 'mentioned' | 'position' | 'listLength'>): number {
  if (!analysis.mentioned) return 0;
  const p = analysis.position;
  if (p === null) {
    // Named in prose. If the answer had a ranked list and we were not in it, that is weaker.
    return analysis.listLength > 0 ? 0.35 : 0.6;
  }
  if (p === 1) return 1;
  if (p === 2) return 0.85;
  if (p === 3) return 0.7;
  if (p === 4) return 0.55;
  if (p === 5) return 0.45;
  if (p <= 10) return 0.3;
  return 0.2;
}

export function scoreBand(score: number): ScoreBreakdown['band'] {
  if (score >= 70) return 'leading';
  if (score >= 45) return 'visible';
  if (score >= 20) return 'emerging';
  return 'invisible';
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function computeScore(analyses: AnswerAnalysis[]): ScoreBreakdown {
  const answered = analyses.filter((a) => a.ok);
  const mentioned = answered.filter((a) => a.mentioned);
  const enginesAnswered = new Set(answered.map((a) => a.engine));
  const enginesMentioning = new Set(mentioned.map((a) => a.engine));

  const n = answered.length;
  const mentionRate = n === 0 ? 0 : mentioned.length / n;
  const positionScore = n === 0 ? 0 : answered.reduce((sum, a) => sum + positionValue(a), 0) / n;
  const engineCoverage = enginesAnswered.size === 0 ? 0 : enginesMentioning.size / enginesAnswered.size;

  const raw = WEIGHTS.mention * mentionRate + WEIGHTS.position * positionScore + WEIGHTS.coverage * engineCoverage;
  const score = Math.round(100 * raw);

  const ranked = mentioned.filter((a) => a.position !== null);
  const averagePosition =
    ranked.length === 0 ? null : round3(ranked.reduce((s, a) => s + (a.position ?? 0), 0) / ranked.length);

  return {
    score,
    band: scoreBand(score),
    mentionRate: round3(mentionRate),
    positionScore: round3(positionScore),
    engineCoverage: round3(engineCoverage),
    answered: n,
    mentionedCount: mentioned.length,
    enginesAnswered: enginesAnswered.size,
    enginesMentioning: enginesMentioning.size,
    averagePosition,
  };
}

/**
 * Share of voice: of all the times the business or a listed competitor was named,
 * what share went to each. Counts one mention per answer per name.
 */
export function computeShareOfVoice(analyses: AnswerAnalysis[], business: BusinessInput): ShareOfVoiceRow[] {
  const answered = analyses.filter((a) => a.ok);
  const rows: ShareOfVoiceRow[] = [];

  const build = (name: string, isYou: boolean, hits: { engine: EngineId; position: number | null }[]) => {
    const ranked = hits.filter((h) => h.position !== null);
    rows.push({
      name,
      isYou,
      mentions: hits.length,
      share: 0,
      averagePosition:
        ranked.length === 0 ? null : round3(ranked.reduce((s, h) => s + (h.position ?? 0), 0) / ranked.length),
      engines: [...new Set(hits.map((h) => h.engine))],
    });
  };

  build(
    business.name,
    true,
    answered.filter((a) => a.mentioned).map((a) => ({ engine: a.engine, position: a.position })),
  );
  for (const competitor of business.competitors) {
    if (!competitor.trim()) continue;
    const hits = answered.flatMap((a) =>
      a.competitors.filter((c) => c.name === competitor).map((c) => ({ engine: a.engine, position: c.position })),
    );
    build(competitor, false, hits);
  }

  const total = rows.reduce((s, r) => s + r.mentions, 0);
  for (const r of rows) r.share = total === 0 ? 0 : round3(r.mentions / total);
  return rows.sort((a, b) => b.mentions - a.mentions || Number(b.isYou) - Number(a.isYou));
}
