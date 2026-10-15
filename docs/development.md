# Development

This guide describes the current prototype and its configuration. See the [project overview](../README.md) for its scope, the [usage guide](usage.md) for the French interface, and the [deployment guide](../deploy/README.md) for the supplied Coolify setup.

## Local setup

Use **Node.js 24.15 or later** and npm. The repository's [`.nvmrc`](../.nvmrc) selects Node 24, which is also used by CI.

```sh
nvm use
npm ci
cp .env.example .env.local
npm run dev
```

Skip `nvm use` if you manage Node another way. Copy the example only when creating a new configuration; keep an existing `.env.local` when updating a checkout. Open the address printed by Next.js, usually `http://127.0.0.1:3000`.

The database is created automatically at `data/monitor.sqlite`. A new database starts with keyword selection, automatic collection off, and Jev disabled. The example leaves all three provider budgets at zero. Installing dependencies and starting this fresh configuration do not collect publications or call paid providers. Installation downloads npm packages.

To retrieve publications, use **Actualiser les sources** in the interface or run this separate command:

```sh
npm run collect
```

Collection contacts configured websites and feeds. It can also make paid X requests if X sources, credentials and a positive budget are configured. Existing databases retain their settings: starting the server can resume an enabled collection schedule or enabled Jev processing.

Local development and production commands bind to `127.0.0.1`; request checks reject external hostnames by default. This is a single personal workspace. For HTTPS hosting and public reading with a private `/admin` workspace, follow the [deployment guide](../deploy/README.md).

## Commands and checks

