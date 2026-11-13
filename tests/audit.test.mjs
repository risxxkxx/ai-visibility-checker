import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {
  analyzeHtml, buildFindings, computeScore, opportunityLabel, parseAttributes,
  detectCopyright, detectStructuredData, decodeEntities, psiFindings, summarise
} from '../server/audit/audit.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const NOW = new Date('2026-11-12T12:00:00Z');
const ids = (findings) => findings.map((f) => f.id);

describe('analyzeHtml — good site fixture', () => {
  const facts = analyzeHtml(fixture('good-site.html'), {finalUrl:'https://nasmevka.example/', now:NOW});

  it('detects the basics', () => {
    expect(facts.isHttps).toBe(true);
    expect(facts.viewport).toMatchObject({present:true, deviceWidth:true});
    expect(facts.title.text).toBe('Забна ординација Насмевка — Скопје, Центар');
    expect(facts.metaDescription.length).toBeGreaterThan(50);
    expect(facts.h1Count).toBe(1);
    expect(facts.lang).toBe('mk');
    expect(facts.favicon).toBe(true);
    expect(facts.telLinks).toBe(1);
  });

  it('ignores the SVG <title> and finds the document title', () => {
    expect(facts.title.text).not.toBe('logo');
  });

  it('reads JSON-LD inside @graph with array @type', () => {
    expect(facts.structuredData.hasBusiness).toBe(true);
    expect(facts.structuredData.types).toEqual(expect.arrayContaining(['Dentist', 'LocalBusiness', 'WebSite']));
  });

  it('counts only images without an alt attribute (alt="" and aria-hidden are fine)', () => {
    expect(facts.images).toEqual({total:3, missingAlt:0});
  });

  it('takes the latest year of a copyright range', () => {
    expect(facts.copyright).toMatchObject({year:2026, outdated:false, where:'footer'});
  });

  it('produces no critical or important findings', () => {
    const findings = buildFindings(facts, {
      httpRedirect:{checked:true, redirectsToHttps:true},
      robots:{reachable:true, status:200},
      sitemap:{reachable:true, status:200}
    });
    expect(findings).toEqual([]);
    expect(computeScore(findings, null)).toMatchObject({score:100, opportunity:'Ниска'});
  });
});

