import { useEffect, useMemo, useRef, useState } from 'react';
import type { BusinessInput, EngineAnswer, EngineId, EngineStatus, VisibilityReport } from './lib/types.ts';
import { ENGINE_LABELS } from './lib/types.ts';
import { DEFAULT_PROMPT_COUNT, generatePrompts, sanitizePromptList } from './lib/prompts.ts';
import { validateBusiness } from './lib/validation.ts';
import { buildReport } from './lib/report.ts';
import { fetchEngines, runCheck } from './lib/client.ts';
import { BusinessForm } from './components/BusinessForm.tsx';
import { PromptEditor } from './components/PromptEditor.tsx';
import { ExportBar } from './components/ExportBar.tsx';
import { buildDemoReport } from './demo/exampleStudio.ts';
import {
  PrintTranscripts,
  Recommendations,
  ResultsMatrix,
  ScorePanel,
  ShareOfVoice,
  SourcesPanel,
} from './components/Results.tsx';

const EMPTY_BUSINESS: BusinessInput = {
  name: '',
  aliases: [],
  domain: '',
  category: '',
  city: '',
  country: '',
  competitors: [],
  language: 'en',
};

const STORAGE_KEY = 'avc:business';

function loadBusiness(): BusinessInput {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...EMPTY_BUSINESS, ...(JSON.parse(raw) as Partial<BusinessInput>) };
  } catch {
    // ignore unreadable storage
  }
  return EMPTY_BUSINESS;
}

interface RunState {
  status: 'idle' | 'running' | 'done' | 'stopped' | 'error';
  business: BusinessInput;
  prompts: string[];
  engines: EngineStatus[];
  answers: EngineAnswer[];
  startedAt: string;
  error?: string;
}

