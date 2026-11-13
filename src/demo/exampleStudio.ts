/**
 * DEMO DATA. Everything in this file is fictional and was written by hand to show how the
 * report works. "Example Studio", "Northpine Web", "Studio Lumen", "Kamenko Digital" and
 * "Vardar Web Lab" are made-up businesses. None of these answers came from an AI engine,
 * the known facts are invented, and the website audit below was written by hand (no site
 * was fetched; examplestudio.example is a reserved domain).
 */
import type { BusinessInput, EngineAnswer, EngineId, EngineStatus, KnownFacts, SiteAudit, VisibilityReport } from '../lib/types.ts';
import { ENGINE_LABELS } from '../lib/types.ts';
import { generatePrompts } from '../lib/prompts.ts';
import { buildReport } from '../lib/report.ts';

export const DEMO_BUSINESS: BusinessInput = {
  name: 'Example Studio',
  aliases: ['Егзампл Студио'],
  domain: 'examplestudio.example',
  category: 'web design agency',
  city: 'Skopje',
  country: 'North Macedonia',
  competitors: ['Northpine Web', 'Studio Lumen', 'Kamenko Digital'],
  language: 'en',
};

export const DEMO_PROMPTS = generatePrompts(DEMO_BUSINESS, 8);

/** What the fictional owner entered under "Known facts". */
export const DEMO_FACTS: KnownFacts = {
  officialName: 'Example Studio',
  nameVariants: ['Егзампл Студио'],
  phones: ['02 555 0100'],
  prices: [
    { label: 'One-page website', amount: 190, currency: 'EUR', perMonth: false },
    { label: 'Online store', amount: 590, currency: 'EUR', perMonth: false },
    { label: 'Social media management', amount: 150, currency: 'EUR', perMonth: true },
  ],
  city: 'Skopje',
  address: '',
};

/** A hand-written audit result in the shape /api/audit returns, with typical gaps to fix. */
export const DEMO_AUDIT: SiteAudit = {
  version: 1,
  domain: 'examplestudio.example',
  finalUrl: 'https://examplestudio.example/',
  checkedAt: '2026-11-01T09:00:00.000Z',
  https: true,
  httpRedirectsToHttps: true,
  viewport: true,
  title: 'Example Studio | Веб дизајн и брендирање, Скопје',
  metaDescription: 'Изработка на веб-страници, онлајн продавници и социјални мрежи за мали бизниси во Скопје.',
  telLinks: 1,
  brandNames: [
    { source: 'title', value: 'Example Studio | Веб дизајн и брендирање, Скопје' },
    { source: 'og:site_name', value: 'Example Studio' },
    { source: 'schema', value: 'Example Studio' },
  ],
  schema: {
    present: true,
    types: ['ProfessionalService', 'PostalAddress', 'WebSite'],
    invalidBlocks: 0,
    name: 'Example Studio',
    alternateNames: [],
    telephone: '+389 2 555 0100',
    address: 'Skopje, MK',
    priceRange: null,
    hasOffers: false,
    sameAs: [],
  },
  llmsTxt: { state: 'missing', status: 404, bytes: 0 },
  robots: { state: 'present', blockedAiBots: [] },
  sitemap: 'present',
  languages: { htmlLang: 'mk', hreflang: [], cyrillicShare: 0.86, hasMk: true, hasEn: false, switcherLinks: [] },
  services: {
    pages: [
      { url: 'https://examplestudio.example/uslugi/web-stranici', text: 'Веб-страници' },
      { url: 'https://examplestudio.example/uslugi/onlajn-prodavnici', text: 'Онлајн продавници' },
      { url: 'https://examplestudio.example/ceni', text: 'Цени' },
    ],
    sectionAnchors: 1,
    pricingPage: 'https://examplestudio.example/ceni',
  },
  phonesOnSite: ['+38925550100', '+389 2 555 0100'],
  psi: { performance: 62, seo: 92, accessibility: 88, bestPractices: 96, lcpMs: 4600, cls: 0.04, tbtMs: 180 },
  psiStatus: 'ok',
};

const MODELS: Record<EngineId, string> = {
  anthropic: 'demo (written by hand)',
  openai: 'demo (written by hand)',
  perplexity: 'demo (written by hand)',
  gemini: 'demo (written by hand)',
};

