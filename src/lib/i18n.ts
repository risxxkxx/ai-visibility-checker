/**
 * Report text in English and Macedonian. The app's own controls stay in English; everything a
 * client reads (the report on screen, the HTML/PDF export, recommendations) comes from here.
 */
import type { ClaimKind, ClaimStatus, FactStatus, Localized, NameVariant, Priority, ReadinessCheck, ReportLanguage, ScoreBreakdown } from './types.ts';

const L = (en: string, mk: string): Localized => ({ en, mk });

export const REPORT_TEXT = {
  reportTitle: L('AI visibility report', 'Извештај за видливост во AI'),
  demoTag: L('Demo data', 'Демо податоци'),
  demoNote: L(
    'Example Studio and its competitors are fictional, and these answers and the website audit were written for illustration. They did not come from AI engines.',
    'Example Studio и конкурентите се измислени, а одговорите и проверката на сајтот се напишани за илустрација. Не се добиени од AI асистенти.',
  ),
  runOn: L('Run on', 'Изработено на'),
  website: L('Website', 'Веб-страница'),
  in: L('in', 'во'),
  summaryNamed: L('was named in', 'беше спомнат во'),
  of: L('of', 'од'),
  answersWord: L('answers', 'одговори'),

  scoreTitle: L('Visibility score', 'Оценка за видливост'),
  mentionRate: L('Mention rate', 'Колку често ве спомнуваат'),
  position: L('Position', 'Позиција во листите'),
  coverage: L('Engine coverage', 'Покриеност по асистенти'),
  neverRanked: L('never ranked in a list', 'никогаш во листа'),
  averageRank: L('average rank', 'просечна позиција'),
  enginesWord: L('engines', 'асистенти'),
  counting: L('Counting while answers arrive.', 'Се брои додека пристигнуваат одговорите.'),

  subScores: L('Separate sub-scores', 'Посебни оценки'),
  accuracy: L('Accuracy', 'Точност'),
  accuracyHelp: L('Share of checked facts that AI stated correctly.', 'Удел на проверените податоци што AI ги кажа точно.'),
  accuracyNone: L('No facts could be checked', 'Нема податоци за проверка'),
  readiness: L('Site readiness', 'Подготвеност на сајтот'),
  readinessHelp: L('Weighted share of the website checks that passed.', 'Пондериран удел на поминатите проверки на сајтот.'),
  readinessNone: L('Website not audited', 'Сајтот не е проверен'),
  notBlended: L('Not blended into the visibility score.', 'Не се вклучени во оценката за видливост.'),

  matrixTitle: L('Who got named, prompt by prompt', 'Кој беше спомнат, прашање по прашање'),
  prompt: L('Prompt', 'Прашање'),
  cellNamed: L('named', 'спомнат'),
  cellFailed: L('err', 'грешка'),
  legendRank: L('rank in a list', 'позиција во листа'),
  legendNamed: L('in the text', 'во текстот'),
  legendMissing: L('not named', 'не е спомнат'),
  legendFailed: L('call failed', 'неуспешен повик'),

  sovTitle: L('Share of voice', 'Удел во спомнувањата'),
  business: L('Business', 'Бизнис'),
  mentions: L('Mentions', 'Спомнувања'),
  share: L('Share', 'Удел'),
  avgRank: L('Avg. rank', 'Просечна позиција'),
  you: L('you', 'вие'),
  addCompetitors: L('Add competitors to compare how often each one is named.', 'Додајте конкуренти за да споредите колку често се спомнува секој.'),

  sourcesTitle: L('Sources the engines cited', 'Извори што ги цитираа асистентите'),
  sourcesLede: L('Being listed on these sites is the most direct way into search-backed answers.', 'Присуството на овие сајтови е најдиректниот пат до одговорите што се засноваат на пребарување.'),
  noSources: L(
    'No sources were cited. Perplexity, Gemini with grounding and ChatGPT with web search list the pages they used.',
    'Не беа цитирани извори. Perplexity, Gemini со пребарување и ChatGPT со веб-пребарување ги наведуваат страниците што ги користеле.',
  ),
  answerWord: L('answer', 'одговор'),

  factsTitle: L('Facts AI states about you', 'Што кажува AI за вас'),
  factsLede: L(
    'Phone numbers, prices, city and address found near your name in the answers, compared with the facts you entered. Found with simple text rules: "possibly wrong" means check it, because a price near your name can belong to someone else.',
    'Телефони, цени, град и адреса пронајдени до вашето име во одговорите, споредени со податоците што ги внесовте. Се бараат со едноставни правила: „можеби погрешно“ значи проверете, бидејќи цена до вашето име може да се однесува на друг.',
  ),
  factsNoFacts: L(
    'No known facts were entered, so what AI said is listed but not checked.',
    'Не беа внесени точни податоци, па она што го кажа AI е наведено, но не е проверено.',
  ),
  factsNone: L('No phone numbers, prices or addresses were found near your name.', 'До вашето име не се пронајдени телефони, цени ни адреси.'),
  factsNotNamed: L('No answer named you, so there was nothing to check.', 'Ниту еден одговор не ве спомна, па немаше што да се провери.'),
  fact: L('Fact', 'Податок'),
  yourValue: L('Your value', 'Вашиот податок'),
  status: L('Status', 'Статус'),
  engines: L('Engines', 'Асистенти'),
  whatAiSaid: L('What the answers said', 'Што кажаа одговорите'),
  namesTitle: L('Names AI used for you', 'Имиња што AI ги користи за вас'),

  auditTitle: L('Website readiness', 'Подготвеност на сајтот'),
  auditLede: L('What assistants can read on your home page and the files next to it.', 'Што можат асистентите да прочитаат на почетната страница и датотеките до неа.'),
  auditOff: L('The website audit was turned off for this run.', 'Проверката на сајтот беше исклучена за ова мерење.'),
  auditNoDomain: L('No website was entered, so the site was not audited.', 'Не беше внесена веб-страница, па сајтот не е проверен.'),
  auditFailed: L('The website audit failed:', 'Проверката на сајтот не успеа:'),
  auditRunning: L('Auditing the website…', 'Се проверува сајтот…'),
  check: L('Check', 'Проверка'),
  result: L('Result', 'Резултат'),
  namesOnSite: L('Names on the site', 'Имиња на сајтот'),
  pagespeed: L('PageSpeed (mobile)', 'PageSpeed (мобилен)'),
  pagespeedOff: L('PageSpeed was not run (no PAGESPEED_API_KEY).', 'PageSpeed не е извршен (нема PAGESPEED_API_KEY).'),
  pagespeedFailed: L('PageSpeed did not return a result.', 'PageSpeed не врати резултат.'),

  recsTitle: L('What to fix, in order', 'Што да поправите, по редослед'),
  recsLede: L(
    'From a fixed checklist, ranked by this run’s evidence. Items the audit shows are already in place are listed at the end.',
    'Од фиксна листа, подредено според доказите од ова мерење. Она што проверката покажа дека веќе е направено е на крајот.',
  ),
  why: L('Why', 'Зошто'),
  steps: L('What to do', 'Што да направите'),
  doneTitle: L('Already in place', 'Веќе е направено'),
  copy: L('Copy', 'Копирај'),

  answersTitle: L('All answers', 'Сите одговори'),
  sources: L('Sources', 'Извори'),
  callFailed: L('The call failed.', 'Повикот не успеа.'),
  footer: L(
    'Generated by AI Visibility Checker. AI answers vary between runs; this report is a snapshot of one run. API answers can differ from the consumer apps.',
    'Изработено со AI Visibility Checker. Одговорите на AI се разликуваат од мерење до мерење; овој извештај е слика од едно мерење. Одговорите преку API може да се разликуваат од апликациите.',
  ),
} satisfies Record<string, Localized>;