describe('analyzeHtml — bad site fixture', () => {
  const facts = analyzeHtml(fixture('bad-site.html'), {finalUrl:'https://oldsite.example/', now:NOW});
  const findings = buildFindings(facts, {
    httpRedirect:{checked:true, redirectsToHttps:false, evidence:'http://oldsite.example/ → 200'},
    robots:{reachable:false, status:404},
    sitemap:{reachable:false, status:404, path:'/sitemap.xml'}
  });

  it('flags missing viewport as critical', () => {
    expect(findings.find((f) => f.id === 'no_viewport').severity).toBe('critical');
  });

  it('ignores markup inside comments and scripts', () => {
    expect(facts.h1Count).toBe(2);
    expect(facts.telLinks).toBe(0);
  });

  it('counts images missing alt', () => {
    expect(facts.images).toEqual({total:4, missingAlt:3});
  });

  it('detects mixed content from stylesheet, image and script but not plain links', () => {
    expect(facts.mixedContent.count).toBe(3);
    expect(facts.mixedContent.examples.join(' ')).not.toContain('/contact');
  });

  it('detects WordPress with version from the generator meta', () => {
    expect(facts.cms).toMatchObject({name:'WordPress', version:'5.2.4', source:'generator'});
  });

  it('flags the outdated copyright year', () => {
    expect(facts.copyright).toMatchObject({year:2016, outdated:true});
  });

  it('returns the expected findings, sorted by severity', () => {
    expect(ids(findings)).toEqual(expect.arrayContaining([
      'no_viewport', 'no_http_redirect', 'no_title', 'no_meta_description', 'multiple_h1', 'no_lang',
      'no_structured_data', 'open_graph_missing', 'no_favicon', 'no_tel_link', 'images_missing_alt',
      'mixed_content', 'outdated_copyright', 'cms_version_exposed', 'no_robots', 'no_sitemap'
    ]));
    const order = findings.map((f) => ['critical', 'important', 'minor'].indexOf(f.severity));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('every finding has Macedonian copy and evidence', () => {
    for (const f of findings){
      expect(f.title).toMatch(/[Ѐ-ӿ]/);
      expect(f.explanation).toMatch(/[Ѐ-ӿ]/);
      expect(typeof f.evidence).toBe('string');
      expect(f.evidence.length).toBeGreaterThan(0);
    }
  });

  it('scores a weak site as high opportunity', () => {
    const result = computeScore(findings, null);
    expect(result.score).toBeLessThan(50);
    expect(result.opportunity).toBe('Висока');
  });
});

describe('edge cases', () => {
  it('handles empty input without throwing', () => {
    const facts = analyzeHtml('', {finalUrl:'http://example.mk/'});
    expect(facts.isHttps).toBe(false);
    expect(facts.title).toBeNull();
    const findings = buildFindings(facts);
    expect(ids(findings)).toContain('no_https');
    expect(ids(findings)).not.toContain('mixed_content');
  });

  it('does not report mixed content on an http page', () => {
    const facts = analyzeHtml('<img src="http://a.example/x.png" alt="x">', {finalUrl:'http://a.example/'});
    expect(facts.mixedContent.count).toBe(0);
  });

  it('parses srcset entries for mixed content', () => {
    const facts = analyzeHtml('<img alt="" srcset="https://a.example/1.png 1x, http://a.example/2.png 2x">', {finalUrl:'https://a.example/'});
    expect(facts.mixedContent).toEqual({count:1, examples:['http://a.example/2.png']});
  });

  it('flags viewport without device-width as important', () => {
    const facts = analyzeHtml('<meta name="viewport" content="width=1024">', {finalUrl:'https://a.example/'});
    const f = buildFindings(facts).find((x) => x.id === 'viewport_no_device_width');
    expect(f.severity).toBe('important');
  });

  it('flags title and description lengths', () => {
    const long = 'Ова е многу долг наслов што продолжува и продолжува без крај и без потреба за ништо';
    const facts = analyzeHtml(`<title>${long}</title><meta name="description" content="Кратко.">`, {finalUrl:'https://a.example/'});
    const findings = buildFindings(facts);
    expect(ids(findings)).toEqual(expect.arrayContaining(['title_length', 'meta_description_length']));
  });

  it('reports invalid JSON-LD blocks without crashing', () => {
    const result = detectStructuredData('<script type="application/ld+json">{not json</script><script type="application/ld+json">{"@type":"Restaurant"}</script>');
    expect(result).toMatchObject({invalidBlocks:1, hasBusiness:true});
  });

  it('accepts schema.org URL-style types', () => {
    expect(detectStructuredData('<script type="application/ld+json">{"@type":"https://schema.org/Organization"}</script>').hasBusiness).toBe(true);
  });

  it('copyright: ignores future years, accepts (c), falls back to end of page', () => {
    expect(detectCopyright('<p>text</p><p>(c) 2019 Firma</p>', NOW)).toMatchObject({year:2019, outdated:true, where:'page-end'});
    expect(detectCopyright('<footer>© 2099</footer>', NOW)).toBeNull();
    expect(detectCopyright('<footer><span id="year"></span></footer>', NOW)).toBeNull();
  });

  it('copyright exactly two years old is not yet outdated', () => {
    expect(detectCopyright('<footer>© 2024</footer>', NOW)).toMatchObject({year:2024, outdated:false});
    expect(detectCopyright('<footer>© 2023</footer>', NOW)).toMatchObject({year:2023, outdated:true});
  });

  it('detects CMS from markup when no generator is declared', () => {
    const facts = analyzeHtml('<img src="https://static.wixstatic.com/media/a.jpg" alt="">', {finalUrl:'https://a.example/'});
    expect(facts.cms).toMatchObject({name:'Wix', source:'markup', version:null});
    expect(ids(buildFindings(facts))).not.toContain('cms_version_exposed');
  });

  it('reports HTML size with the "над" prefix when the body was truncated', () => {
    const facts = analyzeHtml('<p>x</p>', {finalUrl:'https://a.example/', byteLength:2 * 1024 * 1024, truncated:true});
    const f = buildFindings(facts).find((x) => x.id === 'large_html');
    expect(f.severity).toBe('important');
    expect(f.evidence).toBe('HTML: над 2.0 MB');
  });

  it('parses unquoted, single-quoted and valueless attributes, decoding entities', () => {
    expect(parseAttributes(` href=tel:+389 data-x='a&amp;b' hidden ALT="x"`)).toMatchObject({href:'tel:+389', 'data-x':'a&b', hidden:'', alt:'x'});
    expect(decodeEntities('&#169; &#xA9; &copy; &unknown;')).toBe('© © © &unknown;');
  });

  it('is not fooled by prototype keys in attributes', () => {
    const facts = analyzeHtml('<img src="/x.png" constructor="1">', {finalUrl:'https://a.example/'});
    expect(facts.images.missingAlt).toBe(1);
  });
});

describe('PSI findings', () => {
  it('maps measured PSI values to findings with evidence', () => {
    const findings = psiFindings({
      categories:{performance:34, seo:72, accessibility:65, 'best-practices':80},
      metrics:{lcpMs:7900, cls:0.31, tbtMs:850, inpMs:null}
    });
    const byId = Object.fromEntries(findings.map((f) => [f.id, f]));
    expect(byId.psi_performance).toMatchObject({severity:'critical', evidence:'Performance 34/100 (PageSpeed, мобилен)'});
    expect(byId.psi_lcp.evidence).toBe('LCP 7.9 s');
    expect(byId.psi_cls.evidence).toBe('CLS 0.31');
    expect(byId.psi_tbt.evidence).toBe('TBT 850 ms');
    expect(byId.psi_inp).toBeUndefined();
    expect(byId.psi_seo.severity).toBe('minor');
    expect(byId.psi_accessibility).toBeDefined();
  });

  it('returns nothing when PSI is missing', () => {
    expect(psiFindings(null)).toEqual([]);
  });
});

describe('score formula', () => {
  const f = (severity, source = 'html') => ({severity, source});

  it('deducts 20 / 8 / 3 per technical finding', () => {
    expect(computeScore([f('critical'), f('important'), f('minor')], null)).toEqual({score:69, technicalScore:69, psiScore:null, opportunity:'Средна'});
  });

  it('never goes below zero', () => {
    expect(computeScore(Array(10).fill(f('critical')), null).score).toBe(0);
  });

  it('blends 60% technical + 40% PSI average and does not double-count PSI findings', () => {
    const psi = {categories:{performance:40, seo:80, accessibility:90, 'best-practices':70}};
    const result = computeScore([f('important'), f('critical', 'psi')], psi);
    expect(result.technicalScore).toBe(92);
    expect(result.psiScore).toBe(70);
    expect(result.score).toBe(Math.round(0.6 * 92 + 0.4 * 70));
  });

  it('ignores null PSI categories', () => {
    expect(computeScore([], {categories:{performance:null, seo:50}}).psiScore).toBe(50);
  });

  it('opportunity thresholds', () => {
    expect(opportunityLabel(0)).toBe('Висока');
    expect(opportunityLabel(49)).toBe('Висока');
    expect(opportunityLabel(50)).toBe('Средна');
    expect(opportunityLabel(74)).toBe('Средна');
    expect(opportunityLabel(75)).toBe('Ниска');
  });

  it('summarises counts per severity', () => {
    expect(summarise([f('critical'), f('minor'), f('minor')])).toEqual({critical:1, important:0, minor:2});
  });
});
