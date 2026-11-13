import type { ReportLanguage, Snippet, VisibilityReport } from './types.ts';
import { ENGINE_LABELS } from './types.ts';
import { answerNeedles, highlight, plainAnswer } from './highlight.ts';
import { WEIGHTS } from './scoring.ts';
import {
  BAND_TEXT,
  CHECK_STATE_TEXT,
  CLAIM_KIND_TEXT,
  CLAIM_STATUS_TEXT,
  formatDate,
  NAME_KIND_TEXT,
  PRIORITY_TEXT,
  t,
} from './i18n.ts';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const e = escapeHtml;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const rank = (n: number | null) => (n === null ? '–' : String(Math.round(n * 10) / 10));

export function reportFileName(report: VisibilityReport, ext: 'json' | 'html', lang: ReportLanguage = 'en'): string {
  const slug =
    report.business.name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'business';
  const date = report.generatedAt.slice(0, 10);
  return `ai-visibility-${slug}-${date}${report.demo ? '-demo' : ''}${ext === 'html' && lang === 'mk' ? '-mk' : ''}.${ext}`;
}

/** The full report as JSON. Text that differs by language is stored in both ({ en, mk }). */
export function reportToJson(report: VisibilityReport): string {
  return JSON.stringify(report, null, 2);
}

/** Splits snippet text into escaped HTML with <mark> around the claim and the brand. */
export function snippetHtml(snippet: Snippet): string {
  let out = '';
  let cursor = 0;
  for (const h of snippet.highlights) {
    if (h.start < cursor) continue;
    out += e(snippet.text.slice(cursor, h.start));
    out += `<mark class="${h.kind === 'claim' ? 'claim' : 'you'}">${e(snippet.text.slice(h.start, h.end))}</mark>`;
    cursor = h.end;
  }
  return out + e(snippet.text.slice(cursor));
}

function cell(report: VisibilityReport, prompt: string, engine: string, lang: ReportLanguage): string {
  const a = report.analyses.find((x) => x.prompt === prompt && x.engine === engine);
  if (!a) return '<td class="c c-none"></td>';
  if (!a.ok) return `<td class="c c-fail">${e(t(lang, 'cellFailed'))}</td>`;
  if (!a.mentioned) return '<td class="c c-miss">–</td>';
  if (a.position !== null) return `<td class="c ${a.position <= 3 ? 'c-top' : 'c-named'}">#${a.position}</td>`;
  return `<td class="c c-named">${e(t(lang, 'cellNamed'))}</td>`;
}

function factsSection(report: VisibilityReport, lang: ReportLanguage): string {
  const fc = report.factCheck;
  if (fc.answersChecked === 0) return `<p class="muted">${e(t(lang, 'factsNotNamed'))}</p>`;
  const parts: string[] = [`<p class="muted">${e(t(lang, 'factsLede'))}</p>`];
  if (!report.knownFacts) parts.push(`<p class="muted">${e(t(lang, 'factsNoFacts'))}</p>`);
  if (fc.rows.length > 0) {
    parts.push(`<table class="facts">
      <thead><tr><th>${e(t(lang, 'fact'))}</th><th>${e(t(lang, 'yourValue'))}</th><th>${e(t(lang, 'status'))}</th><th>${e(t(lang, 'engines'))}</th></tr></thead>
      <tbody>${fc.rows
        .map(
          (r) =>
            `<tr class="st-${r.status}"><th>${e(r.label[lang])}</th><td>${e(r.expected[lang])}</td><td>${e(CLAIM_STATUS_TEXT[r.status][lang])}${
              r.correct + r.wrong > 1 ? ` <span class="muted">(${r.correct}✓ ${r.wrong}✗)</span>` : ''
            }</td><td>${e(r.engines.map((x) => ENGINE_LABELS[x]).join(', ') || '–')}</td></tr>`,
        )
        .join('')}</tbody>
    </table>`);
  }
  if (fc.claims.length === 0) parts.push(`<p class="muted">${e(t(lang, 'factsNone'))}</p>`);
  else {
    parts.push(`<h3>${e(t(lang, 'whatAiSaid'))}</h3><ul class="claims">${fc.claims
      .map(
        (c) =>
          `<li class="st-${c.status}"><strong>${e(ENGINE_LABELS[c.engine])}</strong> · ${e(CLAIM_KIND_TEXT[c.kind][lang])} · <span class="st">${e(
            CLAIM_STATUS_TEXT[c.status][lang],
          )}</span><br><span class="snippet">${snippetHtml(c.snippet)}</span></li>`,
      )
      .join('')}</ul>`);
  }
  if (fc.nameVariants.length > 0) {
    parts.push(`<h3>${e(t(lang, 'namesTitle'))}</h3><ul>${fc.nameVariants
      .map(
        (v) =>
          `<li${v.kind === 'other' ? ' class="st-possibly-wrong"' : ''}>“${e(v.name)}” <span class="muted">${e(NAME_KIND_TEXT[v.kind][lang])} · ${v.count}× · ${e(
            v.engines.map((x) => ENGINE_LABELS[x]).join(', '),
          )}</span></li>`,
      )
      .join('')}</ul>`);
  }
  return parts.join('\n');
}

