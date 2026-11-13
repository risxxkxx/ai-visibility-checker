import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AuditStatus,
  BusinessInput,
  EngineAnswer,
  EngineId,
  EngineStatus,
  KnownFacts,
  ReportLanguage,
  SiteAudit,
  VisibilityReport,
} from './lib/types.ts';
import { ENGINE_LABELS } from './lib/types.ts';
import { DEFAULT_PROMPT_COUNT, generatePrompts, sanitizePromptList } from './lib/prompts.ts';
import { EMPTY_FACTS_DRAFT, factsFromDraft, validateBusiness, type FactsDraft } from './lib/validation.ts';
import { normalizeDomain } from './lib/normalize.ts';
import { buildReport } from './lib/report.ts';
import { auditSite, fetchEngines, runCheck } from './lib/client.ts';
import { BusinessForm } from './components/BusinessForm.tsx';
import { FactsForm } from './components/FactsForm.tsx';
import { PromptEditor } from './components/PromptEditor.tsx';
import { ExportBar } from './components/ExportBar.tsx';
import { buildDemoReport } from './demo/exampleStudio.ts';
import {
  AuditPanel,
  FactsPanel,
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
const FACTS_KEY = 'avc:facts';
const PREFS_KEY = 'avc:prefs';

function load<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    // ignore unreadable storage
  }
  return fallback;
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage can be unavailable (private mode); the app still works
  }
}

interface Prefs {
  audit: boolean;
  lang: ReportLanguage;
}

interface RunState {
  status: 'idle' | 'running' | 'done' | 'stopped' | 'error';
  business: BusinessInput;
  facts: KnownFacts;
  prompts: string[];
  engines: EngineStatus[];
  answers: EngineAnswer[];
  startedAt: string;
  audit: SiteAudit | null;
  auditStatus: AuditStatus;
  auditError: string | null;
  error?: string;
}

export function App() {
  const [business, setBusiness] = useState<BusinessInput>(() => load(STORAGE_KEY, EMPTY_BUSINESS));
  const [factsDraft, setFactsDraft] = useState<FactsDraft>(() => load(FACTS_KEY, EMPTY_FACTS_DRAFT));
  const [prefs, setPrefs] = useState<Prefs>(() => load<Prefs>(PREFS_KEY, { audit: true, lang: 'en' }));
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

  useEffect(() => save(STORAGE_KEY, business), [business]);
  useEffect(() => save(FACTS_KEY, factsDraft), [factsDraft]);
  useEffect(() => save(PREFS_KEY, prefs), [prefs]);

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
  const hasDomain = normalizeDomain(business.domain) !== '';
  const lang = prefs.lang;

  const report: VisibilityReport | null = useMemo(() => {
    if (!run || run.answers.length === 0) return null;
    return buildReport({
      business: run.business,
      prompts: run.prompts,
      engines: run.engines,
      answers: run.answers,
      demo: false,
      generatedAt: run.startedAt,
      facts: run.facts,
      audit: run.audit,
      auditStatus: run.auditStatus,
      auditError: run.auditError,
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
    const domain = normalizeDomain(business.domain);
    const auditStatus: AuditStatus = !prefs.audit ? 'off' : domain ? 'running' : 'no-domain';
    const snapshot: RunState = {
      status: 'running',
      business: { ...business, name: business.name.trim(), category: business.category.trim(), city: business.city.trim() },
      facts: factsFromDraft(factsDraft),
      prompts: cleanPrompts,
      engines: selected,
      answers: [],
      startedAt: new Date().toISOString(),
      audit: null,
      auditStatus,
      auditError: null,
    };
    setDemo(null);
    setRun(snapshot);
    requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    if (auditStatus === 'running') {
      // Runs alongside the engine calls; the report updates when it finishes.
      auditSite(domain, ctrl.signal).then(
        (audit) => setRun((r) => (r && r.startedAt === snapshot.startedAt ? { ...r, audit, auditStatus: 'done' } : r)),
        (err: unknown) => {
          if (ctrl.signal.aborted) return;
          const message = err instanceof Error ? err.message : 'The audit failed.';
          setRun((r) => (r && r.startedAt === snapshot.startedAt ? { ...r, auditStatus: 'failed', auditError: message } : r));
        },
      );
    }
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
          This tool asks ChatGPT, Gemini, Claude and Perplexity the questions your customers ask, checks every answer for your
          name, rank, competitors and the facts it states about you, audits your website for what assistants can read, and
          turns that into a score and a short list of fixes.
        </p>
      </section>

      <div className="setup">
        <div className="setup__left">
          <BusinessForm
            value={business}
            errors={errors}
            showErrors={showErrors}
            disabled={running}
            onChange={setBusiness}
          />
          <FactsForm
            value={factsDraft}
            placeholderName={business.name.trim()}
            placeholderCity={business.city.trim()}
            disabled={running}
            onChange={setFactsDraft}
          />
        </div>
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
        <label className="engine-toggle runbar__audit" title={hasDomain ? '' : 'Enter a website first'}>
          <input
            type="checkbox"
            checked={prefs.audit && hasDomain}
            disabled={running || !hasDomain}
            onChange={(e) => setPrefs((p) => ({ ...p, audit: e.target.checked }))}
          />
          <span>Audit the website</span>
          <span className="engine-toggle__model">{hasDomain ? 'schema, llms.txt, robots.txt, languages, services' : 'needs a website'}</span>
        </label>
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
              {cleanPrompts.length} prompts × {selected.length} engines = {requestCount} API calls, billed to your keys
              {prefs.audit && hasDomain ? ', plus one website audit' : ''}.
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
              Example Studio and its competitors are fictional. The answers, the known facts and the website audit were
              written by hand to show how the report works. They did not come from ChatGPT, Gemini, Claude or Perplexity,
              and no website was fetched.
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
            <h2 className="results__summary" lang={lang}>
              {view.demo && <span className="demo-tag">{lang === 'mk' ? 'Демо податоци' : 'Demo data'}</span>}
              <mark className="hero__brand">{view.business.name}</mark> {lang === 'mk' ? 'беше спомнат во' : 'was named in'}{' '}
              {view.score.mentionedCount} {lang === 'mk' ? 'од' : 'of'} {view.score.answered} {lang === 'mk' ? 'одговори' : 'answers'}.
            </h2>
            <div className="results__tools">
              <div className="segmented segmented--small" role="radiogroup" aria-label="Report language">
                {(
                  [
                    ['en', 'English'],
                    ['mk', 'Македонски'],
                  ] as [ReportLanguage, string][]
                ).map(([code, label]) => (
                  <label key={code} className={`segmented__option${lang === code ? ' is-on' : ''}`}>
                    <input
                      type="radio"
                      name="report-language"
                      value={code}
                      checked={lang === code}
                      onChange={() => setPrefs((p) => ({ ...p, lang: code }))}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <ExportBar report={view} disabled={running && !view.demo} lang={lang} />
            </div>
          </div>
          <div className="results__body" lang={lang}>
            <div className="results__top">
              <ScorePanel report={view} running={running && !view.demo} lang={lang} />
              <ResultsMatrix report={view} running={running && !view.demo} lang={lang} />
            </div>
            {(!running || view.demo) && <Recommendations report={view} lang={lang} />}
            <div className="results__grid">
              <FactsPanel report={view} lang={lang} />
              <AuditPanel report={view} lang={lang} />
            </div>
            <div className="results__grid">
              <ShareOfVoice report={view} lang={lang} />
              <SourcesPanel report={view} lang={lang} />
            </div>
            <PrintTranscripts report={view} lang={lang} />
          </div>
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