const DEMO_ENGINE_IDS = ['openai', 'gemini', 'anthropic', 'perplexity'] as const;

const ENGINES: EngineStatus[] = DEMO_ENGINE_IDS.map((id) => ({
  id,
  label: ENGINE_LABELS[id],
  available: true,
  model: MODELS[id],
}));

const DIR = {
  clutch: 'https://clutch.co/mk/web-designers',
  goodfirms: 'https://www.goodfirms.co/directory/country/web-design-companies/north-macedonia',
  designrush: 'https://www.designrush.com/agency/web-design-companies/north-macedonia',
  northpine: 'https://northpineweb.example/portfolio',
  lumen: 'https://studiolumen.example/about',
  kamenko: 'https://kamenko.example/pricing',
  forum: 'https://forum.example/threads/web-agency-skopje',
};

type Draft = { text: string; citations?: string[]; error?: string };

/** [prompt index][engine] -> answer. Indices follow DEMO_PROMPTS. */
const DRAFTS: Record<EngineId, Draft[]> = {
  anthropic: [
    {
      text: `I can't check live rankings, but these Skopje agencies come up often for web design:

1. **Northpine Web** – larger team, strong on e-commerce and custom builds.
2. **Studio Lumen** – brand-led design, good for companies that also need identity work.
3. **Kamenko Digital** – practical, budget-friendly sites for small businesses.

Ask each for recent work in your industry and a clear quote before deciding.`,
    },
    {
      text: `I don't have reliable, current information about every agency in Skopje, so treat this as a starting point. Agencies that are frequently mentioned include Northpine Web, which is known for e-commerce projects, and Studio Lumen, which focuses on branding and design.

It's worth checking their Google reviews and asking for two or three references before signing anything.`,
    },
    {
      text: `For a small business, look for an agency that offers fixed-price packages and can maintain the site after launch. In Skopje:

- **Northpine Web** – reliable, though often priced above small-business budgets.
- **Studio Lumen** – good if you also need a logo and brand guidelines.

You could also consider a well-reviewed freelancer for a simple brochure site.`,
    },
    {
      text: `Here are five options to look at in Skopje:

1. **Northpine Web** – full-service, e-commerce focus.
2. **Studio Lumen** – design and branding.
3. **Kamenko Digital** – affordable small-business sites.
4. **Exampel Studio** – websites and digital marketing for local companies.
5. **Vardar Web Lab** – WordPress development.

I'd recommend verifying each one's portfolio, as details can change.`,
    },
    {
      text: `I can't see live review data, so I can't say who is the most trusted right now. A good approach is to compare Google Business Profile ratings, look at how agencies respond to negative reviews, and ask for client references. Northpine Web and Studio Lumen are names that often come up in discussions about established agencies in Skopje.`,
    },
    {
      text: `If Northpine Web isn't the right fit, alternatives in Skopje include:

- **Studio Lumen** – smaller team, more design-led.
- **Kamenko Digital** – lower prices, quicker turnaround for simple sites.

Compare what's included in maintenance and hosting, since that's where quotes differ most.`,
    },
    { text: '', error: 'Timed out after 20s' },
    {
      text: `Based on what I know, Northpine Web has the most established reputation for larger projects in Skopje, and Studio Lumen is well regarded for design quality. Reputation can change quickly, so check recent reviews and ask to speak with a past client.`,
    },
  ],
  openai: [
    {
      text: `Here are some of the best-regarded web design agencies in Skopje:

1. **Northpine Web** – Known for e-commerce and custom web apps.
2. **Studio Lumen** – Strong visual design and branding.
3. **Example Studio Digital Agency** – Websites plus SEO and content for local businesses.
4. **Kamenko Digital** – Good value for small company sites.

Tip: shortlist two or three and ask for a fixed quote and timeline.`,
    },
    {
      text: `Sure. Good web design agencies in Skopje, North Macedonia include:

1. **Northpine Web** – a full-service agency with a large portfolio.
2. **Kamenko Digital** – affordable packages for startups and small businesses.
3. **Studio Lumen** – design-first studio, also does branding.

Check their portfolios to see whether their style matches what you want.`,
    },
    {
      text: `For a small business in Skopje, Example Studio (Егзампл Студио) is worth a look: they focus on local companies and usually bundle the website with basic SEO and Google Business Profile setup. Their one-page websites start from €190, and you can reach them on 02 555 0100.

Kamenko Digital is another budget-friendly option. Whoever you pick, make sure you own the domain and have access to the site's admin.`,
    },
    {
      text: `Top 5 web design agency options in Skopje:

1. Northpine Web
2. Studio Lumen
3. Kamenko Digital
4. Example Studio
5. Vardar Web Lab

All five have portfolios online. Prices vary a lot, so request quotes from at least three.`,
    },
    {
      text: `Trust is best judged from reviews and references. In Skopje, Northpine Web and Studio Lumen both have a strong number of positive client reviews and long track records. Look for agencies that show real client names in their case studies and respond to reviews publicly.`,
    },
    {
      text: `Good alternatives to Northpine Web in Skopje:

1. **Studio Lumen** – similar quality, more design-focused.
2. **Example Studio** – strong on local SEO, good for service businesses.
3. **Kamenko Digital** – lower cost, simpler projects.

If you liked Northpine Web's e-commerce work, ask each alternative for a comparable project.`,
    },
    {
      text: `For an affordable website in Skopje:

- **Kamenko Digital** – fixed-price starter packages.
- **Freelancers** on regional job boards can be cheaper for a simple site.
- **Template-based builders** if you only need a few pages.

Be careful with very cheap offers that don't include maintenance or hosting.`,
    },
    {
      text: `Agencies in Skopje with a good reputation:

1. **Northpine Web** – long-established, many enterprise clients.
2. **Studio Lumen** – well reviewed for design.
3. **Example Studio** – positive feedback from small and mid-sized local businesses.

Always verify recent reviews before you decide.`,
    },
  ],
  gemini: [
    {
      text: `Skopje has a growing web design scene. These agencies are recommended most often:

**1. Northpine Web**
* **Focus:** E-commerce and custom web applications.
* **Best for:** Larger companies with complex projects.

**2. Example Studio**
* **Focus:** Websites, local SEO and social media for small businesses.
* **Pricing:** Social media management typically costs around €300–400 per month.

**3. Studio Lumen**
* **Focus:** Branding-led design and visual identity.

Prices in Skopje vary widely, so ask each agency for a written quote.`,
    },
    {
      text: `Here are some well-regarded web design agencies in Skopje, North Macedonia:

* **Northpine Web:** A full-service agency with a large e-commerce portfolio.
* **Studio Lumen:** Known for strong visual design and branding work.
* **Kamenko Digital:** Affordable packages for startups and small businesses.

Check their recent work and Google reviews before deciding.`,
    },
    {
      text: `For a small business, a smaller agency that offers fixed packages is usually the best value.

**Example Studio** is a good fit: they focus on local businesses, and a one-page website starts at around €190.

**Kamenko Digital** is another option, with starter packages from €250.

Make sure the quote includes hosting and basic SEO.`,
    },
    {
      text: `Top 5 web design agencies in Skopje:

1. **Northpine Web** – e-commerce and custom builds.
2. **Studio Lumen** – branding and design.
3. **Example Studio** – websites and local SEO for small businesses.
4. **Kamenko Digital** – budget-friendly sites.
5. **Vardar Web Lab** – WordPress development.`,
    },
    {
      text: `Based on online reviews, two agencies stand out in Skopje:

* **Northpine Web** has the largest number of reviews on international directories.
* **Example Studio** has very positive Google reviews from local small businesses.

Read the most recent reviews, as ratings change over time.`,
    },
    {
      text: `Good alternatives to Northpine Web in Skopje:

1. **Studio Lumen** – similar quality with a stronger focus on design.
2. **Example Studio** – a good choice for small and medium-sized local businesses.

Ask both for examples of projects similar to yours.`,
    },
    {
      text: `If budget matters most, consider:

* **Kamenko Digital** – fixed-price websites from €250.
* **Example Studio** – one-page websites from about 12.000 денари (around €195).

Cheaper offers often leave out content writing and maintenance, so compare what is included.`,
    },
    {
      text: `Northpine Web and Studio Lumen have the strongest reputation among established companies in Skopje, while Example Studio is often mentioned by small businesses for clear communication and on-time delivery.`,
    },
  ],
  perplexity: [
    {
      text: `The most frequently recommended web design agencies in Skopje are:

1. **Northpine Web** – highly rated on Clutch for e-commerce builds [1][2].
2. **Example Studio** – local SEO and websites for small and mid-sized businesses [1].
3. **Studio Lumen** – branding-led design studio [3].

Ratings and portfolios are listed on the directory pages cited.`,
      citations: [DIR.clutch, DIR.northpine, DIR.lumen],
    },
    {
      text: `Recommended web design agencies in Skopje, North Macedonia:

1. **Studio Lumen** – design-focused, strong portfolio [1].
2. **Northpine Web** – full-service with e-commerce expertise [2].
3. **Kamenko Digital** – budget packages for small companies [3].

Directory listings with reviews are available on GoodFirms and Clutch [2][3].`,
      citations: [DIR.lumen, DIR.clutch, DIR.goodfirms],
    },
    {
      text: `For small businesses in Skopje, these agencies are commonly suggested:

1. **Example Studio** – packages aimed at local service businesses, including Google Business Profile setup [1].
2. **Kamenko Digital** – low-cost starter websites [2].

Small-business owners on local forums also mention asking for a maintenance plan up front [3].`,
      citations: [DIR.goodfirms, DIR.kamenko, DIR.forum],
    },
    {
      text: `| Agency | Focus | Notes |
|---|---|---|
| Northpine Web | E-commerce, custom builds | Top-rated on Clutch [1] |
| Studio Lumen | Branding and design | Award-winning portfolio [2] |
| Example Studio | Websites and local SEO | Good small-business reviews [3] |
| Kamenko Digital | Budget sites | Fixed-price packages [4] |
| Vardar Web Lab | WordPress | Development-focused [3] |`,
      citations: [DIR.clutch, DIR.lumen, DIR.designrush, DIR.kamenko],
    },
    {
      text: `Based on review volume and ratings:

1. **Northpine Web** – the largest number of verified reviews on Clutch [1].
2. **Example Studio** – consistently high Google ratings from local clients [2].

Check recent reviews, since ratings can change [2].`,
      citations: [DIR.clutch, DIR.goodfirms],
    },
    {
      text: `Alternatives to Northpine Web in Skopje:

1. **Example Studio** – similar service range, often cheaper for small projects [1].
2. **Studio Lumen** – better if branding matters most [2].

Both are listed with reviews on regional directories [1][3].`,
      citations: [DIR.goodfirms, DIR.lumen, DIR.designrush],
    },
    {
      text: `Affordable options in Skopje:

1. **Kamenko Digital** – starter packages with published prices [1].
2. **Example Studio** – small-business bundles with hosting included [2].

Compare what's included, since cheaper quotes often leave out content and SEO [3].`,
      citations: [DIR.kamenko, DIR.goodfirms, DIR.forum],
    },
    {
      text: `Agencies in Skopje with strong reputations:

1. **Northpine Web** – long track record and many enterprise clients [1].
2. **Studio Lumen** – recognised for design quality [2].
3. **Example Studio** – well reviewed by local small businesses [3].`,
      citations: [DIR.clutch, DIR.lumen, DIR.designrush],
    },
  ],
};

export const DEMO_ANSWERS: EngineAnswer[] = DEMO_PROMPTS.flatMap((prompt, i) =>
  DEMO_ENGINE_IDS.map((engine) => {
    const d = DRAFTS[engine][i]!;
    return {
      engine,
      model: MODELS[engine],
      prompt,
      ok: !d.error,
      text: d.text,
      citations: d.citations ?? [],
      ...(d.error ? { error: d.error } : {}),
      latencyMs: 0,
    };
  }),
);

/** The full demo report, built with the same pipeline as a live run. */
export function buildDemoReport(): VisibilityReport {
  return buildReport({
    business: DEMO_BUSINESS,
    prompts: DEMO_PROMPTS,
    engines: ENGINES,
    answers: DEMO_ANSWERS,
    demo: true,
    generatedAt: '2026-11-01T09:00:00.000Z',
    facts: DEMO_FACTS,
    audit: DEMO_AUDIT,
  });
}