function auditSection(report: VisibilityReport, lang: ReportLanguage): string {
  const a = report.audit;
  if (!a) {
    const msg =
      report.auditStatus === 'failed'
        ? `${t(lang, 'auditFailed')} ${report.auditError ?? ''}`
        : report.auditStatus === 'no-domain'
          ? t(lang, 'auditNoDomain')
          : t(lang, 'auditOff');
    return `<p class="muted">${e(msg)}</p>`;
  }
  const rows = report.readiness.checks
    .map(
      (c) =>
        `<tr class="ck-${c.state}"><th>${e(c.label[lang])}</th><td>${e(CHECK_STATE_TEXT[c.state][lang])}</td><td>${e(c.detail[lang])}</td></tr>`,
    )
    .join('');
  const psi = a.psi
    ? `<p>${e(t(lang, 'pagespeed'))}: Performance ${a.psi.performance ?? '–'}/100 · SEO ${a.psi.seo ?? '–'}/100${
        a.psi.lcpMs ? ` · LCP ${(a.psi.lcpMs / 1000).toFixed(1)} s` : ''
      }</p>`
    : `<p class="muted">${e(a.psiStatus === 'failed' ? t(lang, 'pagespeedFailed') : t(lang, 'pagespeedOff'))}</p>`;
  return `<p class="muted">${e(t(lang, 'auditLede'))} <a href="${e(a.finalUrl)}">${e(a.finalUrl)}</a></p>
  <table class="checks"><thead><tr><th>${e(t(lang, 'check'))}</th><th>${e(t(lang, 'status'))}</th><th>${e(t(lang, 'result'))}</th></tr></thead><tbody>${rows}</tbody></table>
  ${a.brandNames.length ? `<p>${e(t(lang, 'namesOnSite'))}: ${a.brandNames.map((b) => `“${e(b.value)}” <span class="muted">(${e(b.source)})</span>`).join(', ')}</p>` : ''}
  ${psi}`;
}

