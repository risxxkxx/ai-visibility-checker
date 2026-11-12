import type { AnswerAnalysis, BusinessInput, CompetitorHit, EngineAnswer } from './types.ts';
import { detectMention, mentions } from './mention.ts';
import { extractLists, findPosition } from './lists.ts';
import { hostMatchesDomain, hostOf, normalizeDomain } from './normalize.ts';

/** Turns one raw engine answer into structured facts about the business and its competitors. */
export function analyzeAnswer(answer: EngineAnswer, business: BusinessInput): AnswerAnalysis {
  const base = {
    engine: answer.engine,
    prompt: answer.prompt,
    citations: answer.citations,
  };
  const domain = normalizeDomain(business.domain);
  const domainCited =
    domain !== '' &&
    answer.citations.some((url) => {
      const host = hostOf(url);
      return host !== null && hostMatchesDomain(host, domain);
    });

  if (!answer.ok) {
    return {
      ...base,
      ok: false,
      mentioned: false,
      matchType: null,
      matchedText: null,
      position: null,
      listLength: 0,
      competitors: [],
      domainCited,
    };
  }

  const target = { name: business.name, aliases: business.aliases, domain };
  const mention = detectMention(answer.text, target);
  const lists = extractLists(answer.text);
  const { position, listLength } = mention.mentioned
    ? findPosition(lists, (t) => mentions(t, target))
    : { position: null, listLength: lists.reduce((n, l) => Math.max(n, l.length), 0) };

  const competitors: CompetitorHit[] = [];
  for (const name of business.competitors) {
    if (!name.trim()) continue;
    if (!mentions(answer.text, { name })) continue;
    const hit = findPosition(lists, (t) => mentions(t, { name }));
    competitors.push({ name, position: hit.position });
  }

  return {
    ...base,
    ok: true,
    mentioned: mention.mentioned,
    matchType: mention.matchType,
    matchedText: mention.matchedText,
    position,
    listLength,
    competitors,
    domainCited,
  };
}

export function analyzeAnswers(answers: EngineAnswer[], business: BusinessInput): AnswerAnalysis[] {
  return answers.map((a) => analyzeAnswer(a, business));
}

/** Most-cited source domains across all answers, so the owner knows where to get listed. */
export function topCitedDomains(answers: EngineAnswer[], limit = 10): { domain: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const a of answers) {
    const seen = new Set<string>();
    for (const url of a.citations) {
      const host = hostOf(url);
      if (!host || seen.has(host)) continue;
      seen.add(host);
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, limit);
}