export function App() {
  const [business, setBusiness] = useState<BusinessInput>(loadBusiness);
  const [demo, setDemo] = useState<VisibilityReport | null>(null);
  const [count, setCount] = useState(DEFAULT_PROMPT_COUNT);
  const [customPrompts, setCustomPrompts] = useState<string[] | null>(null);
  const [engines, setEngines] = useState<EngineStatus[] | null>(null);
  const [selection, setSelection] = useState<Set<EngineId> | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [run, setRun] = useState<RunState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchEngines(ctrl.signal).then((r) => {
      if (!ctrl.signal.aborted) setEngines(r.engines);
    });
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(business));
    } catch {
      // storage can be unavailable (private mode); the app still works
    }
  }, [business]);

  // Expand every collapsible section when printing so the PDF contains all details.
  useEffect(() => {
    const open = () => document.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));
    window.addEventListener('beforeprint', open);
    return () => window.removeEventListener('beforeprint', open);
  }, []);

  const canGenerate = business.category.trim() !== '' && business.city.trim() !== '';
  const generated = useMemo(() => (canGenerate ? generatePrompts(business, count) : []), [business, count, canGenerate]);
  const prompts = customPrompts ?? generated;
  const cleanPrompts = sanitizePromptList(prompts);
  const errors = validateBusiness(business);
  const formValid = Object.keys(errors).length === 0;

  const available = (engines ?? []).filter((e) => e.available);
  const selected = available.filter((e) => (selection ? selection.has(e.id) : true));
  const running = run?.status === 'running';
  const requestCount = cleanPrompts.length * selected.length;

  const report: VisibilityReport | null = useMemo(() => {
    if (!run || run.answers.length === 0) return null;
    return buildReport({
      business: run.business,
      prompts: run.prompts,
      engines: run.engines,
      answers: run.answers,
      demo: false,
      generatedAt: run.startedAt,
    });
  }, [run]);

  const toggleEngine = (id: EngineId) => {
    const next = new Set(selected.map((e) => e.id));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelection(next);
  };

  const start = async () => {
    setShowErrors(true);
    if (!formValid || cleanPrompts.length === 0 || selected.length === 0) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const snapshot: RunState = {
      status: 'running',
      business: { ...business, name: business.name.trim(), category: business.category.trim(), city: business.city.trim() },
      prompts: cleanPrompts,
      engines: selected,
      answers: [],
      startedAt: new Date().toISOString(),
    };
    setDemo(null);
    setRun(snapshot);
    requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    try {
      await runCheck({
        prompts: snapshot.prompts,
        engines: snapshot.engines.map((e) => e.id),
        signal: ctrl.signal,
        onAnswers: (answers) => setRun((r) => (r ? { ...r, answers: [...r.answers, ...answers] } : r)),
      });
      setRun((r) => (r ? { ...r, status: ctrl.signal.aborted ? 'stopped' : 'done' } : r));
    } catch (err) {
      setRun((r) => (r ? { ...r, status: 'error', error: err instanceof Error ? err.message : 'The run failed.' } : r));
    }
  };

  const stop = () => abortRef.current?.abort();

  const expected = run ? run.prompts.length * run.engines.length : 0;
  const received = run?.answers.length ?? 0;
  const view = demo ?? report;

  const showDemo = () => {
    setDemo(buildDemoReport());
    requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <div className="page">
      <header className="masthead">
        <div className="masthead__brand">
          <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" />
            <rect className="logo__mark" x="6" y="13" width="20" height="8" rx="2" transform="rotate(-4 16 17)" />
          </svg>
          <span className="masthead__name">AI Visibility Checker</span>
        </div>
        <ul className="engine-status" aria-label="Engines">
          {(engines ?? []).map((e) => (
            <li key={e.id} className={e.available ? 'is-on' : 'is-off'} title={e.model ?? 'No API key configured'}>
              {e.label}
              <span className="sr-only">{e.available ? ', available' : ', unavailable'}</span>
            </li>
          ))}
        </ul>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <h1 id="hero-title" className="hero__title">
          Someone asks an AI for{' '}
          <span className="hero__slot">{business.category.trim() || 'a business like yours'}</span>
          {business.city.trim() && (
            <>
              {' '}
              in <span className="hero__slot">{business.city.trim()}</span>
            </>
          )}
          . Does it name <mark className="hero__brand">{business.name.trim() || 'you'}</mark>?
        </h1>
        <p className="hero__lede">
          This tool asks Claude, ChatGPT and Perplexity the questions your customers ask, checks every answer for your
          name, rank and competitors, and turns that into a score and a short list of fixes.
        </p>
      </section>

      <div className="setup">
        <BusinessForm
          value={business}
          errors={errors}
          showErrors={showErrors}
          disabled={running}
          onChange={setBusiness}
        />
        <PromptEditor
          prompts={prompts}
          edited={customPrompts !== null}
          count={count}
          disabled={running}
          onCountChange={setCount}
          onEdit={setCustomPrompts}
          onReset={() => setCustomPrompts(null)}
        />
      </div>

      <section className="runbar" aria-label="Run the check">
        <div className="runbar__engines">
          {engines === null && <p className="muted">Checking which engines are set up…</p>}
          {engines !== null && available.length === 0 && (
            <p className="runbar__notice">
              No AI engines are configured on this deployment, so live checks are off. Add an API key (see README), or
              open the demo report to see what a result looks like.
            </p>
          )}
          {available.map((e) => (
            <label key={e.id} className="engine-toggle">
              <input
                type="checkbox"
                checked={selected.some((s) => s.id === e.id)}
                disabled={running}
                onChange={() => toggleEngine(e.id)}
              />
              <span>{ENGINE_LABELS[e.id]}</span>
              <span className="engine-toggle__model">{e.model}</span>
            </label>
          ))}
        </div>
        <div className="runbar__action">
          {showErrors && !formValid && <p className="runbar__error">Fill in the highlighted fields first.</p>}
          {!running && !demo && (
            <button
              type="button"
              className={available.length === 0 && engines !== null ? 'button' : 'button button--ghost'}
              onClick={showDemo}
            >
              Open demo report
            </button>
          )}
          {running ? (
            <button type="button" className="button button--ghost" onClick={stop}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="button"
              onClick={start}
              disabled={available.length === 0 || selected.length === 0 || cleanPrompts.length === 0}
            >
              Run check
            </button>
          )}
          {available.length > 0 && (
            <p className="runbar__meta">
              {cleanPrompts.length} prompts × {selected.length} engines = {requestCount} API calls, billed to your keys.
            </p>
          )}
        </div>
      </section>

      <div ref={resultsRef} className="results-anchor" />

      {demo && (
        <div className="demo-banner" role="note">
          <div>
            <strong>Demo data</strong>
            <p>
              Example Studio and its competitors are fictional. These answers were written by hand to show how the report
              works. They did not come from Claude, ChatGPT or Perplexity.
            </p>
          </div>
          <button type="button" className="button button--light" onClick={() => setDemo(null)}>
            Close demo
          </button>
        </div>
      )}

      {run && !demo && (
        <div className="run-status" role="status">
          {run.status === 'running' && (
            <>
              <progress max={expected} value={received} aria-label="Answers received" />
              <span>
                {received} of {expected} answers
              </span>
            </>
          )}
          {run.status === 'stopped' && <span>Stopped. Results below cover the {received} answers received.</span>}
          {run.status === 'error' && <span className="runbar__error">{run.error}</span>}
        </div>
      )}

      {view && (
        <main className={`results${view.demo ? ' results--demo' : ''}`} key={view.generatedAt} aria-label={view.demo ? 'Demo results' : 'Results'}>
          <div className="results__head">
            <h2 className="results__summary">
              {view.demo && <span className="demo-tag">Demo data</span>}
              <mark className="hero__brand">{view.business.name}</mark> was named in {view.score.mentionedCount} of{' '}
              {view.score.answered} answers.
            </h2>
            <ExportBar report={view} disabled={running && !view.demo} />
          </div>
          <div className="results__top">
            <ScorePanel report={view} running={running && !view.demo} />
            <ResultsMatrix report={view} running={running && !view.demo} />
          </div>
          <div className="results__grid">
            <ShareOfVoice report={view} />
            <SourcesPanel report={view} />
          </div>
          {(!running || view.demo) && <Recommendations report={view} />}
          <PrintTranscripts report={view} />
        </main>
      )}

      <footer className="footer">
        <p>
          AI answers change from run to run. Treat a report as a snapshot, and compare runs over weeks rather than
          single answers.
        </p>
        <p>
          Open source by <a href="https://github.com/risxxkxx">Riste Kozarev</a>.
        </p>
      </footer>
    </div>
  );
}
