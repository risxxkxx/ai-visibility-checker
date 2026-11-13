// Google PageSpeed Insights API v5 (runPagespeed) helper.
// Response shape (documented): lighthouseResult.categories.<id>.score is 0–1
// (or null), lighthouseResult.audits.<audit-id>.numericValue holds the raw
// metric (ms for timings, unitless for CLS), loadingExperience.metrics holds
// Chrome UX Report field data when Google has enough real-user samples.

export const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
export const PSI_CATEGORY_PARAMS = ['PERFORMANCE', 'SEO', 'ACCESSIBILITY', 'BEST_PRACTICES'];
export const PSI_CATEGORY_IDS = ['performance', 'seo', 'accessibility', 'best-practices'];
export const PSI_TIMEOUT_MS = 40000;

export function buildPsiUrl(targetUrl, apiKey){
  const url = new URL(PSI_ENDPOINT);
  url.searchParams.set('url', targetUrl);
  url.searchParams.set('strategy', 'MOBILE');
  for (const category of PSI_CATEGORY_PARAMS) url.searchParams.append('category', category);
  if (apiKey) url.searchParams.set('key', apiKey);
  return url;
}

function score01(category){
  const value = category?.score;
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : null;
}

function numeric(audits, id){
  const value = audits?.[id]?.numericValue;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function display(audits, id){
  const value = audits?.[id]?.displayValue;
  return typeof value === 'string' ? value.slice(0, 40) : null;
}

/** Parse a runPagespeed JSON body. Returns {ok:true, psi} or {ok:false, reason}. */
export function parsePsiResponse(body){
  const lh = body?.lighthouseResult;
  if (!lh || typeof lh !== 'object') return {ok:false, reason:'PageSpeed не врати резултат.'};
  if (lh.runtimeError && lh.runtimeError.code && lh.runtimeError.code !== 'NO_ERROR'){
    return {ok:false, reason:`PageSpeed не можеше да ја анализира страницата (${String(lh.runtimeError.code).slice(0, 60)}).`};
  }
  const categories = {};
  for (const id of PSI_CATEGORY_IDS) categories[id] = score01(lh.categories?.[id]);
  if (Object.values(categories).every((value) => value === null)){
    return {ok:false, reason:'PageSpeed не врати оценки по категории.'};
  }
  const audits = lh.audits || {};
  const field = body.loadingExperience?.metrics || {};
  const inp = field.INTERACTION_TO_NEXT_PAINT?.percentile;
  return {
    ok:true,
    psi:{
      strategy:'mobile',
      categories,
      metrics:{
        lcpMs:numeric(audits, 'largest-contentful-paint'),
        cls:numeric(audits, 'cumulative-layout-shift'),
        tbtMs:numeric(audits, 'total-blocking-time'),
        fcpMs:numeric(audits, 'first-contentful-paint'),
        speedIndexMs:numeric(audits, 'speed-index'),
        inpMs:typeof inp === 'number' && Number.isFinite(inp) ? inp : null
      },
      display:{
        lcp:display(audits, 'largest-contentful-paint'),
        cls:display(audits, 'cumulative-layout-shift'),
        tbt:display(audits, 'total-blocking-time'),
        fcp:display(audits, 'first-contentful-paint')
      },
      fieldDataCategory:typeof body.loadingExperience?.overall_category === 'string' ? body.loadingExperience.overall_category : null,
      lighthouseVersion:typeof lh.lighthouseVersion === 'string' ? lh.lighthouseVersion.slice(0, 20) : null,
      fetchTime:typeof lh.fetchTime === 'string' ? lh.fetchTime.slice(0, 40) : null
    }
  };
}

/**
 * Run PSI. Never throws; returns {psi, reason}. The API key is never included in the reason.
 */
export async function runPsi(targetUrl, {apiKey = '', fetchImpl = fetch, timeoutMs = PSI_TIMEOUT_MS} = {}){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(buildPsiUrl(targetUrl, apiKey).href, {signal:controller.signal, headers:{Accept:'application/json'}});
    const body = await response.json().catch(() => null);
    if (!response.ok){
      if (response.status === 429) return {psi:null, reason:'Квотата за PageSpeed е потрошена. Додај PAGESPEED_API_KEY или обиди се подоцна.'};
      if (response.status === 400) return {psi:null, reason:'PageSpeed не можеше да ја вчита страницата (400).'};
      if (response.status === 403) return {psi:null, reason:'PageSpeed API не е овозможен или клучот е невалиден (403).'};
      return {psi:null, reason:`PageSpeed грешка (${response.status}).`};
    }
    const parsed = parsePsiResponse(body);
    return parsed.ok ? {psi:parsed.psi, reason:null} : {psi:null, reason:parsed.reason};
  } catch (error){
    if (controller.signal.aborted || error?.name === 'AbortError') return {psi:null, reason:'PageSpeed не одговори навреме.'};
    return {psi:null, reason:'Неуспешно поврзување со PageSpeed.'};
  } finally {
    clearTimeout(timer);
  }
}
