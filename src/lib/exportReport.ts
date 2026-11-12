import type { VisibilityReport } from './types.ts';
import { ENGINE_LABELS } from './types.ts';
import { answerNeedles, highlight, plainAnswer } from './highlight.ts';
import { WEIGHTS } from './scoring.ts';

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

export function reportFileName(report: VisibilityReport, ext: 'json' | 'html'): string {
  const slug =
    report.business.name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'business';
  const date = report.generatedAt.slice(0, 10);
  return `ai-visibility-${slug}-${date}${report.demo ? '-demo' : ''}.${ext}`;
}

export function reportToJson(report: VisibilityReport): string {
  return JSON.stringify(report, null, 2);
}

function cell(report: VisibilityReport, prompt: string, engine: string): string {
  const a = report.analyses.find((x) => x.prompt === prompt && x.engine === engine);
  if (!a) return '<td class="c c-none"></td>';
  if (!a.ok) return '<td class="c c-fail">err</td>';
  if (!a.mentioned) return '<td class="c c-miss">–</td>';
  if (a.position !== null) return `<td class="c ${a.position <= 3 ? 'c-top' : 'c-named'}">#${a.position}</td>`;
  return '<td class="c c-named">named</td>';
}

/** A self-contained, printable HTML report. Every dynamic value is escaped. */
export function reportToHtml(report: VisibilityReport): string {
  const b = report.business;
  const s = report.score;
  const engines = report.engines.filter((x) => x.available);
  const date = new Date(report.generatedAt).toUTCString();

  const demoNote = report.demo
    ? `<p class="demo"><strong>Demo data.</strong> Example Studio and its competitors are fictional, and these answers were written for illustration. They did not come from AI engines.</p>`
    : '';

  const matrix = `
    <table class="matrix">
      <thead><tr><th>Prompt</th>${engines.map((x) => `<th>${e(ENGINE_LABELS[x.id])}</th>`).join('')}</tr></thead>
      <tbody>${report.prompts
        .map((p) => `<tr><th>${e(p)}</th>${engines.map((x) => cell(report, p, x.id)).join('')}</tr>`)
        .join('')}</tbody>
    </table>`;

  const sov = `
    <table class="sov">
      <thead><tr><th>Business</th><th>Mentions</th><th>Share</th><th>Avg. rank</th></tr></thead>
      <tbody>${report.shareOfVoice
        .map(
          (r) =>
            `<tr${r.isYou ? ' class="you"' : ''}><th>${e(r.name)}${r.isYou ? ' (you)' : ''}</th><td>${r.mentions}</td><td>${pct(
              r.share,
            )}</td><td>${r.averagePosition ?? '–'}</td></tr>`,
        )
        .join('')}</tbody>
    </table>`;

  const sources =
    report.topCitedDomains.length === 0
      ? '<p class="muted">No sources were cited in this run.</p>'
      : `<ol>${report.topCitedDomains.map((d) => `<li>${e(d.domain)} <span class="muted">(${d.count})</span></li>`).join('')}</ol>`;

  const recs = report.recommendations
    .map(
      (r) => `
      <section class="rec rec-${r.priority}">
        <h3>${e(r.title)} <span class="pri">${r.priority}</span></h3>
        <p>${e(r.reason)}</p>
        <ul>${r.steps.map((step) => `<li>${e(step)}</li>`).join('')}</ul>
      </section>`,
    )
    .join('');

  const answers = report.analyses
    .map((a, i) => {
      const answer = report.answers[i]!;
      let body: string;
      if (!answer.ok) {
        body = `<p class="fail">${e(answer.error ?? 'The call failed.')}</p>`;
      } else {
        const text = plainAnswer(answer.text);
        body = `<div class="transcript">${highlight(text, answerNeedles(b, a, text))
          .map((seg) => (seg.kind ? `<mark class="${seg.kind}">${e(seg.text)}</mark>` : e(seg.text)))
          .join('')}</div>`;
      }
      const cites =
        answer.citations.length > 0
          ? `<p class="muted cites">Sources: ${answer.citations.slice(0, 10).map((u) => e(u)).join(', ')}</p>`
          : '';
      return `<article class="answer"><h3>${e(ENGINE_LABELS[a.engine])}${answer.model ? ` <span class="muted">${e(answer.model)}</span>` : ''}: ${e(
        a.prompt,
      )}</h3>${body}${cites}</article>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(`AI visibility report: ${b.name}${report.demo ? ' (demo data)' : ''}`)}</title>
<style>
  :root { --ink:#16224a; --muted:#5d6787; --line:#d3dae8; --marker:#ffe14d; --rival:#d6e4ff; --named:#1d7a5f; --miss:#b0365a; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--ink); margin: 0 auto; max-width: 900px; padding: 32px 24px; line-height: 1.5; }
  h1 { font-size: 28px; line-height: 1.15; margin: 0 0 6px; }
  h2 { font-size: 18px; margin: 32px 0 10px; padding-top: 12px; border-top: 2px solid var(--ink); }
  h3 { font-size: 15px; margin: 0 0 4px; }
  .muted { color: var(--muted); }
  .demo { border: 2px dashed var(--ink); padding: 10px 14px; border-radius: 8px; }
  .score { display: flex; gap: 32px; align-items: flex-end; flex-wrap: wrap; }
  .score .num { font-size: 64px; font-weight: 800; line-height: 1; }
  .score .num small { font-size: 18px; color: var(--muted); font-weight: 500; }
  .score dl { margin: 0; display: grid; grid-template-columns: auto auto; gap: 2px 16px; font-size: 14px; }
  .score dt { color: var(--muted); }
  .score dd { margin: 0; font-weight: 600; }
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
  .rec { border-left: 4px solid var(--line); padding: 4px 0 4px 12px; margin: 0 0 14px; break-inside: avoid; }
  .rec-high { border-color: var(--miss); }
  .rec-medium { border-color: #d9a400; }
  .rec p { margin: 0 0 4px; }
  .rec ul { margin: 0; padding-left: 18px; font-size: 14px; }
  .pri { font-size: 11px; text-transform: none; font-weight: 600; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; }
  .answer { border-top: 1px solid var(--line); padding: 10px 0; break-inside: avoid; }
  .transcript { white-space: pre-wrap; font-size: 13px; }
  .fail { color: var(--miss); }
  .cites { font-size: 11px; word-break: break-all; }
  mark.you { background: var(--marker); font-weight: 600; }
  mark.competitor { background: var(--rival); }
  mark, .c-top { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  footer { margin-top: 32px; font-size: 12px; color: var(--muted); }
  @media print { body { padding: 0; } h2.answers { break-before: page; } }
</style>
</head>
<body>
<header>
  <h1>AI visibility report: ${e(b.name)}</h1>
  <p class="muted">${e(b.category)} in ${e(b.city)}${b.country ? `, ${e(b.country)}` : ''}${b.domain ? ` · ${e(b.domain)}` : ''} · ${e(date)}</p>
</header>
${demoNote}
<h2>Score</h2>
<div class="score">
  <div class="num">${s.score}<small>/100</small></div>
  <dl>
    <dt>Mention rate (× ${WEIGHTS.mention})</dt><dd>${pct(s.mentionRate)}, ${s.mentionedCount} of ${s.answered} answers</dd>
    <dt>Position (× ${WEIGHTS.position})</dt><dd>${pct(s.positionScore)}${s.averagePosition !== null ? `, average rank ${s.averagePosition}` : ''}</dd>
    <dt>Engine coverage (× ${WEIGHTS.coverage})</dt><dd>${pct(s.engineCoverage)}, ${s.enginesMentioning} of ${s.enginesAnswered} engines</dd>
  </dl>
</div>
<h2>Prompt by prompt</h2>
${matrix}
<h2>Share of voice</h2>
${sov}
<h2>Sources the engines cited</h2>
${sources}
<h2>What to fix, in order</h2>
${recs}
<h2 class="answers">All answers</h2>
${answers}
<footer>
  <p>Generated by AI Visibility Checker. AI answers vary between runs; this report is a snapshot of one run.</p>
</footer>
</body>
</html>
`;
}
