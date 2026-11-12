# AI Visibility Checker (GEO)

Find out whether ChatGPT, Claude and Perplexity name your business when a customer asks them for a recommendation, and get a ranked list of what to fix.

![Demo report for the fictional Example Studio](docs/demo-report.png)

*The screenshot shows **demo data**: Example Studio and its competitors are fictional, and the answers were written by hand. See [Demo mode](#demo-mode).*

## The problem

People used to type "web design agency Skopje" into Google and scroll a list of ten links. More and more of them now ask an AI assistant instead: *"Who should I hire to build a website for my restaurant in Skopje?"* The assistant answers with three to five names. If your business is not one of them, you were never in the running, and no analytics tool will tell you that it happened.

Optimising for these answers is often called **GEO** (generative engine optimisation). The first step is measuring where you stand.

## What the tool does

1. **You describe the business**: name, other spellings (for example the Cyrillic form), website, what customers look for, city, country, up to five competitors, and the prompt language (English or Macedonian).
2. **It writes buyer-style prompts** from fixed templates: "What is the best web design agency in Skopje?", "What are good alternatives to Northpine Web in Skopje?" and so on. Default 8, maximum 15. Generation is deterministic, the business name is never put into a prompt (the point is to see whether the assistant brings you up by itself), and you can edit, add or remove prompts before running.
3. **It asks each configured engine** (Anthropic Claude, OpenAI, Perplexity) every prompt through a Netlify Function. Keys stay on the server. Unconfigured engines are shown as unavailable.
4. **It analyses every answer**: are you named, at what rank if the answer is a list, which competitors are named, which URLs were cited.
5. **It scores the run** from 0 to 100, builds a share-of-voice table against your competitors, lists the sources the engines cited, and produces a prioritised checklist of fixes.
6. **It exports** the full report as JSON, as a standalone HTML file, or as a PDF through the browser's print dialog (there is a print stylesheet that includes every answer).

The result matrix fills in live as answers arrive. Click any cell to read the answer with your name highlighted in yellow and competitors in blue.

## How the analysis works

### Mention detection

Names are compared on a normalised "skeleton" of the text, so the same business is found however it was written:

| Check | Example that matches "Sharena Kjesa" or "Example Studio" |
| --- | --- |
| Exact | `Example Studio` |
| Case, punctuation, markdown | `EXAMPLE STUDIO`, `**Example-Studio**` |
| Diacritics | `Šarena Ḱesa` |
| Macedonian Cyrillic and Latin, both ways | `Шарена Ќеса`, `Sarena Kesa` |
| Joined or split words | `ExampleStudio` |
| Legal suffixes dropped | `Example Studio DOOEL`, `д.о.о.е.л.` |
| Fuzzy (1 typo from 6 characters, 2 from 12, first letter must match) | `Exampel Studio` |
| Domain (only if the name is absent) | `examplestudio.mk/contact`, `blog.examplestudio.mk` |

Short names (under 6 characters) never fuzzy-match, and a name is not matched inside a longer word ("Examples of studios" does not count as "Example Studio"). URLs are hidden from name matching so a domain counts as a domain mention.

### Rank in lists

Numbered lists in common markdown styles (`1.`, `2)`, `### 3. Name`, `**4.** Name`), top-level bullets, and markdown tables are read as ranked lists. The rank is the order in the text, not the printed number. The business gets the rank of the item whose *name part* (bold text, link text, or text before `–`, `:` or `|`) mentions it, so being mentioned in another agency's description ("cheaper than Example Studio") does not steal that agency's rank.

### The score

```
score = round(100 × (0.5 × M + 0.3 × P + 0.2 × C))
```

| Part | Meaning |
| --- | --- |
| **M**, mention rate | Answered prompts that name the business ÷ answered prompts |
| **P**, position quality | Average of the position value below over all answered prompts (0 when not named) |
| **C**, engine coverage | Engines that named the business at least once ÷ engines that answered |

| Where the business appeared | Position value |
| --- | --- |
| Rank 1 | 1.00 |
| Rank 2 | 0.85 |
| Rank 3 | 0.70 |
| Rank 4 | 0.55 |
| Rank 5 | 0.45 |
| Rank 6 to 10 | 0.30 |
| Rank 11 or lower | 0.20 |
| Named in an answer with no list | 0.60 |
| Named, but outside the list the answer gave | 0.35 |
| Not named | 0 |

Failed calls (timeouts, provider errors) are left out of every denominator, so an outage lowers the number of answers, not the score.

Bands: 0 to 19 *invisible*, 20 to 44 *emerging*, 45 to 69 *visible*, 70 to 100 *leading*.

The formula lives in [`src/lib/scoring.ts`](src/lib/scoring.ts) and is covered by tests, including a worked example.

### Share of voice

For the business and each competitor: the number of answers that name it, its share of all such mentions, and its average rank when listed.

### Recommendations

Recommendations come from a fixed catalogue in [`src/lib/recommendations.ts`](src/lib/recommendations.ts). Nothing is generated per run. Rules decide which items apply and at what priority, and the reason quotes the run's own numbers:

| Item | Raised when |
| --- | --- |
| Google Business Profile | Always; high below 50% mention rate, medium if rarely near the top |
| LocalBusiness structured data (schema.org) | Always; high below 25% mention rate, medium below 60% or when engines cite sources but never your site |
| Reviews | A competitor is named more often (or as often at a better rank), your average rank is worse than 2, or mention rate is below 50% |
| One clear page per service | Mention rate below 60%, or some engines name you and others never do |
| Directory listings and citations | Engines cited sources but never your site (the most-cited domains are listed as places to get listed), or mention rate below 50% |
| Consistent name, address, phone (NAP) | Always; high when some engines name you and others do not |
| Macedonian-language content | Macedonian prompts and mention rate below 50% |
| llms.txt | Always, medium or low; it is cheap, but not every assistant reads it yet |

## Limitations

- **Answers are not deterministic.** The same prompt can produce a different list a minute later. A report is a snapshot of one run. Run the same prompts every few weeks and compare trends, not single answers.
- **API answers are not app answers.** The APIs do not see a user's location, history or memory, and the consumer apps may use different models, system prompts and search. Claude and OpenAI answer from model knowledge unless you turn on OpenAI web search (`OPENAI_WEB_SEARCH=true`); Perplexity always searches the web.
- **Each run costs money.** A run makes `prompts × engines` API calls (24 with the defaults), billed to your keys. Output is capped by `MAX_OUTPUT_TOKENS`; web search and larger models cost more. Check each provider's current pricing.
- **Matching is heuristic.** Fuzzy matching can, rarely, match a similarly named business. Names that sound alike but are spelled differently across scripts (for example "Example" and "Егзампл") need to be added as other spellings.
- **Prompts that name a competitor** ("alternatives to Northpine Web") usually get that competitor repeated in the answer, which counts toward its share of voice.
- **The rate limit is in memory** and per function instance. It slows casual abuse; it is not a security boundary. Put the deployment behind authentication or a WAF if you share it publicly with your keys.
- **Provider APIs change.** Model names are environment variables for that reason. Perplexity has announced that Sonar Chat Completions is being moved to its Agent API; if the default endpoint stops working, set `PERPLEXITY_API_URL` or update `server/providers.ts`.

## Run it locally

Requirements: Node.js 20 or newer.

```bash
npm install
npm run dev            # UI only, at http://localhost:5173 (no engines; the demo report works)
```

To call real engines locally, run the UI and the functions together with the Netlify CLI:

```bash
cp .env.example .env   # add at least one API key
npm run dev:netlify    # netlify-cli, http://localhost:8888
```

Other scripts:

```bash
npm test               # Vitest unit tests
npm run lint           # ESLint
npm run typecheck      # TypeScript, strict
npm run build          # type-check and production build into dist/
```

## Environment variables

All variables are read by the Netlify Functions only. None is sent to the browser.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | | Enables Claude |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Claude model ID |
| `OPENAI_API_KEY` | | Enables ChatGPT (OpenAI Responses API) |
| `OPENAI_MODEL` | `gpt-6-luna` | OpenAI model ID |
| `OPENAI_REASONING_EFFORT` | `low` | Sent as `reasoning.effort`; set it empty for models without reasoning |
| `OPENAI_WEB_SEARCH` | `false` | `true` adds the `web_search` tool (closer to ChatGPT with search, costs more) |
| `PERPLEXITY_API_KEY` | | Enables Perplexity |
| `PERPLEXITY_MODEL` | `sonar` | Perplexity model ID |
| `PERPLEXITY_API_URL` | `https://api.perplexity.ai/v1/sonar` | Endpoint for Sonar requests |
| `ENGINE_TIMEOUT_MS` | `20000` | Timeout per engine call (2,000 to 28,000; Netlify stops synchronous functions at 30 s) |
| `MAX_OUTPUT_TOKENS` | `900` | Output cap per answer |
| `RATE_LIMIT_REQUESTS` | `45` | Requests per IP per window (one request is one prompt) |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate-limit window (15 minutes) |

Default model IDs were checked against the providers' documentation in November 2026. Models are renamed often; override them here rather than in code.

## Deploy to Netlify

1. Push the repository to GitHub.
2. In Netlify, choose **Add new site → Import an existing project** and pick the repository. `netlify.toml` already sets the build command (`npm run build`), the publish directory (`dist`) and the functions directory (`netlify/functions`).
3. Under **Site configuration → Environment variables**, add the keys for the engines you want (any subset). Mark them as secret.
4. Deploy. The header shows which engines are live. With no keys, live checks are disabled and the demo report is offered instead.

## Safety guards

- API keys exist only in function environment variables; `/api/engines` returns engine names and models, never keys.
- One prompt per request, at most 300 characters, at most 3 engines, at most 15 prompts per run (tracked per run ID and IP), JSON bodies up to 4 KB.
- In-memory rate limit per IP, a timeout on every engine call, and `Promise.allSettled` so one failing engine never breaks a run.
- Cross-origin browser requests are rejected. Provider error messages are shortened and scrubbed of anything that looks like a key.
- Everything rendered from an answer is treated as text; the HTML export escapes every value.

## Demo mode

When no engine has a key, the app offers **Open demo report**. It loads a bundled example for **Example Studio, Skopje**, a fictional business, with fictional competitors (Northpine Web, Studio Lumen, Kamenko Digital, Vardar Web Lab) on reserved `.example` domains. The 24 answers were written by hand to exercise the analysers: a list, a table, a prose mention, a typo match, a Cyrillic alias and one failed call. They did not come from any AI engine. The UI, the HTML export and the export file name all carry a "demo data" label. The demo runs through the same analysis code as a live run.

## Project structure

```
src/
  lib/            prompts, normalisation, mention and list analysis, scoring,
                  recommendations, report building and export (pure, tested)
  components/     React UI
  demo/           bundled, clearly labelled demo data
server/           provider requests and parsing, config, validation, rate limiting
netlify/functions engines.ts (GET /api/engines), ask.ts (POST /api/ask)
tests/            Vitest suites
```

The browser sends one prompt per request to `/api/ask` (three at a time), the function fans out to the selected engines in parallel and returns raw answers, and the browser runs the analysis. That keeps each function call well under Netlify's time limit and lets the matrix fill in live.

## Tech stack

- React 19, TypeScript (strict), Vite
- Plain CSS, self-hosted fonts (Bricolage Grotesque, Instrument Sans, JetBrains Mono via Fontsource)
- Netlify Functions (TypeScript), provider APIs called with `fetch`, no SDKs
- Vitest, ESLint (typescript-eslint), GitHub Actions

## Author

**Riste Kozarev**, Skopje. I run the digital agency NULA and work as an automation engineer in energy tech (solar and battery storage). This project sits on the AI and marketing side of that work: it is the check I wanted to run for clients before talking about GEO.

GitHub: [@risxxkxx](https://github.com/risxxkxx)

Built with AI-assisted development; product idea, scoring logic and validation by the author.

## License

MIT
