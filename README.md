# Defense Tech Monitor

A personal monitoring application for following developments in drones, robotics, and defense technology from sources you choose.

Publications are collected through RSS/Atom or dedicated public-page connectors, stored locally, and selected using an editable keyword profile or Jev-powered feeds with individual written briefs. Each publication retains its original title, source, language, and link. The interface distinguishes feed text, article-page text, listing excerpts, and titles with metadata only.

## Getting started

Requirements: Node.js **24.15 or later** and npm. CI uses Node 24; run `nvm use` to select the version specified in `.nvmrc`.

```sh
npm ci
cp .env.example .env.local
npm run collect
npm run dev
```

Open the address shown in the terminal, usually `http://127.0.0.1:3000`. The SQLite database is created automatically at `data/monitor.sqlite`. The default keyword mode requires no API key and makes no paid calls. Jev and on-demand French summaries each require separate local configuration.

To run the checks and a production build locally:

```sh
npm run check
npm test
npm run build
npm start
```

The application uses one personal profile. Local commands bind to the loopback interface and reject external hostnames by default. For private HTTPS access on a VPS, follow the [Coolify deployment guide](deploy/README.md), which provides an authenticated gateway, persistent SQLite storage, and backup and restore instructions.

## Usage

The interface currently uses French labels:

- **For me — Pour moi**: publications matching your profile, plus those explicitly marked relevant. Items marked off-topic or already seen are excluded.
- **Review — Revue**: a compact, themed edition of publications first collected or updated within the last 24 hours or 7 days, with a Markdown download.
- **My feeds — Mes fils**: create topic feeds from Drones, Ukraine news, and Startups presets or write your own brief. Each feed has independent relevance and confidence thresholds, sorting, and optional feedback.
- **Full feed — Tout le flux**: all collected publications, with search and filters for source, topic, language, and format.
- **Saved — Sauvegardés**: bookmarked publications, preserved across restarts.
- **Folders — Dossiers**: organize publications into named folders and browse their contents with the usual feed filters.
- **Evaluate — Évaluer**: review unjudged publications, find relevant items missed by the rules, inspect rule matches you marked off-topic, or revisit all your feedback. Publications are displayed individually in this view.
- **Sources**: add websites or feeds, edit their configuration, enable or disable individual sources, configure automatic collection, and inspect the collection method, address, status, and errors.
- **Monitoring profile — Profil de veille**: keywords, exclusions, the minimum number of matches required, and the content used for selection. An exclusion keyword rejects an article under the rules; explicitly marking it relevant overrides that decision for your personal feed.

Start collection with **Refresh sources — Actualiser les sources** or `npm run collect`. You can also enable automatic collection under **Sources**.

### Monitoring reviews

Open **Review — Revue** to create a compact edition from the current collected data. Choose the last 24 hours or 7 days, and either **For me — Pour moi** or **Full feed — Tout le flux**. For me applies your saved profile and explicit relevance feedback. The period uses collection timestamps: an older article first imported during the period is a new collection; an article imported earlier qualifies when its collected data was updated during the period. Reading, saving, or acknowledging an article does not remove it from this review.

The edition stays fixed while you read it. Background collection can show an update notice, but only **Refresh review — Actualiser la revue**, a period/scope change, or reopening the view creates a new edition. **Refresh sources — Actualiser les sources** runs collection separately. The displayed timestamps include the exact window and edition time.

Publications are organized by one primary topic to avoid duplicate counts. Existing announcement groups apply only to included publications, and every included member keeps its own original title, link, publication date, language, and available excerpt. Detection and publication dates remain separate. Metadata-only items have no excerpt. These are original source excerpts, not generated French summaries or verified claims.

Each edition includes at most the 100 publications most recently first collected or updated in the selected window. A notice shows how many were omitted; all summary counts describe the included publications. Grouping follows this limit and the selected scope, so an excluded publication never returns through a group. Source coverage notices concern all active sources, including errors, unsupported sources, and sources not checked within the period.

