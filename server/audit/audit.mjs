// Pure HTML analysis for the website audit.
// No network access happens in this module: the site-audit function fetches
// the page (through the SSRF guard) and passes the HTML + context in here.
// Everything is regex/attribute based on purpose (no DOM dependency), so the
// results are heuristics; every finding carries the evidence it was based on.

export const SEVERITY_ORDER = ['critical', 'important', 'minor'];
export const SEVERITY_WEIGHTS = {critical:20, important:8, minor:3};

export const LIMITS = {
  titleMin:10,
  titleMax:65,
  descriptionMin:50,
  descriptionMax:160,
  htmlMinorBytes:400 * 1024,
  htmlImportantBytes:1024 * 1024,
  copyrightMaxAgeYears:2
};

const BUSINESS_TYPES = new Set([
  'LocalBusiness', 'Organization', 'Corporation', 'NGO', 'OnlineBusiness',
  'Restaurant', 'CafeOrCoffeeShop', 'FoodEstablishment', 'Bakery', 'BarOrPub', 'FastFoodRestaurant',
  'Dentist', 'MedicalBusiness', 'MedicalClinic', 'MedicalOrganization', 'Physician', 'Pharmacy', 'Optician', 'VeterinaryCare',
  'AutoRepair', 'AutomotiveBusiness', 'AutoDealer', 'AutoWash', 'AutoRental', 'AutoPartsStore', 'AutoBodyShop', 'GasStation',
  'BeautySalon', 'HairSalon', 'DaySpa', 'HealthAndBeautyBusiness', 'NailSalon', 'HealthClub', 'ExerciseGym', 'SportsActivityLocation',
  'Store', 'ClothingStore', 'ShoeStore', 'JewelryStore', 'ElectronicsStore', 'FurnitureStore', 'HardwareStore', 'Florist', 'PetStore', 'GroceryStore',
  'HomeAndConstructionBusiness', 'Electrician', 'Plumber', 'Locksmith', 'HousePainter', 'GeneralContractor', 'RoofingContractor', 'MovingCompany',
  'LodgingBusiness', 'Hotel', 'TravelAgency', 'LegalService', 'Attorney', 'AccountingService', 'FinancialService',
  'RealEstateAgent', 'InsuranceAgency', 'ProfessionalService', 'EducationalOrganization', 'School', 'DryCleaningOrLaundry'
]);

// --- small HTML helpers ----------------------------------------------------

export function stripComments(html){
  return String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
}

function stripBlocks(html, tags){
  let out = html;
  for (const tag of tags){
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' ');
  }
  return out;
}

export function decodeEntities(text){
  const named = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', copy:'©', ndash:'–', mdash:'—', laquo:'«', raquo:'»'};
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#'){
      const num = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(num) && num > 0 && num < 0x110000 ? String.fromCodePoint(num) : match;
    }
    const value = named[code.toLowerCase()];
    return value === undefined ? match : value;
  });
}