/** A self-contained, printable HTML report in English or Macedonian. Every dynamic value is escaped. */
export function reportToHtml(report: VisibilityReport, lang: ReportLanguage = 'en'): string {
  const b = report.business;
  const s = report.score;
  const engines = report.engines.filter((x) => x.available);
  const tx = (k: Parameters<typeof t>[1]) => e(t(lang, k));

  const demoNote = report.demo ? `<p class="demo"><strong>${tx('demoTag')}.</strong> ${tx('demoNote')}</p>` : '';

  const matrix = `
    <table class="matrix">
      <thead><tr><th>${tx('prompt')}</th>${engines.map((x) => `<th>${e(ENGINE_LABELS[x.id])}</th>`).join('')}</tr></thead>
      <tbody>${report.prompts
        .map((p) => `<tr><th>${e(p)}</th>${engines.map((x) => cell(report, p, x.id, lang)).join('')}</tr>`)
        .join('')}</tbody>
    </table>`;

  const sov = `
    <table class="sov">
      <thead><tr><th>${tx('business')}</th><th>${tx('mentions')}</th><th>${tx('share')}</th><th>${tx('avgRank')}</th></tr></thead>
      <tbody>${report.shareOfVoice
        .map(
          (r) =>
            `<tr${r.isYou ? ' class="you"' : ''}><th>${e(r.name)}${r.isYou ? ` (${tx('you')})` : ''}</th><td>${r.mentions}</td><td>${pct(r.share)}</td><td>${rank(
              r.averagePosition,
            )}</td></tr>`,
        )
        .join('')}</tbody>
    </table>`;

  const sources =
    report.topCitedDomains.length === 0
      ? `<p class="muted">${tx('noSources')}</p>`
      : `<ol>${report.topCitedDomains.map((d) => `<li>${e(d.domain)} <span class="muted">(${d.count})</span></li>`).join('')}</ol>`;

  const recHtml = (r: VisibilityReport['recommendations'][number]) => `
      <section class="rec rec-${r.status === 'done' ? 'done' : r.priority}">
        <h3>${e(r.title[lang])} <span class="pri">${e(PRIORITY_TEXT[r.status === 'done' ? 'done' : r.priority][lang])}</span></h3>
        ${r.why.map((w) => `<p>${e(w[lang])}</p>`).join('')}
        ${r.steps.length ? `<ul>${r.steps.map((step) => `<li>${e(step[lang])}</li>`).join('')}</ul>` : ''}
        ${r.snippet ? `<p class="muted">${e(r.snippet.label[lang])}</p><pre><code>${e(r.snippet.code)}</code></pre>` : ''}
      </section>`;
  const todo = report.recommendations.filter((r) => r.status === 'todo').map(recHtml).join('');
  const done = report.recommendations.filter((r) => r.status === 'done');

  const answers = report.analyses
    .map((a, i) => {
      const answer = report.answers[i]!;
      let body: string;
      if (!answer.ok) {
        body = `<p class="fail">${e(answer.error ?? t(lang, 'callFailed'))}</p>`;
      } else {
        const text = plainAnswer(answer.text);
        body = `<div class="transcript">${highlight(text, answerNeedles(b, a, text))
          .map((seg) => (seg.kind ? `<mark class="${seg.kind}">${e(seg.text)}</mark>` : e(seg.text)))
          .join('')}</div>`;
      }
      const cites =
        answer.citations.length > 0
          ? `<p class="muted cites">${tx('sources')}: ${answer.citations.slice(0, 10).map((u) => e(u)).join(', ')}</p>`
          : '';
      return `<article class="answer"><h3>${e(ENGINE_LABELS[a.engine])}${answer.model ? ` <span class="muted">${e(answer.model)}</span>` : ''}: ${e(
        a.prompt,
      )}</h3>${body}${cites}</article>`;
    })
    .join('');

  const acc = report.factCheck.accuracy;
  const rd = report.readiness;

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(`${t(lang, 'reportTitle')}: ${b.name}${report.demo ? ` (${t(lang, 'demoTag')})` : ''}`)}</title>
<style>
  :root { --ink:#16224a; --muted:#5d6787; --line:#d3dae8; --marker:#ffe14d; --rival:#d6e4ff; --named:#1d7a5f; --miss:#b0365a; --warn:#fde3c8; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--ink); margin: 0 auto; max-width: 900px; padding: 32px 24px; line-height: 1.5; }
  h1 { font-size: 28px; line-height: 1.15; margin: 0 0 6px; }
  h2 { font-size: 18px; margin: 32px 0 10px; padding-top: 12px; border-top: 2px solid var(--ink); }
  h3 { font-size: 15px; margin: 12px 0 4px; }
  .muted { color: var(--muted); }
  .demo { border: 2px dashed var(--ink); padding: 10px 14px; border-radius: 8px; }
  .score { display: flex; gap: 32px; align-items: flex-end; flex-wrap: wrap; }
  .score .num { font-size: 64px; font-weight: 800; line-height: 1; }
  .score .num small { font-size: 18px; color: var(--muted); font-weight: 500; }
  .score dl { margin: 0; display: grid; grid-template-columns: auto auto; gap: 2px 16px; font-size: 14px; }
  .score dt { color: var(--muted); }
  .score dd { margin: 0; font-weight: 600; }
  .subs { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 16px; }
  .sub { border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; min-width: 200px; }
  .sub b { font-size: 26px; display: block; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px 6px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  thead th { color: var(--muted); font-weight: 600; }
  tbody th { font-weight: 400; }
  .c { text-align: center; font-weight: 700; width: 80px; }
  .c-top { background: var(--named); color: #fff; }
  .c-named { color: var(--named); }
  .c-miss { color: var(--muted); }
  .c-fail { color: var(--miss); }
  .sov .you th { font-weight: 700; }
  .st-correct td:nth-child(3), .ck-pass td:nth-child(2) { color: var(--named); font-weight: 600; }
  .st-possibly-wrong td:nth-child(3), .ck-fail td:nth-child(2), li.st-possibly-wrong .st { color: var(--miss); font-weight: 600; }
  .claims { padding-left: 18px; }
  .claims li { margin-bottom: 8px; }
  .snippet { font-size: 13px; }
  .rec { border-left: 4px solid var(--line); padding: 4px 0 4px 12px; margin: 0 0 14px; break-inside: avoid; }
  .rec-high { border-color: var(--miss); }
  .rec-medium { border-color: #d9a400; }
  .rec-done { border-color: var(--named); }
  .rec p { margin: 0 0 4px; }
  .rec ul { margin: 0; padding-left: 18px; font-size: 14px; }
  pre { background: #f3f5fa; padding: 10px; border-radius: 6px; font-size: 11px; white-space: pre-wrap; word-break: break-word; }
  .pri { font-size: 11px; font-weight: 600; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; }
  .answer { border-top: 1px solid var(--line); padding: 10px 0; break-inside: avoid; }
  .transcript { white-space: pre-wrap; font-size: 13px; }
  .fail { color: var(--miss); }
  .cites { font-size: 11px; word-break: break-all; }
  mark.you { background: var(--marker); font-weight: 600; }
  mark.competitor { background: var(--rival); }
  mark.claim { background: var(--warn); font-weight: 600; }
  mark, .c-top { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  footer { margin-top: 32px; font-size: 12px; color: var(--muted); }
  @media print { body { padding: 0; } h2.answers { break-before: page; } }
</style>
</head>
<body>
<header>
  <h1>${tx('reportTitle')}: ${e(b.name)}</h1>
  <p class="muted">${e(b.category)} ${tx('in')} ${e(b.city)}${b.country ? `, ${e(b.country)}` : ''}${b.domain ? `. ${tx('website')}: ${e(b.domain)}` : ''}<br>${tx('runOn')} ${e(
    formatDate(report.generatedAt, lang),
  )}</p>
</header>
${demoNote}
<h2>${tx('scoreTitle')}</h2>
<div class="score">
  <div class="num">${s.band === 'no-data' ? '–' : s.score}<small>/100</small></div>
  <dl>
    <dt>${tx('mentionRate')} (× ${WEIGHTS.mention})</dt><dd>${pct(s.mentionRate)}, ${s.mentionedCount} ${tx('of')} ${s.answered} ${tx('answersWord')}</dd>
    <dt>${tx('position')} (× ${WEIGHTS.position})</dt><dd>${pct(s.positionScore)}${s.averagePosition !== null ? `, ${tx('averageRank')} ${rank(s.averagePosition)}` : ''}</dd>
    <dt>${tx('coverage')} (× ${WEIGHTS.coverage})</dt><dd>${pct(s.engineCoverage)}, ${s.enginesMentioning} ${tx('of')} ${s.enginesAnswered} ${tx('enginesWord')}</dd>
  </dl>
</div>
<p>${e(BAND_TEXT[s.band][lang])}</p>
<div class="subs">
  <div class="sub">${tx('accuracy')}<b>${acc.score === null ? '–' : `${acc.score}%`}</b><span class="muted">${
    acc.score === null ? tx('accuracyNone') : `${acc.correct} ✓ · ${acc.wrong} ✗ · ${tx('accuracyHelp')}`
  }</span></div>
  <div class="sub">${tx('readiness')}<b>${rd.score === null ? '–' : `${rd.score}/100`}</b><span class="muted">${rd.score === null ? tx('readinessNone') : tx('readinessHelp')}</span></div>
</div>
<p class="muted">${tx('notBlended')}</p>
<h2>${tx('recsTitle')}</h2>
<p class="muted">${tx('recsLede')}</p>
${todo}
${done.length ? `<h3>${tx('doneTitle')}</h3>${done.map(recHtml).join('')}` : ''}
<h2>${tx('factsTitle')}</h2>
${factsSection(report, lang)}
<h2>${tx('auditTitle')}</h2>
${auditSection(report, lang)}
<h2>${tx('matrixTitle')}</h2>
${matrix}
<h2>${tx('sovTitle')}</h2>
${sov}
<h2>${tx('sourcesTitle')}</h2>
${sources}
<h2 class="answers">${tx('answersTitle')}</h2>
${answers}
<footer>
  <p>${tx('footer')}</p>
</footer>
</body>
</html>
`;
}