**Download Markdown — Télécharger Markdown** exports the exact displayed edition, including original links, provenance, coverage notices, and any omissions. External text is escaped as literal Markdown, and links are limited to HTTP(S) URLs without credentials. The file is downloaded locally; no account or external service is required. Viewing, refreshing, and exporting a review do not change read states, bookmarks, feedback, folders, or change acknowledgements.

Reviews use the latest collected version available when created. They do not reconstruct earlier revisions or describe the precise differences between versions, and editions are not stored in the database. Keep the downloaded file if you want to retain an edition.

### Automatic collection

Automatic collection is off by default. Choose a frequency from 15 minutes to 24 hours and enable it under **Sources**. The first collection becomes due immediately; the local worker checks for due work every 10 seconds. The panel shows the next scheduled time, whether a collection is running, and the outcome of the latest manual, scheduled, or command-line run, including source failures.

Keep `npm run dev` or `npm start` running for scheduled collection. Closing the browser tab does not stop the worker. Stopping the server or putting the computer to sleep suspends collection. On restart, an overdue schedule runs once rather than replaying every missed interval. An interrupted run is reported and deferred to the next interval after its expired lease is recovered. No operating-system task is installed.

Pausing prevents future scheduled runs; a collection already in progress finishes normally. Changing the frequency while enabled schedules the next run from the change time. After a collection completes, the next run is scheduled from its finish time using the current frequency. Manual and command-line collection remain available while paused. A shared database lease prevents overlapping runs.

By default, a source checked within the last 15 minutes is skipped. `DTM_COLLECTION_INTERVAL_MINUTES` controls this per-source minimum, independently of the automatic collection frequency; source access restrictions and crawl delays still apply. Disabled and unsupported sources are skipped. A source failure does not remove previously collected articles or prevent the remaining sources from being checked.

An open, visible dashboard refreshes its data every 15 seconds and when you return to the tab. Filters and unsaved form drafts are preserved. New imports retain their pending change status until explicitly acknowledged. The database retains the latest run outcome, not an unlimited execution history.

### Personal selection

Feedback corrects your feed immediately: **Relevant — Pertinent** retains a publication even below the keyword threshold, while **Off-topic — Hors sujet** and **Already seen — Déjà vu** remove it from For me. Click the selected feedback button again to clear the correction and return to the active selection mode. The article and its read/saved states remain available in the full feed. Feedback does not train a model or change your keywords automatically.

### Optional Jev selection