| Command                | Purpose                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm run dev`          | Start the development server and local workers.                                                                                |
| `npm run collect`      | Run collection once, load `.env.local` if present, and print the outcome as JSON. A failed source gives a nonzero exit status. |
| `npm run check`        | Run TypeScript checking without emitting files.                                                                                |
| `npm test`             | Run `tests/*.test.ts` with `tsx` and Node's test runner.                                                                       |
| `npm run format:check` | Check formatting with Prettier.                                                                                                |
| `npm run format`       | Rewrite files with Prettier.                                                                                                   |
| `npm run build`        | Build the application. Background workers do not start during the build.                                                       |
| `npm start`            | Serve an existing production build and start local workers.                                                                    |

Run the same checks as [CI](../.github/workflows/ci.yml):

```sh
npm run format:check
npm run check
npm test
npm run build
```

Then use `npm start` to inspect the production build locally. CI runs on pushes and pull requests with Node 24 and installs dependencies using `npm ci`.

Tests cover feed and connector parsing, network destination checks, collection and scheduling, migrations, persisted personal state, selection, grouping, reviews and Markdown export, request access, and optional provider clients, caches and accounting. Provider tests use supplied responses and test databases. They do not establish current provider access, live source compatibility, model quality or deployment readiness.

## Configuration

Keep local values in the Git-ignored `.env.local`, using [`.env.example`](../.env.example) as the reference. Restart the server after changing environment variables. Keys stay on the server and are not returned to the browser or stored in SQLite.

| Variable                                                     | Default or constraint                                                                                                               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DTM_DATABASE_PATH`                                          | `data/monitor.sqlite`. Relative paths resolve from the project directory when commands run there.                                   |
| `DTM_COLLECTION_INTERVAL_MINUTES`                            | `15`. Minimum time between source checks; must be a finite number of at least 1. Separate from the schedule saved in the interface. |
| `X_BEARER_TOKEN`                                             | Unset. App-only credential for optional public X account collection.                                                                |
| `DTM_X_MONTHLY_BUDGET_USD`                                   | `0`. Local X cap from 0 to 1,000 USD. Zero blocks X reads.                                                                          |
| `TYPESAFE_API_KEY`                                           | Unset. Credential for optional Jev classification.                                                                                  |
| `DTM_JEV_MONTHLY_BUDGET_USD`                                 | `0`. From 0 to 100 USD, with at most two decimal places.                                                                            |
| `OPENAI_API_KEY`                                             | Unset. Credential for optional French summaries.                                                                                    |
| `DTM_SUMMARY_MONTHLY_BUDGET_USD`                             | `0`. From 0 to 100 USD, with at most two decimal places.                                                                            |
| `DTM_SUMMARY_MODEL`                                          | Unset uses `gpt-4.1-mini-2025-04-14`; the example file explicitly sets `gpt-6-luna`. See the configured model list below.           |
| `DTM_APP_ORIGIN`, `DTM_PROXY_SECRET`, `DTM_PUBLIC_READ_ONLY` | Leave unset for local use. These belong to the matching authenticated gateway described in the deployment guide.                    |

Website and feed collection and keyword selection require no provider key. X, Jev and summaries have independent settings and usage ledgers. A positive cap is required for each paid integration; a cap alone does not configure access.

## Sources and collection

[`config/sources.json`](../config/sources.json) defines four seed sources. They are inserted when missing; this file does not overwrite existing database entries. Sources added or edited through the interface stay in SQLite.

| Seed source                                                         | Collection input                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Ukraine's Arms Monitor](https://ukrainesarmsmonitor.substack.com/) | [RSS feed](https://ukrainesarmsmonitor.substack.com/feed).                         |
| [Militarnyi](https://militarnyi.com/en/)                            | [English news RSS](https://militarnyi.com/en/news/feed/).                          |
| [Brave1](https://brave1.gov.ua/en)                                  | Dedicated connector for the [English news listing](https://brave1.gov.ua/en/news). |
| [Defender Media](https://thedefender.media/en/)                     | Dedicated connector for its English listing.                                       |

For other websites, discovery looks for an RSS/Atom link explicitly advertised by the page. A feed URL can also be supplied directly. Failure to discover a feed does not mean a website has stopped publishing. There is no general website scraper.

When a page advertises several RSS/Atom links, discovery uses the first usable
HTTP(S) URL without credentials, skipping missing, blank, or invalid links.

Each dedicated connector reads one listing page per collection, without pagination or a full archive import. RSS/Atom parsing considers up to 200 items from a response. Collection preserves previously imported publications when a source fails and continues with other sources. Conditional requests using `ETag` and `Last-Modified`, plus content hashes, reduce repeated work.

Sources checked within `DTM_COLLECTION_INTERVAL_MINUTES` are normally skipped. Disabled and unsupported sources are skipped too. Disabling a source prevents pending requests from starting; responses become stale if activation, feed URL or language changes while a request runs. Renaming preserves collected data and caches.

### Article text retrieval

After listing collection, the application can retrieve public English article text from Brave1 and Defender Media. Other sources retain the text supplied by their feed or connector.

- Retrieval allows at most **10 pages per source** and **20 pages per collection**, with a **30-second soft allowance** checked between requests.
- Unvisited articles take priority. Later collections continue the backlog, including when a listing returns HTTP 304 or was checked recently.
- Successful pages become eligible for another check after seven days, using HTTP validators when available. Failed or unrecognized pages wait one day.
- Redirects to a different article are rejected. No account cookies or API credentials are sent to article pages.
- Original listing data remains separate from the page cache. A temporary failure retains the last successful text; changed URLs or languages cannot reuse an old body.

Text changes preserve reading state, folders and feedback, but invalidate classifications and summaries based on older input. Enabled Jev feeds may then need new analyses within their existing budget. New French summaries still require an explicit request.

### Network and scheduling constraints

Website, feed and article-page requests use [`network.ts`](../src/lib/network.ts). It checks public destinations and DNS results, pins a validated address, restricts ports to HTTP/HTTPS defaults, validates redirects, applies a 15-second request deadline and a 3 MiB response limit, and checks `robots.txt` and crawl delays. A source that cannot be checked is reported in the collection outcome.

The schedule is stored in SQLite and is off by default. The interface offers intervals from 15 minutes to 24 hours. The server worker checks every 10 seconds while `npm run dev` or `npm start` is running; closing the browser does not stop it. Sleep or a stopped server suspends work. An overdue schedule runs once on restart rather than replaying missed intervals. No operating-system task is installed.

Manual, scheduled and command-line collection share a database lease to prevent overlap. An interrupted run is reported when its expired lease is recovered and deferred to the next interval. Pausing stops future scheduled runs; a current run finishes. The database retains the latest outcome rather than an unlimited run history. See the [usage guide](usage.md) for the schedule controls.

## Optional provider integrations

All amounts below describe estimates implemented in this revision of the code. They are not current provider price quotes, availability guarantees, account balances or provider-enforced limits. Check the linked provider documentation before enabling an integration. Each ledger covers one database and the UTC calendar month in which a request starts; spending from other databases and applications is outside it.

### Jev selection (optional)

Jev evaluates relevance to each feed's written brief and classifies editorial type. It does not generate summaries or verify claims. The client pins `jev-1.13.0` and calls TypeSafe's API. Provider references: [models](https://docs.typesafe.ai/models) and [API](https://docs.typesafe.ai/api). Evaluate classification on your own source languages and judgments; the application's scores are not accuracy guarantees.

Set a local key and your chosen positive cap, then restart the server:

```dotenv
TYPESAFE_API_KEY=your_key_here
DTM_JEV_MONTHLY_BUDGET_USD=1
```

The 1 USD cap is an example. Explicitly enable comparison or personal selection under **Profil de veille**. A new database starts with Jev disabled; creating a custom feed does not bypass the global mode or missing credentials. All enabled feeds share one Jev budget.

The worker checks every 10 seconds and processes up to five requests per batch across enabled, unarchived feeds. Page reads, polling, drafts, previews and builds do not request paid classification. Pausing a feed stops subsequent requests, while an in-flight request can finish.

Requests send the original title, language, selected available text, content provenance, and the feed's instructions and exclusions. The shared profile's text scope applies to every feed. Metadata-only items send no body. Serialized JSON is bounded to **28,000 bytes**: article text can be shortened and marked as such, while inputs that still exceed the limit are rejected before HTTP. Source material is treated as untrusted data.

Cache keys include the exact model, rubric, selected content and semantic brief. Renaming a feed, changing thresholds or sorting, or changing feedback, read or saved state does not invalidate scores. Saving different instructions, exclusions, selected scope or article content requires fresh scores. Identical inputs can share a cache entry, and outdated scores are not applied to current inputs.

[`jev-client.ts`](../src/lib/jev-client.ts) configures an input estimate of **$0.042 per million tokens**. Before HTTP, a SQLite transaction reserves the maximum **64,000-token charge, $0.002688**. A valid result settles using reported input usage. Timeouts, interrupted requests and unvalidated results keep the reservation because billing is unknown; known failures before HTTP release it. Insufficient remaining budget blocks another request.

Failures pause processing and require explicit retry after the issue is addressed. There are no hidden HTTP retries. A retry may incur a new charge without removing an earlier uncertain reservation. Changing modes does not erase usage. Decisions and accounting persist locally; this integration does not configure a text-generation provider.

### French summaries (optional)

Summaries use OpenAI independently of Jev and are requested from an individual publication with **Résumer en français**. Add a local key and your chosen positive cap, then restart:

```dotenv
OPENAI_API_KEY=your_key_here
DTM_SUMMARY_MONTHLY_BUDGET_USD=1
```

The cap is an example. Keep or explicitly choose a supported `DTM_SUMMARY_MODEL` from the code configuration below. Adding credentials, changing a model, opening a page or polling does not start generation. **Profil de veille** shows configuration and the separate summary budget.

[`summary-models.ts`](../src/lib/summary-models.ts) accepts these exact IDs and assigns these local estimates in USD per million tokens. Model links are retained as provider references, not recommendations or a claim that an ID is currently available to an account.

| Configured model ID                                                                     | Input | Cached input | Cache write | Output | Maximum reservation |
| --------------------------------------------------------------------------------------- | ----: | -----------: | ----------: | -----: | ------------------: |
| [`gpt-4.1-mini-2025-04-14`](https://developers.openai.com/api/docs/models/gpt-4.1-mini) | $0.40 |        $0.10 |       $0.40 |  $1.60 |             $0.0264 |
| [`gpt-5-nano-2025-08-07`](https://developers.openai.com/api/docs/models/gpt-5-nano)     | $0.05 |       $0.005 |       $0.05 |  $0.40 |             $0.0034 |
| [`gpt-5.6-luna`](https://developers.openai.com/api/docs/models/gpt-5.6-luna)            | $0.20 |        $0.02 |       $0.25 |  $1.20 |             $0.0166 |
| [`gpt-6-luna`](https://developers.openai.com/api/docs/models/gpt-6-luna)                | $0.10 |        $0.01 |      $0.125 |  $0.50 |            $0.00825 |

An unset model uses `gpt-4.1-mini-2025-04-14`, while `.env.example` explicitly selects `gpt-6-luna`. Unsupported IDs are rejected before a paid request. The configured Luna requests use `reasoning.effort: none`, GPT-5 nano uses `minimal`, and the GPT-4.1 mini request has no reasoning parameter. Reasoning tokens, when present, count toward the output cap and estimate. Changing models selects a separate cache and keeps old results and charges. All configured models share one summary budget.

The client sends the title, source name, language, provenance and collected text to OpenAI's Responses endpoint. It does not send feed briefs, interests, feedback, folders or reading history. Requests use structured output, standard processing, `store: false` and at most **500 output tokens**. See the provider's [structured output guide](https://developers.openai.com/api/docs/guides/structured-outputs).

Metadata-only publications and texts under **400 characters** are ineligible. The serialized request is limited to **32,000 bytes**, shortening the body when needed. The model can report insufficient information even for a longer input. Instructions require a short French paraphrase based only on supplied text, with attribution and uncertainty preserved. Invalid, incomplete or refused outputs are not displayed. A summary does not verify claims or establish that the input is a complete article.

Summaries are cached across feeds by exact transmitted input, prompt and model. Feed settings, feedback and read/saved state do not regenerate them. Changed source input makes an old result inapplicable. A failed request can be retried explicitly; there are no automatic retries. Original titles, excerpts and links remain available, and monitoring reviews use source excerpts.

A SQLite transaction reserves the maximum **64,000 input tokens plus 500 output tokens** before HTTP. It uses the higher of the configured input and cache-write rates, including the 1.25 multiplier for the configured Luna entries. Valid responses settle using reported input/output usage and cache counts. Missing cache-write counts use the highest applicable input estimate; missing cache-read counts receive no discount. Provider reference: [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

Unknown billing after a failed or interrupted request retains the reservation across retries and restarts. Known failures before HTTP cost nothing. An insufficient local budget blocks another request while cached summaries remain readable.

### X accounts (optional)

Add a public account under **Sources** with `@handle` or an X profile URL. Adding or editing an account does not look it up or make a paid request. Reads happen during manual, scheduled or command-line collection through the official X API.

Create an app in the [X Developer Console](https://console.x.com/) and generate its app-only Bearer Token. The connector does not use an X password, browser session or user sign-in flow. See the [app and credential guide](https://docs.x.com/fundamentals/developer-apps). Review [pricing and spending limits](https://docs.x.com/x-api/getting-started/pricing), fund access as required by the provider, and configure a provider spending limit before enabling collection.

```dotenv
X_BEARER_TOKEN=your_app_bearer_token_here
DTM_X_MONTHLY_BUDGET_USD=1
```

Choose your own cap from 0 to 1,000 USD and restart the server. Zero blocks reads. Once credentials and a positive cap are configured, an already-enabled schedule can read enabled X sources. Keep the schedule paused or the cap at zero until ready. Website and feed collection work without this configuration.

The initial import takes one page of up to **10 recent posts**, excluding replies and reposts, and establishes a starting point. Later collections request newer posts, at most one page of 10 per account per run. Persisted pagination and post-ID cursors let a backlog continue across runs and restarts. This is not an exhaustive archive import; provider timeline and access limits still apply. See the [timeline documentation](https://docs.x.com/x-api/posts/timelines/introduction).

[`x-store.ts`](../src/lib/x-store.ts) estimates **$0.005 per returned post** and **$0.010 per returned user lookup resource**. Before HTTP, a transaction reserves up to $0.010 for lookup or $0.050 for a ten-post page. Pages shrink near the cap; less than $0.025 cannot reserve the minimum five-post page. Valid responses settle against returned resource counts; interrupted or uncertain requests keep the reservation. The local estimate does not assume discounts or provider deduplication. X's own spending limit and billing cycle are separate from this database's UTC monthly guard.

The connector requests no related-resource expansions. It accepts post text up to 100,000 characters and imports original links, without downloading media, expanding threads, retrieving linked article pages, or synchronizing later edits and deletions. Posts can use ordinary reading, saving, folders and optional Jev selection. Summary requests remain explicit and must meet the same 400-character minimum and serialized request limits.

## Storage and migrations

The application uses [Node's built-in SQLite module](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html), with no separate database server. [`store.ts`](../src/lib/store.ts) creates the parent directory, enables WAL mode and foreign keys, and sets a five-second busy timeout. The database contains sources, publications, profile settings, reading and saved states, feedback, folders, change acknowledgements, scheduling state, provider caches and usage ledgers.

[`migrations.ts`](../src/lib/migrations.ts) upgrades databases automatically when opened, currently to **schema version 11**. Migrations preserve existing publications and personal state while adding provenance, grouping preferences, revision tracking, folders, scheduling, Jev feeds and accounting, summaries, article-page caching, and X cursors and accounting. A database with a newer schema is rejected. Announcement groups are derived from current publications; grouping does not merge or delete records.

The database and local environment files are excluded from Git. For a local backup, stop every application or collection process using the database and copy the `data/` directory, or the configured database directory if different. This keeps the SQLite files together. The deployment guide documents [hosted backup and restore](../deploy/README.md).

## Content boundaries

Collected publications retain their original links, language and source text. Publication time and collection time are separate; an unknown publication date stays unknown. Feed and article-page text is limited to **20,000 characters** and may be incomplete. Article extraction uses recognized public editorial elements, excluding scripts, embedded data bodies, menus, recommendations and explicit access restrictions.

The interface identifies the content available for analysis. Stored source excerpts are bounded to **480 characters**, and ordinary personal feed previews show up to **400 characters** before expansion. The API does not return stored full article bodies. Metadata-only items have no excerpt or generated summary. The application does not bypass paywalls, transcribe videos or infer a summary from a title.

Keyword rules, Jev scores and announcement groups describe available material. They do not verify claims, source reliability or independent confirmation. Grouping is conservative, uses language, date, title and available text, and keeps each publication's own identity and personal state. It does not fetch extra article bodies or translate titles. There are no exhaustive archive imports, alerts or audio features in this prototype.

## Architecture

A [Next.js](https://nextjs.org/docs) monolith serves the React and TypeScript interface and API. Collection, classification and summaries are separate: local rules use the synchronous `Classifier` contract, Jev runs in its optional background worker, X runs through collection, and summaries run on demand. Snapshot reads return persisted data without provider calls.

```text
config/sources.json                 Initial source definitions
src/lib/network.ts                  HTTP destinations, limits and robots.txt
src/lib/feed.ts                     RSS/Atom discovery and normalization
src/lib/connectors/                 Brave1 and Defender listing/article parsing
src/lib/article-content.ts          Eligible article targets and URL checks
src/lib/article-content-collector.ts Bounded article retrieval and refresh
src/lib/article-content-store.ts     Article text cache and provenance
src/lib/collector.ts                 Collection, caching and outcomes
src/lib/collection-state.ts          Collection lease, schedule and latest outcome
src/lib/collection-scheduler.ts      Automatic collection worker
src/instrumentation.ts              Server-start worker registration
src/lib/store.ts                    SQLite persistence and personal state
src/lib/migrations.ts               Versioned database upgrades
src/lib/classifier.ts               Local rule classifier contract
src/lib/profile.ts                  Profile validation and selected text scope
src/lib/selection.ts                Manual corrections and rule evaluation
src/lib/custom-feeds.ts             Feed validation and editable presets
src/lib/jev-client.ts               Bounded TypeSafe requests and validation
src/lib/jev-store.ts                Jev cache, reservations and accounting
src/lib/jev-worker.ts               Background classification and recovery
src/lib/summary-client.ts           Bounded OpenAI requests and validation
src/lib/summary-models.ts           Configured model IDs, settings and estimates
src/lib/summary-store.ts            Summary cache, reservations and accounting
src/lib/summary-service.ts          On-demand generation and explicit retry
src/lib/x-client.ts                 Official X requests and post normalization
src/lib/x-store.ts                  X cursors, reservations and accounting
src/lib/x-collector.ts              Initial and incremental X collection
src/lib/activity.ts                 Revision-based change review
src/lib/folders.ts                  Folder name validation
src/lib/stories.ts                  Announcement groups and comparison hints
src/lib/story-feed.ts               Grouping after view and search filters
src/lib/digest.ts                   Review windows, editions and source coverage
src/lib/digest-markdown.ts          Markdown export of a captured edition
src/lib/request-access.ts          Local and gateway access checks
src/lib/public-monitor.ts          Public snapshot projection
src/app/api/monitor/               Private workspace reads and mutations
src/app/api/public-monitor/        Public read-only endpoint
src/components/                    Interface and snapshot synchronization
scripts/collect.ts                  Command-line collection
tests/                             Unit and integration tests
```