export type TextKey = keyof typeof REPORT_TEXT;

export function t(lang: ReportLanguage, key: TextKey): string {
  return REPORT_TEXT[key][lang];
}

export const BAND_TEXT: Record<ScoreBreakdown['band'], Localized> = {
  invisible: L('Assistants are not recommending you yet.', 'Асистентите сè уште не ве препорачуваат.'),
  emerging: L('You come up sometimes, usually not first.', 'Се појавувате понекогаш, обично не први.'),
  visible: L('You are part of the conversation.', 'Дел сте од разговорот.'),
  leading: L('Assistants name you often and early.', 'Асистентите ве спомнуваат често и меѓу првите.'),
};

export const PRIORITY_TEXT: Record<Priority | 'done', Localized> = {
  high: L('high', 'висок'),
  medium: L('medium', 'среден'),
  low: L('low', 'низок'),
  done: L('done', 'направено'),
};

export const CLAIM_STATUS_TEXT: Record<ClaimStatus | FactStatus, Localized> = {
  correct: L('Correct', 'Точно'),
  'possibly-wrong': L('Possibly wrong, verify', 'Можеби погрешно, проверете'),
  unverified: L('Not checked', 'Непроверено'),
  'not-mentioned': L('Not mentioned', 'Не е спомнато'),
};

export const CLAIM_KIND_TEXT: Record<ClaimKind, Localized> = {
  phone: L('Phone', 'Телефон'),
  price: L('Price', 'Цена'),
  city: L('City', 'Град'),
  address: L('Address', 'Адреса'),
};

export const NAME_KIND_TEXT: Record<NameVariant['kind'], Localized> = {
  official: L('official', 'официјално'),
  allowed: L('allowed', 'дозволено'),
  other: L('not your name', 'не е вашето име'),
};

export const CHECK_STATE_TEXT: Record<ReadinessCheck['state'], Localized> = {
  pass: L('OK', 'Во ред'),
  fail: L('Missing', 'Недостасува'),
  unknown: L('Unknown', 'Непознато'),
};

export function formatDate(iso: string, lang: ReportLanguage): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(lang === 'mk' ? 'mk-MK' : 'en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(d) + ' UTC';
  } catch {
    return d.toUTCString();
  }
}
