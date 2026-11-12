import { useRef, useState } from 'react';
import type { AnswerAnalysis, EngineAnswer, EngineId, VisibilityReport } from '../lib/types.ts';
import { ENGINE_LABELS } from '../lib/types.ts';
import { WEIGHTS } from '../lib/scoring.ts';
import { answerNeedles, highlight, plainAnswer } from '../lib/highlight.ts';
import { hostOf } from '../lib/normalize.ts';

const BAND_COPY: Record<VisibilityReport['score']['band'], string> = {
  invisible: 'Assistants are not recommending you yet.',
  emerging: 'You come up sometimes, usually not first.',
  visible: 'You are part of the conversation.',
  leading: 'Assistants name you often and early.',
};

const pct = (n: number) => `${Math.round(n * 100)}%`;
const rank = (n: number | null) => (n === null ? '–' : n.toFixed(1).replace(/\.0$/, ''));

export function ScorePanel({ report, running }: { report: VisibilityReport; running: boolean }) {
  const s = report.score;
  const parts = [
    { label: 'Mention rate', value: s.mentionRate, weight: WEIGHTS.mention, detail: `${s.mentionedCount} of ${s.answered} answers` },
    {
      label: 'Position',
      value: s.positionScore,
      weight: WEIGHTS.position,
      detail: s.averagePosition === null ? 'Never ranked in a list' : `Average rank ${rank(s.averagePosition)}`,
    },
    {
      label: 'Engine coverage',
      value: s.engineCoverage,
      weight: WEIGHTS.coverage,
      detail: `${s.enginesMentioning} of ${s.enginesAnswered} engines`,
    },
  ];
  return (
    <section className={`score score--${s.band}`} aria-labelledby="score-title">
      <h2 className="panel-title" id="score-title">
        Visibility score
      </h2>
      <p className="score__number" aria-live="polite">
        <span className="score__value">{s.score}</span>
        <span className="score__of">/100</span>
      </p>
      <div className="score__marker" aria-hidden="true">
        <span style={{ width: `${s.score}%` }} />
      </div>
      <p className="score__band">
        {running ? 'Counting while answers arrive.' : BAND_COPY[s.band]}
      </p>
      <dl className="score__parts">
        {parts.map((p) => (
          <div key={p.label} className="score__part">
            <dt>
              {p.label} <span className="score__weight">× {p.weight}</span>
            </dt>
            <dd>
              <meter min={0} max={1} value={p.value} aria-label={`${p.label} ${pct(p.value)}`} />
              <span className="score__detail">
                {pct(p.value)}, {p.detail.charAt(0).toLowerCase() + p.detail.slice(1)}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

type CellKey = `${number}:${EngineId}`;

function cellLabel(a: AnswerAnalysis | undefined): { text: string; tone: string; title: string } {
  if (!a) return { text: '', tone: 'pending', title: 'Waiting for an answer' };
  if (!a.ok) return { text: 'err', tone: 'failed', title: 'The engine call failed' };
  if (!a.mentioned) return { text: '–', tone: 'missing', title: 'Not named' };
  if (a.position !== null) return { text: `#${a.position}`, tone: a.position <= 3 ? 'top' : 'named', title: `Named at rank ${a.position}` };
  return { text: 'named', tone: 'named', title: 'Named in the text, not in a ranked list' };
}

export function ResultsMatrix({ report, running }: { report: VisibilityReport; running: boolean }) {
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
          Who got named, prompt by prompt
        </h2>
        <table className="matrix">
          <thead>
            <tr>
              <th scope="col">Prompt</th>
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
                  const label = cellLabel(hit?.analysis);
                  const pending = !hit && running;
                  return (
                    <td key={e}>
                      <button
                        type="button"
                        className={`cell cell--${pending ? 'pending' : hit ? label.tone : 'empty'}${active === key ? ' is-active' : ''}`}
                        disabled={!hit}
                        aria-pressed={active === key}
                        aria-label={`${ENGINE_LABELS[e]}, prompt ${p + 1}: ${hit ? label.title : pending ? 'waiting' : 'not run'}`}
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
          <span className="cell cell--top">#1</span> rank in a list <span className="cell cell--named">named</span> in the
          text <span className="cell cell--missing">–</span> not named <span className="cell cell--failed">err</span> call
          failed
        </p>
      </div>
      <div ref={viewerRef} className="viewer-anchor">
        <AnswerViewer report={report} entry={current} />
      </div>
    </section>
  );
}

export function Transcript({ report, analysis, answer }: { report: VisibilityReport; analysis: AnswerAnalysis; answer: EngineAnswer }) {
  if (!answer.ok) return <p className="transcript transcript--error">{answer.error ?? 'The call failed.'}</p>;
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

function AnswerViewer({ report, entry }: { report: VisibilityReport; entry?: { analysis: AnswerAnalysis; answer: EngineAnswer } }) {
  if (!entry) {
    return (
      <aside className="viewer viewer--empty" aria-label="Answer">
        <p>Answers appear here as they arrive. Select a cell to read it.</p>
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
      <p className="viewer__verdict">
        {!analysis.ok
          ? 'No answer.'
          : analysis.mentioned
            ? analysis.position !== null
              ? `Named at rank ${analysis.position} of ${analysis.listLength}${analysis.matchType === 'exact' ? '' : ` (${analysis.matchType} match)`}.`
              : `Named in the text${analysis.matchType === 'exact' ? '' : ` (${analysis.matchType} match)`}.`
            : 'Not named.'}
        {analysis.competitors.length > 0 && ` Competitors named: ${analysis.competitors.map((c) => c.name).join(', ')}.`}
      </p>
      <Transcript report={report} analysis={analysis} answer={answer} />
      {answer.citations.length > 0 && (
        <div className="viewer__sources">
          <h4>Sources cited</h4>
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

export function ShareOfVoice({ report }: { report: VisibilityReport }) {
  const rows = report.shareOfVoice;
  const max = Math.max(1, ...rows.map((r) => r.mentions));
  return (
    <section className="sov" aria-labelledby="sov-title">
      <h2 className="panel-title" id="sov-title">
        Share of voice
      </h2>
      {rows.length < 2 && <p className="muted">Add competitors to compare how often each one is named.</p>}
      <table className="sov__table">
        <thead>
          <tr>
            <th scope="col">Business</th>
            <th scope="col">Mentions</th>
            <th scope="col">Share</th>
            <th scope="col">Avg. rank</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className={r.isYou ? 'is-you' : undefined}>
              <th scope="row">
                {r.name}
                {r.isYou && <span className="you-tag">you</span>}
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

export function SourcesPanel({ report }: { report: VisibilityReport }) {
  if (report.topCitedDomains.length === 0) {
    return (
      <section className="sources" aria-labelledby="sources-title">
        <h2 className="panel-title" id="sources-title">
          Sources the engines cited
        </h2>
        <p className="muted">No sources were cited. Perplexity (and ChatGPT with web search on) list the pages they used.</p>
      </section>
    );
  }
  return (
    <section className="sources" aria-labelledby="sources-title">
      <h2 className="panel-title" id="sources-title">
        Sources the engines cited
      </h2>
      <p className="muted">Being listed on these sites is the most direct way into search-backed answers.</p>
      <ol className="sources__list">
        {report.topCitedDomains.map((d) => (
          <li key={d.domain}>
            <span>{d.domain}</span>
            <span className="muted">
              {d.count} {d.count === 1 ? 'answer' : 'answers'}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Recommendations({ report }: { report: VisibilityReport }) {
  const [done, setDone] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="recs" aria-labelledby="recs-title">
      <h2 className="panel-title" id="recs-title">
        What to fix, in order
      </h2>
      <p className="muted">From a fixed checklist, ranked by this run’s results. Tick items off as you go.</p>
      <ol className="recs__list">
        {report.recommendations.map((r) => (
          <li key={r.id} className={`rec rec--${r.priority}${done.has(r.id) ? ' is-done' : ''}`}>
            <details open={r.priority === 'high'}>
              <summary>
                <input
                  type="checkbox"
                  checked={done.has(r.id)}
                  onChange={() => toggle(r.id)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Mark “${r.title}” as done`}
                />
                <span className="rec__title">{r.title}</span>
                <span className={`priority priority--${r.priority}`}>{r.priority}</span>
              </summary>
              <p className="rec__reason">{r.reason}</p>
              <ul className="rec__steps">
                {r.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Every answer in full; only shown when printing. */
export function PrintTranscripts({ report }: { report: VisibilityReport }) {
  return (
    <section className="print-only print-transcripts">
      <h2>All answers</h2>
      {report.analyses.map((a, i) => (
        <article key={i} className="print-answer">
          <h3>
            {ENGINE_LABELS[a.engine]}: {a.prompt}
          </h3>
          <Transcript report={report} analysis={a} answer={report.answers[i]!} />
        </article>
      ))}
    </section>
  );
}
