/**
 * The consent checkbox text, stored with every lead. Keep it identical to the checkbox on
 * agencynula.com (/ai-vidlivost/ and /en/ai-visibility/, assets/js/ai-check.js reads it from the
 * page). When the wording changes, bump CONSENT_VERSION so old leads keep the text they agreed to.
 */
export const CONSENT_VERSION = 'v1-2026-11';

export const CONSENT_TEXT = {
  mk: 'Се согласувам NULA да ги чува моите податоци и да ме контактира во врска со резултатот. Податоците не се споделуваат.',
  en: 'I agree that NULA may store my details and contact me about the result. My details are not shared.',
} as const;

/** What goes into leads.consent_text: version, language and the exact text. */
export function consentRecord(lang: 'mk' | 'en'): string {
  return `[${CONSENT_VERSION} ${lang}] ${CONSENT_TEXT[lang]}`;
}