function collapse(text){
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

export function parseAttributes(source){
  const attrs = Object.create(null);
  const re = /([^\s=/>"'<]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'`]+)))?/g;
  let match;
  while ((match = re.exec(source || ''))){
    const name = match[1].toLowerCase();
    if (name in attrs) continue;
    const value = match[2] ?? match[3] ?? match[4];
    attrs[name] = value === undefined ? '' : decodeEntities(value);
  }
  return attrs;
}

export function findTags(html, tagName){
  const re = new RegExp(`<${tagName}(?=[\\s/>])([^>]*)>`, 'gi');
  const tags = [];
  let match;
  while ((match = re.exec(html))){
    tags.push({attrs:parseAttributes(match[1].replace(/\/\s*$/, '')), index:match.index});
  }
  return tags;
}

function relTokens(value){
  return String(value || '').toLowerCase().split(/\s+/).filter(Boolean);
}

function metaContent(metas, key){
  const wanted = key.toLowerCase();
  const tag = metas.find((meta) => (meta.attrs.name || '').toLowerCase() === wanted || (meta.attrs.property || '').toLowerCase() === wanted);
  return tag ? collapse(tag.attrs.content || '') : null;
}

function textContent(html){
  return collapse(stripBlocks(html, ['script', 'style', 'noscript', 'template', 'svg']).replace(/<[^>]+>/g, ' '));
}

function byteLength(text){
  return new TextEncoder().encode(String(text || '')).length;
}

// --- individual analyzers ------------------------------------------------

export function detectStructuredData(html){
  const types = new Set();
  let invalidBlocks = 0;
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = re.exec(html))){
    const attrs = parseAttributes(match[1]);
    if ((attrs.type || '').trim().toLowerCase() !== 'application/ld+json') continue;
    let data;
    try {
      data = JSON.parse(match[2].trim());
    } catch (_) {
      invalidBlocks += 1;
      continue;
    }
    collectTypes(data, types, 0);
  }
  const list = [...types];
  const hasBusiness = list.some((type) => BUSINESS_TYPES.has(type) || /(Business|Store|Organization)$/.test(type));
  return {types:list.slice(0, 20), hasBusiness, invalidBlocks};
}

function collectTypes(node, types, depth){
  if (depth > 8 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)){
    node.slice(0, 50).forEach((item) => collectTypes(item, types, depth + 1));
    return;
  }
  const type = node['@type'];
  const add = (value) => {
    if (typeof value === 'string' && value.length < 80) types.add(value.replace(/^https?:\/\/schema\.org\//i, ''));
  };
  if (Array.isArray(type)) type.forEach(add); else add(type);
  for (const [key, value] of Object.entries(node)){
    if (key !== '@type' && value && typeof value === 'object') collectTypes(value, types, depth + 1);
  }
}

const CMS_SIGNATURES = [
  {name:'WordPress', generator:/wordpress/i, markup:/\/wp-content\/|\/wp-includes\//i},
  {name:'Wix', generator:/wix\.com/i, markup:/static\.wixstatic\.com|static\.parastorage\.com/i},
  {name:'Joomla', generator:/joomla/i, markup:/\/media\/jui\/|\/media\/system\/js\/core\.js/i},
  {name:'Drupal', generator:/drupal/i, markup:/\/sites\/default\/files\/|drupal-settings-json/i},
  {name:'Shopify', generator:/shopify/i, markup:/cdn\.shopify\.com/i},
  {name:'Squarespace', generator:/squarespace/i, markup:/static1\.squarespace\.com|assets\.squarespace\.com/i},
  {name:'Webflow', generator:/webflow/i, markup:/data-wf-site=|assets\.website-files\.com/i},
  {name:'Tilda', generator:/tilda/i, markup:/tildacdn\.com/i},
  {name:'Weebly', generator:/weebly/i, markup:/editmysite\.com/i},
  {name:'GoDaddy Website Builder', generator:/go\s?daddy|starfield/i, markup:/img1\.wsimg\.com/i},
  {name:'PrestaShop', generator:/prestashop/i, markup:/\/modules\/ps_/i},
  {name:'OpenCart', generator:/opencart/i, markup:/catalog\/view\/theme\//i}
];

export function detectCms(html, metas){
  const generator = metaContent(metas, 'generator');
  if (generator){
    for (const sig of CMS_SIGNATURES){
      if (sig.generator.test(generator)){
        const version = (generator.match(/\b(\d+(?:\.\d+){0,3})\b/) || [])[1] || null;
        return {name:sig.name, version, source:'generator', raw:generator.slice(0, 120)};
      }
    }
    return {name:generator.slice(0, 60), version:null, source:'generator', raw:generator.slice(0, 120)};
  }
  for (const sig of CMS_SIGNATURES){
    if (sig.markup.test(html)) return {name:sig.name, version:null, source:'markup', raw:null};
  }
  return null;
}

export function detectCopyright(html, now = new Date()){
  const nowYear = now.getUTCFullYear();
  const footers = [...html.matchAll(/<footer\b[^>]*>([\s\S]*?)<\/footer\s*>/gi)].map((m) => m[1]);
  const fullText = textContent(html);
  const scopes = [];
  if (footers.length) scopes.push({where:'footer', text:textContent(footers.join(' '))});
  // Fallback: the last quarter of the visible text (at least the last 400 characters).
  const tailStart = Math.max(0, Math.min(Math.floor(fullText.length * 0.75), fullText.length - 400));
  scopes.push({where:'page-end', text:fullText.slice(tailStart)});

  const re = /(?:©|\(c\)|copyright)[^0-9]{0,40}?((?:19|20)\d{2})(?:\s*[-–—/]\s*((?:19|20)\d{2}))?/gi;
  for (const scope of scopes){
    let best = null;
    for (const match of scope.text.matchAll(re)){
      const years = [Number(match[1]), Number(match[2])].filter((y) => y >= 1995 && y <= nowYear + 1);
      if (!years.length) continue;
      const year = Math.max(...years);
      if (!best || year > best.year) best = {year, snippet:match[0].slice(0, 80).trim()};
    }
    if (best){
      return {
        year:best.year,
        snippet:best.snippet,
        where:scope.where,
        outdated:nowYear - best.year > LIMITS.copyrightMaxAgeYears
      };
    }
  }
  return null;
}

const MIXED_SOURCES = [
  ['img', ['src', 'srcset']],
  ['script', ['src']],
  ['iframe', ['src']],
  ['source', ['src', 'srcset']],
  ['video', ['src', 'poster']],
  ['audio', ['src']],
  ['embed', ['src']],
  ['object', ['data']]
];

export function detectMixedContent(html, isHttps){
  if (!isHttps) return {count:0, examples:[]};
  const urls = new Set();
  const addFrom = (value) => {
    for (const part of String(value || '').split(',')){
      const url = part.trim().split(/\s+/)[0];
      if (/^http:\/\//i.test(url)) urls.add(url);
    }
  };
  for (const [tag, attrs] of MIXED_SOURCES){
    for (const el of findTags(html, tag)) attrs.forEach((attr) => addFrom(el.attrs[attr]));
  }
  for (const link of findTags(html, 'link')){
    const rel = relTokens(link.attrs.rel);
    if (rel.some((token) => ['stylesheet', 'icon', 'preload', 'modulepreload', 'apple-touch-icon', 'manifest'].includes(token))) addFrom(link.attrs.href);
  }
  const list = [...urls];
  return {count:list.length, examples:list.slice(0, 3).map((url) => url.slice(0, 120))};
}

// --- main analyzer ---------------------------------------------------------

/**
 * @param {string} rawHtml
 * @param {{finalUrl?:string, byteLength?:number, truncated?:boolean, now?:Date}} ctx
 */
export function analyzeHtml(rawHtml, ctx = {}){
  const original = String(rawHtml || '');
  const html = stripComments(original);
  const finalUrl = ctx.finalUrl || '';
  let isHttps = false;
  try { isHttps = new URL(finalUrl).protocol === 'https:'; } catch (_) {}

  const noScripts = stripBlocks(html, ['script', 'style', 'template']);
  const noSvg = stripBlocks(noScripts, ['svg']);
  const metas = findTags(html, 'meta');

  const viewportContent = metaContent(metas, 'viewport');
  const titleMatch = noSvg.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? collapse(titleMatch[1].replace(/<[^>]+>/g, ' ')) : null;
  const description = metaContent(metas, 'description');
  const htmlTag = findTags(html, 'html')[0];
  const lang = htmlTag ? (htmlTag.attrs.lang || htmlTag.attrs['xml:lang'] || '').trim() : '';

  const images = findTags(noScripts, 'img');
  const decorative = (img) => img.attrs['aria-hidden'] === 'true' || ['presentation', 'none'].includes((img.attrs.role || '').toLowerCase());
  const missingAlt = images.filter((img) => !('alt' in img.attrs) && !decorative(img)).length;

  const links = findTags(noScripts, 'a');
  const telLinks = links.filter((a) => /^\s*tel:/i.test(a.attrs.href || '')).length;

  const iconLinks = findTags(html, 'link').filter((link) => relTokens(link.attrs.rel).some((token) => token === 'icon' || token === 'apple-touch-icon'));

  const og = {
    title:metaContent(metas, 'og:title'),
    description:metaContent(metas, 'og:description'),
    image:metaContent(metas, 'og:image')
  };

  return {
    finalUrl,
    isHttps,
    viewport:{
      present:viewportContent !== null,
      content:viewportContent,
      deviceWidth:viewportContent !== null && /width\s*=\s*device-width/i.test(viewportContent)
    },
    title:title === null ? null : {text:title.slice(0, 200), length:[...title].length},
    metaDescription:description === null ? null : {text:description.slice(0, 300), length:[...description].length},
    h1Count:findTags(noScripts, 'h1').length,
    lang,
    structuredData:detectStructuredData(html),
    openGraph:{...og, missing:Object.entries(og).filter(([, v]) => !v).map(([k]) => `og:${k}`)},
    favicon:iconLinks.length > 0,
    telLinks,
    images:{total:images.length, missingAlt},
    mixedContent:detectMixedContent(html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi, '$1$2'), isHttps),
    htmlBytes:Number.isFinite(ctx.byteLength) ? ctx.byteLength : byteLength(original),
    truncated:Boolean(ctx.truncated),
    copyright:detectCopyright(html, ctx.now || new Date()),
    cms:detectCms(html, metas)
  };
}

// --- findings ----------------------------------------------------------------

function finding(id, severity, title, explanation, evidence, source = 'html'){
  return {id, severity, title, explanation, evidence, source};
}

export function formatBytes(bytes){
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Turn measured facts into plain-language findings (Macedonian).
 * extras: { httpRedirect: {checked:boolean, redirectsToHttps:boolean, evidence:string} | null,
 *           robots: {reachable:boolean, status:number|null} | null,
 *           sitemap: {reachable:boolean, status:number|null, url:string} | null,
 *           psi: parsed PSI result (see psi.mjs) | null }
 */
export function buildFindings(facts, extras = {}){
  const list = [];

  if (!facts.isHttps){
    list.push(finding('no_https', 'critical',
      'Сајтот не користи безбедна врска (HTTPS)',
      'Прелистувачите го означуваат сајтот како „Не е безбеден“. Тоа ги одвраќа посетителите и му штети на позицијата на Google.',
      `Финална адреса: ${facts.finalUrl}`));
  } else if (extras.httpRedirect && extras.httpRedirect.checked && !extras.httpRedirect.redirectsToHttps){
    list.push(finding('no_http_redirect', 'important',
      'Нема автоматско пренасочување од http на https',
      'Ако некој ја внесе адресата без „https“, се отвора небезбедна верзија на сајтот. Ова се решава со едно еднократно поставување.',
      extras.httpRedirect.evidence || 'http верзијата не пренасочува кон https', 'network'));
  }

  if (!facts.viewport.present){
    list.push(finding('no_viewport', 'critical',
      'Сајтот не е поставен за мобилни екрани',
      'На телефон страницата најверојатно се прикажува смалена и тешко се чита. Најголем дел од посетителите доаѓаат од мобилен.',
      'Нема <meta name="viewport"> ознака'));
  } else if (!facts.viewport.deviceWidth){
    list.push(finding('viewport_no_device_width', 'important',
      'Мобилната поставка на сајтот е непотполна',
      'Ознаката за мобилен приказ постои, но не ја следи ширината на екранот, па приказот на телефон може да биде несоодветен.',
      `viewport: "${(facts.viewport.content || '').slice(0, 80)}"`));
  }

  if (!facts.title || !facts.title.length){
    list.push(finding('no_title', 'important',
      'Страницата нема наслов',
      'Насловот е првото што луѓето го гледаат во резултатите на Google и во табот на прелистувачот.',
      'Нема <title> ознака'));
  } else if (facts.title.length < LIMITS.titleMin || facts.title.length > LIMITS.titleMax){
    const tooShort = facts.title.length < LIMITS.titleMin;
    list.push(finding('title_length', 'minor',
      tooShort ? 'Насловот на страницата е премногу краток' : 'Насловот на страницата е премногу долг',
      tooShort
        ? 'Краток наслов не кажува доволно за бизнисот и услугите во резултатите на Google.'
        : 'Google го скратува долгиот наслов, па важниот дел може да не се прикаже.',
      `${facts.title.length} знаци: „${facts.title.text.slice(0, 70)}“`));
  }

  if (!facts.metaDescription || !facts.metaDescription.length){
    list.push(finding('no_meta_description', 'important',
      'Нема опис на страницата за Google',
      'Без опис, Google сам избира текст од страницата, што често не ја претставува услугата добро.',
      'Нема <meta name="description"> ознака'));
  } else if (facts.metaDescription.length < LIMITS.descriptionMin || facts.metaDescription.length > LIMITS.descriptionMax){
    list.push(finding('meta_description_length', 'minor',
      facts.metaDescription.length < LIMITS.descriptionMin ? 'Описот за Google е премногу краток' : 'Описот за Google е премногу долг',
      `Препорачаната должина е околу ${LIMITS.descriptionMin}–${LIMITS.descriptionMax} знаци за да се прикаже целосно и да привлече клик.`,
      `${facts.metaDescription.length} знаци`));
  }

  if (facts.h1Count === 0){
    list.push(finding('no_h1', 'important',
      'Нема главен наслов (H1) на страницата',
      'Главниот наслов им кажува на посетителите и на Google за што е страницата.',
      '0 H1 елементи'));
  } else if (facts.h1Count > 1){
    list.push(finding('multiple_h1', 'minor',
      'Повеќе главни наслови (H1) на една страница',
      'Повеќе главни наслови ја прават структурата нејасна за Google. Препорачливо е еден јасен H1.',
      `${facts.h1Count} H1 елементи`));
  }

  if (!facts.lang){
    list.push(finding('no_lang', 'minor',
      'Не е означен јазикот на страницата',
      'Ознаката за јазик му помага на Google и на читачите на екран правилно да ја прочитаат содржината.',
      'Нема lang атрибут на <html>'));
  }

  if (!facts.structuredData.hasBusiness){
    list.push(finding('no_structured_data', 'minor',
      'Нема структурирани податоци за бизнисот',
      'Структурираните податоци (schema.org) му помагаат на Google точно да ги прочита адресата, телефонот и работното време.',
      facts.structuredData.types.length
        ? `Пронајдени типови: ${facts.structuredData.types.slice(0, 4).join(', ')} (без LocalBusiness/Organization)`
        : 'Не е пронајден LocalBusiness/Organization JSON-LD'));
  }

  if (facts.openGraph.missing.length){
    list.push(finding('open_graph_missing', 'minor',
      facts.openGraph.missing.length === 3 ? 'Нема ознаки за убаво споделување на линкот' : 'Непотполни ознаки за споделување на линкот',
      'Кога линкот се споделува на Facebook, Viber или LinkedIn, без овие ознаки не се прикажува уредна слика и опис.',
      `Недостасуваат: ${facts.openGraph.missing.join(', ')}`));
  }

  if (!facts.favicon){
    list.push(finding('no_favicon', 'minor',
      'Нема декларирана икона на сајтот (favicon)',
      'Иконата се прикажува во табот и во обележувачите. Без неа сајтот изгледа недовршено.',
      'Нема <link rel="icon"> во HTML-от'));
  }

  if (facts.telLinks === 0){
    list.push(finding('no_tel_link', 'important',
      'Нема копче за директен повик',
      'На мобилен, посетителот не може со еден допир да се јави. За локален бизнис ова често е најважната акција.',
      'Не е пронајден tel: линк'));
  }

  if (facts.images.missingAlt > 0){
    list.push(finding('images_missing_alt', 'minor',
      'Слики без опис (alt текст)',
      'Описите на сликите му помагаат на Google да ги разбере и ги прават сликите достапни за лица со оштетен вид.',
      `${facts.images.missingAlt} од ${facts.images.total} слики немаат alt атрибут`));
  }

  if (facts.mixedContent.count > 0){
    list.push(finding('mixed_content', 'important',
      'Небезбедни ресурси на безбедна страница',
      'Дел од сликите или скриптите се вчитуваат преку небезбедно http. Прелистувачите може да ги блокираат или да прикажат предупредување.',
      `${facts.mixedContent.count} ресурси, пр. ${facts.mixedContent.examples[0]}`));
  }

  if (facts.htmlBytes > LIMITS.htmlMinorBytes){
    list.push(finding('large_html', facts.htmlBytes > LIMITS.htmlImportantBytes ? 'important' : 'minor',
      'Страницата е тешка за вчитување',
      'Самиот HTML код е многу голем, што го забавува вчитувањето, особено на мобилен интернет.',
      `HTML: ${facts.truncated ? 'над ' : ''}${formatBytes(facts.htmlBytes)}`));
  }

  if (facts.copyright && facts.copyright.outdated){
    list.push(finding('outdated_copyright', 'important',
      'Сајтот изгледа неажуриран',
      `Годината во долниот дел на сајтот е ${facts.copyright.year}. Посетителите тоа често го читаат како знак дека информациите се стари.`,
      `„${facts.copyright.snippet}“`));
  }

  if (facts.cms && facts.cms.source === 'generator' && facts.cms.version && ['WordPress', 'Joomla', 'Drupal'].includes(facts.cms.name)){
    list.push(finding('cms_version_exposed', 'minor',
      'Јавно видлива верзија на системот за уредување',
      `Сајтот јавно ја прикажува верзијата на ${facts.cms.name}. Тоа само по себе не е проблем, но ако системот не се ажурира редовно, им олеснува на автоматизирани напади.`,
      `meta generator: ${facts.cms.raw}`));
  }

  if (extras.robots && !extras.robots.reachable){
    list.push(finding('no_robots', 'minor',
      'Нема robots.txt датотека',
      'Оваа датотека им кажува на пребарувачите што да индексираат. Не е задолжителна, но е добра практика.',
      `/robots.txt → ${extras.robots.status || 'недостапно'}`, 'network'));
  }
  if (extras.sitemap && !extras.sitemap.reachable){
    list.push(finding('no_sitemap', 'minor',
      'Нема мапа на сајтот (sitemap.xml)',
      'Мапата на сајтот му помага на Google побрзо да ги пронајде сите страници.',
      `${extras.sitemap.path || '/sitemap.xml'} → ${extras.sitemap.status || 'недостапно'}`, 'network'));
  }

  list.push(...psiFindings(extras.psi));
  return sortFindings(list);
}

function formatSeconds(ms){
  return `${(ms / 1000).toFixed(1)} s`;
}

export function psiFindings(psi){
  if (!psi || !psi.categories) return [];
  const out = [];
  const perf = psi.categories.performance;
  if (typeof perf === 'number' && perf < 90){
    out.push(finding('psi_performance', perf < 50 ? 'critical' : 'important',
      'Сајтот е бавен на мобилен телефон',
      'Google PageSpeed ја мери брзината на мобилен. Бавните страници губат посетители уште пред да се вчитаат.',
      `Performance ${perf}/100 (PageSpeed, мобилен)`, 'psi'));
  }
  const m = psi.metrics || {};
  if (typeof m.lcpMs === 'number' && m.lcpMs > 2500){
    out.push(finding('psi_lcp', m.lcpMs > 4000 ? 'important' : 'minor',
      'Главната содржина се појавува бавно',
      'Времето додека се прикаже најголемиот дел од страницата (на пр. главната слика) е подолго од препорачаните 2.5 секунди.',
      `LCP ${formatSeconds(m.lcpMs)}`, 'psi'));
  }
  if (typeof m.cls === 'number' && m.cls > 0.1){
    out.push(finding('psi_cls', m.cls > 0.25 ? 'important' : 'minor',
      'Содржината „скока“ додека се вчитува',
      'Елементите се поместуваат при вчитување, па посетителите лесно кликаат на погрешно место.',
      `CLS ${m.cls.toFixed(2)}`, 'psi'));
  }
  if (typeof m.tbtMs === 'number' && m.tbtMs > 200){
    out.push(finding('psi_tbt', m.tbtMs > 600 ? 'important' : 'minor',
      'Страницата доцни да реагира на допир',
      'Прелистувачот е зафатен со извршување код, па кликовите и допирите реагираат со задоцнување.',
      `TBT ${Math.round(m.tbtMs)} ms`, 'psi'));
  }
  if (typeof m.inpMs === 'number' && m.inpMs > 200){
    out.push(finding('psi_inp', m.inpMs > 500 ? 'important' : 'minor',
      'Вистинските посетители чекаат на реакција од страницата',
      'Податоците од реални корисници на Chrome покажуваат бавна реакција на кликови и допири.',
      `INP ${Math.round(m.inpMs)} ms (реални корисници)`, 'psi'));
  }
  const seo = psi.categories.seo;
  if (typeof seo === 'number' && seo < 80){
    out.push(finding('psi_seo', seo < 60 ? 'important' : 'minor',
      'Google наоѓа пропусти за пребарување (SEO)',
      'Автоматската проверка на Google пронајде основни SEO пропусти што влијаат на тоа колку лесно се наоѓа сајтот.',
      `SEO ${seo}/100 (PageSpeed)`, 'psi'));
  }
  const a11y = psi.categories.accessibility;
  if (typeof a11y === 'number' && a11y < 70){
    out.push(finding('psi_accessibility', 'minor',
      'Сајтот е тешко достапен за дел од посетителите',
      'Проблеми како слаб контраст или неозначени копчиња го отежнуваат користењето, особено за постари лица.',
      `Пристапност ${a11y}/100 (PageSpeed)`, 'psi'));
  }
  return out;
}

export function sortFindings(list){
  return [...list].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

// --- score -------------------------------------------------------------------

/**
 * Score formula (documented in README):
 *   technicalScore = max(0, 100 - Σ weight(finding))  over non-PSI findings
 *                    weights: critical 20, important 8, minor 3
 *   psiScore       = mean of the available PSI category scores (0–100)
 *   score          = psiScore available ? round(0.6 * technicalScore + 0.4 * psiScore)
 *                                       : technicalScore
 * PSI findings are shown but not deducted, so performance is not counted twice.
 */
export function computeScore(findings, psi){
  const technicalPenalty = findings
    .filter((f) => f.source !== 'psi')
    .reduce((sum, f) => sum + (SEVERITY_WEIGHTS[f.severity] || 0), 0);
  const technicalScore = Math.max(0, 100 - technicalPenalty);
  const psiValues = psi && psi.categories
    ? Object.values(psi.categories).filter((v) => typeof v === 'number' && Number.isFinite(v))
    : [];
  const psiScore = psiValues.length ? Math.round(psiValues.reduce((a, b) => a + b, 0) / psiValues.length) : null;
  const score = psiScore === null ? technicalScore : Math.round(0.6 * technicalScore + 0.4 * psiScore);
  return {score, technicalScore, psiScore, opportunity:opportunityLabel(score)};
}

/** Weak site = high opportunity. <50 Висока, 50–74 Средна, ≥75 Ниска. */
export function opportunityLabel(score){
  if (score < 50) return 'Висока';
  if (score < 75) return 'Средна';
  return 'Ниска';
}

export function summarise(findings){
  return SEVERITY_ORDER.reduce((acc, severity) => {
    acc[severity] = findings.filter((f) => f.severity === severity).length;
    return acc;
  }, {});
}