Jev can evaluate interest in a publication against each feed’s written brief and classify its editorial type. It does not generate summaries or verify claims. The integration calls the official TypeSafe API with the pinned model `jev-1.13.0`. TypeSafe documents stronger accuracy in English than other languages; evaluate results on your own French and Ukrainian sources before relying on them. See the [model reference](https://docs.typesafe.ai/models) and [API documentation](https://docs.typesafe.ai/api).

Set these values in your local, Git-ignored `.env.local`, then restart the server:

```dotenv
TYPESAFE_API_KEY=your_key_here
DTM_JEV_MONTHLY_BUDGET_USD=1
```

The budget above is an example; choose your own limit from 0 to 100 USD, with at most two decimal places. The default is 0, which blocks calls. The key stays on the server and is never returned to the browser. Under **Monitoring profile — Profil de veille**, explicitly apply one of these modes:

- **Disabled — Désactivé**: no new Jev calls for any feed. For me uses keyword rules; custom feeds can still display their cached decisions.
- **Compare with rules — Comparer aux règles**: analyze enabled feeds in the background. Custom feeds use their own scores while the general For me feed continues to use keyword rules.
- **Use in For me — Utiliser dans Pour moi**: the general feed applies its own relevance and confidence thresholds. Missing or uncertain classifications fall back to keywords. Custom feeds only select usable results or explicit positive feedback, without borrowing the general keyword rules.

Open **Consignes et réglages** on For me or a custom feed to edit what you want to see, what to avoid, the minimum interest score (0–3), the minimum confidence (0–100%), and relevance/date ordering. The starting thresholds of 1.5 and 60% are editable defaults, not calibrated accuracy guarantees. The score measures fit to the brief; a short announcement can score highly without engineering detail. Confidence describes uncertainty in the model’s classification, not source reliability.

Create feeds under **Mes fils** using editable Drones, Ukraine news, and Startups presets, or a custom brief. One article can receive different scores in several feeds while retaining shared reading, bookmark, folder, and change-review state. Feedback within a custom feed applies only to that feed; general feedback remains attached to For me. Feedback never automatically trains the model. No labeling exercise is required. Archiving a custom feed preserves its settings, cached results and feedback and stops new analyses; restore it from Mes fils. The general feed cannot be archived or renamed.

The settings preview filters existing scores locally, before manual feedback. Changing a threshold or sort order makes no provider request. Changing and saving instructions or exclusions invalidates that feed’s old scores and queues new analyses while it is enabled. A changed shared text scope or article content also requires fresh scores. The preview explicitly identifies scores from old instructions while a brief is being edited. Concurrent edits are rejected rather than silently overwriting a newer version. Pausing a feed stops subsequent requests but keeps its valid cached selection; an in-flight request may finish.

All feeds share one monthly budget and usage ledger. New databases start with the general feed and Jev disabled; creating a custom feed does not bypass the global mode or missing configuration. Relevance sorting puts explicitly relevant articles first and then orders usable scores, using publication dates as a tie-breaker. Date sorting uses publication date, or collection date if missing. Activity filters retain collection-change ordering.

The optional comparison in Profil de veille compares the general feed with keyword rules before feedback; it is not a measurement of accuracy. The existing evaluation metrics measure keyword rules against judgments. Keyword profile previews retain general feedback but exclude Jev and never trigger API calls. Keyword changes affect the fallback rules and topic tags, not the written feed briefs.

Activation sends the original title, language, available selected text, content provenance, and the feed’s instructions and exclusions to TypeSafe. The profile’s text scope applies to every feed. Metadata-only publications send no body. Requests are limited to 28 KB of serialized JSON; long content is shortened and labelled accordingly, while oversized inputs are rejected without sending them. Source content is treated as untrusted data. Classification indicators describe the available input, not an unseen full article or the truth of its claims.

The local worker checks every 10 seconds while the server runs, processing up to five requests per batch across enabled, unarchived feeds. Opening the page, polling, drafting settings, previewing a profile, and building the application make no paid requests. Cache keys include the exact model, rubric, selected content, and semantic brief. Names, thresholds, sort order, read states, saves and feedback do not invalidate a classification; identical inputs can share cached results. Cached decisions for outdated inputs are never applied to current publications.

Usage is tracked per UTC calendar month in this database, separately from your TypeSafe account balance. At the documented input price of $0.042 per million tokens, each request first reserves its maximum 64,000-token charge ($0.002688) in a SQLite transaction. A valid response settles the estimate using reported input usage. Timeouts, interrupted requests and unvalidated responses keep the conservative reservation because billing is unknown. Known failures before HTTP release it. Insufficient remaining budget blocks further requests; changing modes or retrying does not erase charges or reservations. This is a local spending guard at the documented rate, not a provider billing statement or an account-wide limit; other databases and applications have separate budgets.

Failures pause processing and show a safe error. Use the explicit retry action after addressing the issue; retries may incur another charge and retain reservations from uncertain attempts. There are no hidden HTTP retries. The application stores decisions and usage locally, and never stores the API key in SQLite. No text-generation provider is configured by this integration.

### Optional French summaries

Use **Résumer en français** on a publication to generate a short factual summary of its available text. Summaries use OpenAI independently of Jev. Configure your Git-ignored `.env.local` and restart the server:

```dotenv
OPENAI_API_KEY=your_key_here
DTM_SUMMARY_MONTHLY_BUDGET_USD=1
DTM_SUMMARY_MODEL=gpt-6-luna
```

The example cap can be replaced with your own limit from 0 to 100 USD, with at most two decimal places. The default is 0. A key and a positive cap are required; adding them does not start generation. Only an explicit summary request calls the provider. **Profil de veille** shows the configuration status and separate summary budget. The API key remains on the server.

Generation sends the original title, source name, language, content provenance and collected text to the official OpenAI Responses endpoint. It does not send feed briefs, interests, feedback, folders or reading history. Requests use structured output, a maximum of 500 output tokens, standard processing and `store: false`. See the [structured output guide](https://developers.openai.com/api/docs/guides/structured-outputs).

`DTM_SUMMARY_MODEL` accepts the following documented models. Unset configurations retain the original pinned GPT-4.1 mini model; the example above selects GPT-6 Luna. Unsupported model IDs are rejected before any paid request. Luna uses `reasoning.effort: none`, while GPT-5 nano uses `minimal`; its reasoning tokens count toward the output limit and cost. The original GPT-4.1 mini request has no reasoning parameter.

| Model ID                                                                                | Standard input / 1M tokens | Output / 1M tokens | Maximum reserved per request |
| --------------------------------------------------------------------------------------- | -------------------------: | -----------------: | ---------------------------: |
| [`gpt-6-luna`](https://developers.openai.com/api/docs/models/gpt-6-luna)                |                      $0.10 |              $0.50 |                     $0.00825 |
| [`gpt-5.6-luna`](https://developers.openai.com/api/docs/models/gpt-5.6-luna)            |                      $0.20 |              $1.20 |                      $0.0166 |
| [`gpt-5-nano-2025-08-07`](https://developers.openai.com/api/docs/models/gpt-5-nano)     |                      $0.05 |              $0.40 |                      $0.0034 |
| [`gpt-4.1-mini-2025-04-14`](https://developers.openai.com/api/docs/models/gpt-4.1-mini) |                      $0.40 |              $1.60 |                      $0.0264 |

Rates were checked on September 26, 2026. The Luna model pages expose the listed IDs without a dated snapshot. Model choice affects price and generated content; changing it selects a separate cache and never starts generation automatically. Existing results and charges remain stored. All supported models share the same local summary budget.

Metadata-only publications and texts shorter than 400 characters are ineligible. The model can also report that a longer text contains insufficient information. Requests are bounded to 32 KB of serialized JSON, shortening the body when necessary. Instructions require a short French paraphrase based only on the supplied text, preserving attribution and uncertainty. Source material is treated as untrusted data. Invalid, incomplete or refused outputs are not displayed as summaries. This is not claim verification, and the available text may be an excerpt rather than the complete article. Original titles, excerpts and source links remain available; the press review and its Markdown export continue to use source excerpts.

A summary is cached across feeds. Changing feed settings, feedback or read/saved state does not regenerate it. Cache keys include the exact input, prompt and model; changing the source text or other transmitted fields makes the earlier result inapplicable. Old results never appear as summaries of a changed input. Reading pages and polling make no generation requests. A failed request can be retried explicitly from its article; there are no automatic retries.

The local ledger tracks each request against the UTC month in which it started. A transaction reserves the selected model’s maximum 64,000-input-token and 500-output-token charge before HTTP, including the 1.25× input rate for possible Luna cache writes. Valid responses settle using reported input/output usage and cache-read/write counts. Missing cache-write counts are estimated at the highest applicable input rate; missing cache-read counts receive no discount. See OpenAI’s [cache accounting documentation](https://developers.openai.com/api/docs/guides/prompt-caching). Failed or interrupted requests with unknown billing keep their reservation, including across retries and restarts. Known failures before HTTP cost nothing. Insufficient remaining budget blocks another request, while cached summaries remain readable. This cap is independent of Jev, your OpenAI balance and other applications; it is a local estimate at the documented rates, not an account-wide spending limit or billing statement.

### Organizing publications

Create and rename folders under **Folders — Dossiers**. Use **Classer** on a publication to add it to one or more folders, or remove it from a folder. Each publication in a grouped announcement has its own assignments. Folder membership is independent of bookmarks, read state, feedback, and change acknowledgements; filing an article does not alter your personal selection.

Choose a folder to browse its publications, then narrow the results using search, source, language, topic, format, or activity filters. Grouping applies only to the matching publications. A folder's total count includes all its members, including those outside For me or Saved.

Archiving a folder preserves its contents and leaves them available for consultation. Archived folders cannot receive new publications until reactivated; existing assignments can still be removed. Folder names are limited to 80 characters and must be unique, including archived folders, after normalizing case and spacing. Reactivating a folder restores it with its remaining assignments. Folders and assignments persist locally across collection and restarts.

### Catching up on collected changes

For me, Full feed, and Saved offer filters for new and updated publications. **New** means first collected since you last acknowledged that publication, regardless of its original publication date. **Updated** means its collected title, text, excerpt, URL, date, language, format, or content provenance changed after acknowledgement. These labels describe changes in collected data; they do not establish that a claim or event is new. Activity filters show the latest collection changes first.

Use **Acknowledge displayed changes — Valider les nouveautés affichées** to finish a monitoring pass. It acknowledges only pending publications matching the current view, search, and filters, including each displayed member of a group. Batches are limited to 200 publications; repeat the action when more remain. Read, saved, and feedback states are independent. Opening or reloading the page does not acknowledge anything, and publications hidden by filters remain pending.

Acknowledgements record the exact article revisions displayed. If collection changes an article while you review it, that newer revision remains pending. Identical imports do not create updates. Existing publications form the baseline when upgrading an older database; the application does not infer past visits or mark the entire archive as new.

### Evaluating and adjusting selection

The evaluation view includes all unjudged publications, including those outside For me, so you can find missed topics as well as broad matches. Its mistake filters compare your relevance judgments with the raw keyword decision, before applying manual corrections. An article marked relevant can therefore remain listed as a rule miss even though your correction puts it in For me.

Precision is the share of judged rule matches marked relevant. Recall is the share of publications you marked relevant that the rules would select. These figures describe only your judged sample, not the entire feed or the reliability of any claim. Unknown ratios are shown as unavailable; already-seen feedback is counted separately and supplies no relevance label.

The default selection scope remains **All collected text**, including feed text beyond the displayed excerpt. You can instead choose **Title and available excerpt** to reduce matches caused by incidental body mentions. This can also remove useful matches; title-only publications still use their titles. Topic labels and optional Jev requests use the same selected scope. Neither scope downloads additional content.

Use **Preview changes — Prévisualiser les changements** to compare a draft profile with the saved one. The preview shows selection counts, entering/leaving publications, and changes to rule mistakes on existing judgments. It uses the same classification and feedback rules as saving, but does not write the profile, articles, or personal state. Editing the draft or changing article data invalidates the preview. **Save profile — Enregistrer mon profil** applies the changes explicitly.

### Similar announcements

**Group similar announcements — Regrouper les annonces similaires** reduces repeated coverage in the feed. A likely match keeps one full card and lists the other publications with their original titles, links, dates, and read/saved states. Expand each publication to read its available excerpt or change its own state. Reading, saving, or rating one publication never changes the others.

Grouping applies after the current view and filters. Saved publications remain individually saved, and filtering by source never brings hidden sources back into the results. Counters distinguish publications from displayed cards. Turn grouping off to see every publication as a full card.

Use **Keep separate — Conserver séparé** to exclude a publication from automatic groups. This choice survives collection and restarts; **Restore grouping — Rétablir le regroupement** reverses it. Related publications with differing details remain separate and can display a comparison link. These suggestions do not establish whether an article contains a genuine new development or whether several outlets independently confirmed a claim.

## Sources

The four initial sources are defined in [`config/sources.json`](config/sources.json) and seeded into the database on first launch. Existing database entries are not overwritten by this file. Sources added through the interface remain in the local database.

| Source                                                              | Collection method                                    | Available content                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| [Ukraine’s Arms Monitor](https://ukrainesarmsmonitor.substack.com/) | [RSS](https://ukrainesarmsmonitor.substack.com/feed) | Text provided by the feed                                                   |
| [Militarnyi](https://militarnyi.com/en/)                            | [English RSS](https://militarnyi.com/en/news/feed/)  | Text provided by the feed                                                   |
| [Brave1](https://brave1.gov.ua/en)                                  | Dedicated connector for its English public listing   | Titles, dates, links, and public article text when extraction succeeds      |
| [Defender Media](https://thedefender.media/en/)                     | Dedicated connector for its English public listing   | Titles, dates, links, card excerpts, and public article text when available |

To add a source, enter its name and website under **Sources**. Brave1 and Defender Media are recognized automatically and do not require a feed URL. For other websites, the application looks for an RSS/Atom link explicitly advertised by the page; you can also provide a feed URL directly. Failure to discover a feed does not mean the website has stopped publishing.

Use **Edit — Modifier** on a source card to update its name, feed URL, or language. Its website address is read-only because it identifies the source. Saving changes preserves its enabled or disabled state. **Cancel — Annuler** clears the form without saving. Entering the same website URL through the add form also updates its configuration.

Disabling a source prevents pending requests from starting. If its feed URL, language, or activation changes during a request, the stale response is discarded. Such a request counts as both checked and skipped in the run outcome. Renaming a source preserves its cache and collected data.

Each public-page connector reads one English listing page per collection: [Brave1 news](https://brave1.gov.ua/en/news) or [Defender Media](https://thedefender.media/en/). It does not follow pagination or import the full archive. After reading the listings, it enriches known English articles from these two sites using their public article pages. The source card links to the page or feed used for collection. Website structure changes can interrupt extraction; check the collection status and any reported errors before assuming that a source has stopped publishing.

Article retrieval is bounded to 10 pages per source and 20 pages per collection, with a 30-second soft time allowance checked between requests. Unvisited articles take priority; further collections continue the backlog, even if a listing returns HTTP 304 or was checked recently. Successful pages are checked again after seven days using HTTP validators when available. Failed or unrecognized pages wait one day before another collection can retry. **Sources** shows available, pending, and unsuccessful retrieval counts; the latest collection also reports pages checked and texts enriched.

Retrieval uses the same public-address validation, request size limits, timeouts, and robots.txt checks as source collection, and rejects redirects to a different article. It sends no account cookies or API credentials and does not unlock subscriber content. The original feed/listing data is preserved separately. A temporary failure keeps the last successfully retrieved text; changed article URLs or languages cannot reuse an old page body. Updates preserve reading states, folders and feedback, but invalidate analyses and summaries based on older input. Enabled Jev feeds may therefore require new analyses within their existing budget; French summaries remain on demand.

Collection respects `robots.txt`, limits response size, applies timeouts, and validates network destinations, including redirects. Failed sources retain previously collected articles and display their errors. Conditional HTTP requests (`ETag`, `Last-Modified`) and content hashes reduce repeated processing.

## Data and limitations

- Displayed publications come from real feeds and supported public pages. Only tests use synthetic data.
- Publication and collection timestamps are separate. Unknown publication dates remain unknown.
- Available feed and article-page text is analyzed up to a limit of 20,000 characters and is not necessarily the complete article. Article extraction is restricted to recognized public editorial elements; scripts, embedded data bodies, menus, recommendations, and explicit access restrictions are excluded. When extraction is unavailable, the listing title and any original excerpt remain usable. The interface identifies the content used for analysis and displays excerpts of up to 400 characters; the API does not expose the stored article body. Metadata-only publications have no excerpt or generated summary.
- Full articles are not republished. The application does not bypass paywalls, transcribe videos, or invent summaries from titles.
- Classification defaults to deterministic keyword rules, with limitations around synonyms and languages. Optional Jev results supplement selection and editorial labels; theme tags remain rule-based. Matches indicate relevance to a profile, never the reliability of a claim.
- Repeated imports of a publication from the same source are detected through its identifier or normalized URL. Cross-source grouping requires the same known language, publication dates no more than seven days apart, and matching ordered title words after typographic normalization, including specific terms beyond generic defense vocabulary. When text is available, all collected text must also match in word order, not just the displayed excerpt. All members must match each other; a chain of loosely related articles is insufficient. Missing dates, different languages, changed numbers, follow-up signals, and different or incomplete text prevent grouping. Weaker title matches remain separate with comparison hints. This favors missed matches over hiding new information. It does not translate titles, fetch additional article bodies, or verify claims.
- This version does not include exhaustive archive imports, alerts, or audio.
- The database and `.env` files are excluded from Git. The example configuration contains no secrets. To back up local data, stop the application and copy the `data/` directory.

Existing databases are upgraded automatically to schema version 10 when opened. Migrations add content provenance, a per-publication grouping preference, revision-based change tracking, folder storage, collection scheduling, optional Jev cache/accounting, editable feeds with independent feedback, a separate summary cache and usage ledger, and an article-page content cache while preserving existing publications and personal state. Groups are derived from the current publications; they do not merge or delete database records.

## Architecture

A [Next.js](https://nextjs.org/docs) monolith with React and TypeScript serves the interface and API. [Node.js’s built-in SQLite module](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) provides persistence without a separate database server. The `node:sqlite` module is still at the _release candidate_ stage in Node 24.

```text
src/lib/network.ts                HTTP, allowed destinations, and robots.txt
src/lib/feed.ts                   RSS/Atom discovery and normalization
src/lib/connectors/               Brave1 and Defender Media listing/article extraction
src/lib/article-content-collector.ts Bounded article retrieval and conditional refresh
src/lib/article-content-store.ts  Public text cache without overwriting listing data
src/lib/collector.ts              Collection, caching, and run outcomes
src/lib/collection-state.ts       Run ownership, scheduling, and latest outcome
src/lib/collection-scheduler.ts   Local automatic collection worker
src/instrumentation.ts            Server-start worker registration
src/lib/store.ts                  SQLite persistence and personal state
src/lib/migrations.ts             Versioned database upgrades
src/lib/classifier.ts             Replaceable classification and explicit rules
src/lib/custom-feeds.ts           Feed contracts, input validation, and editable presets
src/lib/jev-client.ts             Pinned TypeSafe requests, bounded inputs, validated responses
src/lib/jev-store.ts              Cached decisions, transactional reservations, usage ledger
src/lib/jev-worker.ts             Optional background classification and explicit recovery
src/lib/summary-client.ts         Bounded OpenAI requests and source-based French summaries
src/lib/summary-models.ts         Supported models, request settings, and token pricing
src/lib/summary-store.ts          Summary cache, reservations, and separate usage ledger
src/lib/summary-service.ts        On-demand generation and explicit retry
src/lib/profile.ts                Profile validation and selection text scope
src/lib/selection.ts              Personal corrections and evaluation of raw rule decisions
src/lib/activity.ts               Change filters and bounded revision acknowledgements
src/lib/digest.ts                 Time windows, themed editions, and coverage notices
src/lib/digest-markdown.ts        Safe Markdown export of a captured edition
src/lib/folders.ts                Folder name validation and normalization
src/lib/stories.ts                Conservative announcement grouping and comparison hints
src/lib/story-feed.ts             Group presentation after view and search filters
src/app/api/monitor/              Local reads and mutations
src/components/                   Monitoring interface
scripts/collect.ts                Command-line collection
tests/                            RSS/Atom, duplicates, selection, and error cases
```

Collection, classification, and summary generation are separate concerns. The synchronous `Classifier` contract handles local rules; remote Jev requests run in the background. OpenAI summaries run only on demand, with their own configuration, usage ledger and cache. Snapshots read persisted results without calling either provider.
