import { useRef, useState } from 'react';
import type { AnswerAnalysis, EngineAnswer, EngineId, Recommendation, ReportLanguage, Snippet, VisibilityReport } from '../lib/types.ts';
import { ENGINE_LABELS } from '../lib/types.ts';
import { WEIGHTS } from '../lib/scoring.ts';
import { answerNeedles, highlight, plainAnswer } from '../lib/highlight.ts';
import { hostOf } from '../lib/normalize.ts';
import {
  BAND_TEXT,
  CHECK_STATE_TEXT,
  CLAIM_KIND_TEXT,
  CLAIM_STATUS_TEXT,
  NAME_KIND_TEXT,
  PRIORITY_TEXT,
  t,
} from '../lib/i18n.ts';

const pct = (n: number) => `${Math.round(n * 100)}%`;
const rank = (n: number | null) => (n === null ? '–' : n.toFixed(1).replace(/\.0$/, ''));

interface Base {
  report: VisibilityReport;
  lang: ReportLanguage;
}

export function ScorePanel({ report, running, lang }: Base & { running: boolean }) {
  const s = report.score;
  const parts = [
    { label: t(lang, 'mentionRate'), value: s.mentionRate, weight: WEIGHTS.mention, detail: `${s.mentionedCount} ${t(lang, 'of')} ${s.answered} ${t(lang, 'answersWord')}` },
    {
      label: t(lang, 'position'),
      value: s.positionScore,
      weight: WEIGHTS.position,
      detail: s.averagePosition === null ? t(lang, 'neverRanked') : `${t(lang, 'averageRank')} ${rank(s.averagePosition)}`,
    },
    {
      label: t(lang, 'coverage'),
      value: s.engineCoverage,
      weight: WEIGHTS.coverage,
      detail: `${s.enginesMentioning} ${t(lang, 'of')} ${s.enginesAnswered} ${t(lang, 'enginesWord')}`,
    },
  ];
  const acc = report.factCheck.accuracy;
  const rd = report.readiness;
  return (
    <section className={`score score--${s.band}`} aria-labelledby="score-title">
      <h2 className="panel-title" id="score-title">
        {t(lang, 'scoreTitle')}
      </h2>
      <p className="score__number" aria-live="polite">
        <span className="score__value">{s.score}</span>
        <span className="score__of">/100</span>
      </p>
      <div className="score__marker" aria-hidden="true">
        <span style={{ width: `${s.score}%` }} />
      </div>
      <p className="score__band">{running ? t(lang, 'counting') : BAND_TEXT[s.band][lang]}</p>
      <dl className="score__parts">
        {parts.map((p) => (
          <div key={p.label} className="score__part">
            <dt>
              {p.label} <span className="score__weight">× {p.weight}</span>
            </dt>
            <dd>
              <span className="score__bar" aria-hidden="true">
                <span style={{ width: pct(p.value) }} />
              </span>
              <span className="score__detail">
                {pct(p.value)}, {p.detail}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <div className="subscores" aria-label={t(lang, 'subScores')}>
        <div className="subscore">
          <span className="subscore__label">{t(lang, 'accuracy')}</span>
          <span className="subscore__value">{acc.score === null ? '–' : `${acc.score}%`}</span>
          <span className="subscore__detail">
            {acc.score === null ? t(lang, 'accuracyNone') : `${acc.correct} ✓ · ${acc.wrong} ✗`}
          </span>
        </div>
        <div className="subscore">
          <span className="subscore__label">{t(lang, 'readiness')}</span>
          <span className="subscore__value">{rd.score === null ? '–' : rd.score}</span>
          <span className="subscore__detail">
            {rd.score === null ? (report.auditStatus === 'running' ? t(lang, 'auditRunning') : t(lang, 'readinessNone')) : '/100'}
          </span>
        </div>
        <p className="subscores__note">{t(lang, 'notBlended')}</p>
      </div>
    </section>
  );
}

type CellKey = `${number}:${EngineId}`;

function cellLabel(a: AnswerAnalysis | undefined, lang: ReportLanguage): { text: string; tone: string; title: string } {
  if (!a) return { text: '', tone: 'pending', title: lang === 'mk' ? 'Се чека одговор' : 'Waiting for an answer' };
  if (!a.ok) return { text: t(lang, 'cellFailed'), tone: 'failed', title: t(lang, 'legendFailed') };
  if (!a.mentioned) return { text: '–', tone: 'missing', title: t(lang, 'legendMissing') };
  if (a.position !== null)
    return { text: `#${a.position}`, tone: a.position <= 3 ? 'top' : 'named', title: `${t(lang, 'legendRank')} ${a.position}` };
  return { text: t(lang, 'cellNamed'), tone: 'named', title: t(lang, 'legendNamed') };
}

export function ResultsMatrix({ report, running, lang }: Base & { running: boolean }) {
  const engines = report.engines.filter((e) => e.available).map((e) => e.id);
  const byKey = new Map<CellKey, { analysis: AnswerAnalysis; answer: EngineAnswer }>();
  report.analyses.forEach((analysis, i) => {
    const p = report.prompts.indexOf(analysis.prompt);
    if (p >= 0) byKey.set(`${p}:${analysis.engine}`, { analysis, answer: report.answers[i]! });
  });

  const firstNamed = [...byKey.keys()].find((k) => byKey.get(k)!.analysis.mentioned);
  const [selected, setSelected] = useState<CellKey | null>(null);
  const active = selected && byKey.has(selected) ? selected : (firstNamed ?? [...byKey.keys()][0] ?? null);
  const current = active ? byKey.get(active) : undefined;
  const viewerRef = useRef<HTMLDivElement | null>(null);

  const select = (key: CellKey) => {
    setSelected(key);
    // On narrow screens the answer sits below the table, so bring it into view.
    if (window.matchMedia('(max-width: 1080px)').matches) {
      requestAnimationFrame(() => viewerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  };

  return (
    <section className="matrix-section" aria-labelledby="matrix-title">
      <div className="matrix-wrap">
        <h2 className="panel-title" id="matrix-title">
          {t(lang, 'matrixTitle')}
        </h2>
        <table className="matrix">
          <thead>
            <tr>
              <th scope="col">{t(lang, 'prompt')}</th>
              {engines.map((e) => (
                <th scope="col" key={e}>
                  {ENGINE_LABELS[e]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.prompts.map((prompt, p) => (
              <tr key={p}>
                <th scope="row">{prompt}</th>
                {engines.map((e) => {
                  const key: CellKey = `${p}:${e}`;
                  const hit = byKey.get(key);
                  const label = cellLabel(hit?.analysis, lang);
                  const pending = !hit && running;
                  return (
                    <td key={e}>
                      <button
                        type="button"
                        className={`cell cell--${pending ? 'pending' : hit ? label.tone : 'empty'}${active === key ? ' is-active' : ''}`}
                        disabled={!hit}
                        aria-pressed={active === key}
                        aria-label={`${ENGINE_LABELS[e]}, ${t(lang, 'prompt').toLowerCase()} ${p + 1}: ${hit ? label.title : pending ? '…' : '–'}`}
                        title={label.title}
                        onClick={() => select(key)}
                      >
                        {hit ? label.text : ''}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="matrix__legend">
          <span className="cell cell--top">#1</span> {t(lang, 'legendRank')} <span className="cell cell--named">{t(lang, 'cellNamed')}</span>{' '}
          {t(lang, 'legendNamed')} <span className="cell cell--missing">–</span> {t(lang, 'legendMissing')}{' '}
          <span className="cell cell--failed">{t(lang, 'cellFailed')}</span> {t(lang, 'legendFailed')}
        </p>
      </div>
      <div ref={viewerRef} className="viewer-anchor">
        <AnswerViewer report={report} entry={current} lang={lang} />
      </div>
    </section>
  );
}

export function Transcript({ report, analysis, answer, lang }: Base & { analysis: AnswerAnalysis; answer: EngineAnswer }) {
  if (!answer.ok) return <p className="transcript transcript--error">{answer.error ?? t(lang, 'callFailed')}</p>;
  const text = plainAnswer(answer.text);
  return (
    <div className="transcript">
      {highlight(text, answerNeedles(report.business, analysis, text)).map((seg, i) =>
        seg.kind ? (
          <mark key={i} className={`hl hl--${seg.kind}`}>
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </div>
  );
}

function verdict(analysis: AnswerAnalysis, lang: ReportLanguage): string {
  const mk = lang === 'mk';
  if (!analysis.ok) return mk ? 'Нема одговор.' : 'No answer.';
  const how = analysis.matchType === 'exact' ? '' : ` (${analysis.matchType})`;
  let s = !analysis.mentioned
    ? mk
      ? 'Не сте спомнати.'
      : 'Not named.'
    : analysis.position !== null
      ? mk
        ? `Спомнати сте на позиција ${analysis.position} од ${analysis.listLength}${how}.`
        : `Named at rank ${analysis.position} of ${analysis.listLength}${how}.`
      : mk
        ? `Спомнати сте во текстот${how}.`
        : `Named in the text${how}.`;
  if (analysis.competitors.length > 0)
    s += ` ${mk ? 'Спомнати конкуренти' : 'Competitors named'}: ${analysis.competitors.map((c) => c.name).join(', ')}.`;
  return s;
}

function AnswerViewer({ report, entry, lang }: Base & { entry?: { analysis: AnswerAnalysis; answer: EngineAnswer } }) {
  if (!entry) {
    return (
      <aside className="viewer viewer--empty" aria-label="Answer">
        <p>{lang === 'mk' ? 'Одговорите се појавуваат тука. Изберете ќелија за да прочитате.' : 'Answers appear here as they arrive. Select a cell to read it.'}</p>
      </aside>
    );
  }
  const { analysis, answer } = entry;
  return (
    <aside className="viewer" aria-labelledby="viewer-title" aria-live="polite">
      <p className="viewer__engine">
        {ENGINE_LABELS[answer.engine]}
        {answer.model && <span className="viewer__model">{answer.model}</span>}
      </p>
      <h3 className="viewer__prompt" id="viewer-title">
        {answer.prompt}
      </h3>
      <p className="viewer__verdict">{verdict(analysis, lang)}</p>
      <Transcript report={report} analysis={analysis} answer={answer} lang={lang} />
      {answer.citations.length > 0 && (
        <div className="viewer__sources">
          <h4>{t(lang, 'sources')}</h4>
          <ul>
            {answer.citations.slice(0, 12).map((url) => (
              <li key={url}>
                <a href={url} target="_blank" rel="noopener noreferrer nofollow">
                  {hostOf(url) ?? url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

export function ShareOfVoice({ report, lang }: Base) {
  const rows = report.shareOfVoice;
  const max = Math.max(1, ...rows.map((r) => r.mentions));
  return (
    <section className="sov" aria-labelledby="sov-title">
      <h2 className="panel-title" id="sov-title">
        {t(lang, 'sovTitle')}
      </h2>
      {rows.length < 2 && <p className="muted">{t(lang, 'addCompetitors')}</p>}
      <table className="sov__table">
        <thead>
          <tr>
            <th scope="col">{t(lang, 'business')}</th>
            <th scope="col">{t(lang, 'mentions')}</th>
            <th scope="col">{t(lang, 'share')}</th>
            <th scope="col">{t(lang, 'avgRank')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className={r.isYou ? 'is-you' : undefined}>
              <th scope="row">
                {r.name}
                {r.isYou && <span className="you-tag">{t(lang, 'you')}</span>}
              </th>
              <td>
                <span className="sov__bar" aria-hidden="true">
                  <span style={{ width: `${(r.mentions / max) * 100}%` }} />
                </span>
                {r.mentions}
              </td>
              <td>{pct(r.share)}</td>
              <td>{rank(r.averagePosition)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function SourcesPanel({ report, lang }: Base) {
  return (
    <section className="sources" aria-labelledby="sources-title">
      <h2 className="panel-title" id="sources-title">
        {t(lang, 'sourcesTitle')}
      </h2>
      {report.topCitedDomains.length === 0 ? (
        <p className="muted">{t(lang, 'noSources')}</p>
      ) : (
        <>
          <p className="muted">{t(lang, 'sourcesLede')}</p>
          <ol className="sources__list">
            {report.topCitedDomains.map((d) => (
              <li key={d.domain}>
                <span>{d.domain}</span>
                <span className="muted">
                  {d.count} {d.count === 1 ? t(lang, 'answerWord') : t(lang, 'answersWord')}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function SnippetText({ snippet }: { snippet: Snippet }) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  snippet.highlights.forEach((h, i) => {
    if (h.start < cursor) return;
    if (h.start > cursor) parts.push(<span key={`t${i}`}>{snippet.text.slice(cursor, h.start)}</span>);
    parts.push(
      <mark key={`m${i}`} className={h.kind === 'claim' ? 'hl hl--claim' : 'hl hl--you'}>
        {snippet.text.slice(h.start, h.end)}
      </mark>,
    );
    cursor = h.end;
  });
  if (cursor < snippet.text.length) parts.push(<span key="end">{snippet.text.slice(cursor)}</span>);
  return <>{parts}</>;
}

export function FactsPanel({ report, lang }: Base) {
  const fc = report.factCheck;
  return (
    <section className="facts" aria-labelledby="facts-title">
      <h2 className="panel-title" id="facts-title">
        {t(lang, 'factsTitle')}
      </h2>
      {fc.answersChecked === 0 ? (
        <p className="muted">{t(lang, 'factsNotNamed')}</p>
      ) : (
        <>
          <p className="muted facts__lede">{t(lang, 'factsLede')}</p>
          {!report.knownFacts && <p className="facts__notice">{t(lang, 'factsNoFacts')}</p>}
          {fc.rows.length > 0 && (
            <div className="table-scroll">
              <table className="facts__table">
                <thead>
                  <tr>
                    <th scope="col">{t(lang, 'fact')}</th>
                    <th scope="col">{t(lang, 'yourValue')}</th>
                    <th scope="col">{t(lang, 'status')}</th>
                    <th scope="col">{t(lang, 'engines')}</th>
                  </tr>
                </thead>
                <tbody>
                  {fc.rows.map((r) => (
                    <tr key={r.key}>
                      <th scope="row">{r.label[lang]}</th>
                      <td>{r.expected[lang]}</td>
                      <td>
                        <span className={`status status--${r.status}`}>{CLAIM_STATUS_TEXT[r.status][lang]}</span>
                        {r.correct + r.wrong > 1 && (
                          <span className="muted">
                            {' '}
                            {r.correct}✓ {r.wrong}✗
                          </span>
                        )}
                      </td>
                      <td>{r.engines.map((e) => ENGINE_LABELS[e]).join(', ') || '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {fc.claims.length === 0 ? (
            <p className="muted">{t(lang, 'factsNone')}</p>
          ) : (
            <>
              <h3 className="facts__subtitle">{t(lang, 'whatAiSaid')}</h3>
              <ul className="claims">
                {fc.claims.map((c, i) => (
                  <li key={i} className={`claim claim--${c.status}`}>
                    <p className="claim__meta">
                      <strong>{ENGINE_LABELS[c.engine]}</strong> · {CLAIM_KIND_TEXT[c.kind][lang]} ·{' '}
                      <span className={`status status--${c.status}`}>{CLAIM_STATUS_TEXT[c.status][lang]}</span>
                    </p>
                    <p className="claim__snippet">
                      <SnippetText snippet={c.snippet} />
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
          {fc.nameVariants.length > 0 && (
            <>
              <h3 className="facts__subtitle">{t(lang, 'namesTitle')}</h3>
              <ul className="names">
                {fc.nameVariants.map((v) => (
                  <li key={v.name} className={`name name--${v.kind}`}>
                    <span className="name__value">{v.name}</span>
                    <span className="muted">
                      {NAME_KIND_TEXT[v.kind][lang]} · {v.count}× · {v.engines.map((e) => ENGINE_LABELS[e]).join(', ')}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

export function AuditPanel({ report, lang }: Base) {
  const a = report.audit;
  return (
    <section className="audit" aria-labelledby="audit-title">
      <h2 className="panel-title" id="audit-title">
        {t(lang, 'auditTitle')}
      </h2>
      {!a ? (
        <p className="muted">
          {report.auditStatus === 'running'
            ? t(lang, 'auditRunning')
            : report.auditStatus === 'failed'
              ? `${t(lang, 'auditFailed')} ${report.auditError ?? ''}`
              : report.auditStatus === 'no-domain'
                ? t(lang, 'auditNoDomain')
                : t(lang, 'auditOff')}
        </p>
      ) : (
        <>
          <p className="muted">
            {t(lang, 'auditLede')}{' '}
            <a href={a.finalUrl} target="_blank" rel="noopener noreferrer nofollow">
              {a.domain}
            </a>
          </p>
          <ul className="checks">
            {report.readiness.checks.map((c) => (
              <li key={c.id} className={`check check--${c.state}`}>
                <span className={`check__state check__state--${c.state}`}>{CHECK_STATE_TEXT[c.state][lang]}</span>
                <span className="check__label">{c.label[lang]}</span>
                <span className="check__detail">{c.detail[lang]}</span>
              </li>
            ))}
          </ul>
          {a.brandNames.length > 0 && (
            <p className="audit__names">
              <strong>{t(lang, 'namesOnSite')}:</strong>{' '}
              {a.brandNames.map((b, i) => (
                <span key={`${b.source}-${i}`}>
                  {i > 0 && ', '}“{b.value}” <span className="muted">({b.source})</span>
                </span>
              ))}
            </p>
          )}
          <p className="audit__psi">
            {a.psi ? (
              <>
                <strong>{t(lang, 'pagespeed')}:</strong> Performance {a.psi.performance ?? '–'}/100 · SEO {a.psi.seo ?? '–'}/100
                {a.psi.lcpMs ? ` · LCP ${(a.psi.lcpMs / 1000).toFixed(1)} s` : ''}
              </>
            ) : (
              <span className="muted">{a.psiStatus === 'failed' ? t(lang, 'pagespeedFailed') : t(lang, 'pagespeedOff')}</span>
            )}
          </p>
        </>
      )}
    </section>
  );
}

function CopyButton({ text, lang }: { text: string; lang: ReportLanguage }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="link-button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {copied ? '✓' : t(lang, 'copy')}
    </button>
  );
}

function RecItem({ r, lang, ticked, onTick }: { r: Recommendation; lang: ReportLanguage; ticked: boolean; onTick: () => void }) {
  const level = r.status === 'done' ? 'done' : r.priority;
  return (
    <li className={`rec rec--${level}${ticked ? ' is-done' : ''}`}>
      <details open={r.status === 'todo' && r.priority === 'high'}>
        <summary>
          {r.status === 'todo' ? (
            <input
              type="checkbox"
              checked={ticked}
              onChange={onTick}
              onClick={(e) => e.stopPropagation()}
              aria-label={`${lang === 'mk' ? 'Означи како направено' : 'Mark as done'}: ${r.title[lang]}`}
            />
          ) : (
            <span className="rec__check" aria-hidden="true">
              ✓
            </span>
          )}
          <span className="rec__title">{r.title[lang]}</span>
          <span className={`priority priority--${level}`}>{PRIORITY_TEXT[level][lang]}</span>
        </summary>
        <div className="rec__why">
          {r.why.map((w) => (
            <p key={w.en} className="rec__reason">
              {w[lang]}
            </p>
          ))}
        </div>
        {r.steps.length > 0 && (
          <ul className="rec__steps">
            {r.steps.map((s) => (
              <li key={s.en}>{s[lang]}</li>
            ))}
          </ul>
        )}
        {r.snippet && (
          <div className="rec__snippet">
            <div className="rec__snippet-head">
              <span>{r.snippet.label[lang]}</span>
              <CopyButton text={r.snippet.code} lang={lang} />
            </div>
            <pre>
              <code>{r.snippet.code}</code>
            </pre>
          </div>
        )}
      </details>
    </li>
  );
}

export function Recommendations({ report, lang }: Base) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const todo = report.recommendations.filter((r) => r.status === 'todo');
  const done = report.recommendations.filter((r) => r.status === 'done');

  return (
    <section className="recs" aria-labelledby="recs-title">
      <h2 className="panel-title" id="recs-title">
        {t(lang, 'recsTitle')}
      </h2>
      <p className="muted">{t(lang, 'recsLede')}</p>
      <ol className="recs__list">
        {todo.map((r) => (
          <RecItem key={r.id} r={r} lang={lang} ticked={ticked.has(r.id)} onTick={() => toggle(r.id)} />
        ))}
      </ol>
      {done.length > 0 && (
        <>
          <h3 className="recs__done-title">{t(lang, 'doneTitle')}</h3>
          <ul className="recs__list recs__list--done">
            {done.map((r) => (
              <RecItem key={r.id} r={r} lang={lang} ticked={false} onTick={() => undefined} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Every answer in full; only shown when printing. */
export function PrintTranscripts({ report, lang }: Base) {
  return (
    <section className="print-only print-transcripts">
      <h2>{t(lang, 'answersTitle')}</h2>
      {report.analyses.map((a, i) => (
        <article key={i} className="print-answer">
          <h3>
            {ENGINE_LABELS[a.engine]}: {a.prompt}
          </h3>
          <Transcript report={report} analysis={a} answer={report.answers[i]!} lang={lang} />
        </article>
      ))}
    </section>
  );
}
