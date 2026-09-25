# Defense Tech Monitor

A personal monitoring application for following developments in drones, robotics, and defense technology from sources you choose.

Publications are collected through RSS/Atom or dedicated public-page connectors, stored locally, and selected using an editable keyword profile. Each publication retains its original title, source, language, and link. The interface distinguishes feed text, public-page excerpts, and titles with metadata only.

## Getting started

Requirements: Node.js **24.15 or later** and npm. CI uses Node 24; run `nvm use` to select the version specified in `.nvmrc`.

```sh
npm ci
cp .env.example .env.local
npm run collect
npm run dev
```

Open the address shown in the terminal, usually `http://127.0.0.1:3000`. The SQLite database is created automatically at `data/monitor.sqlite`. No API key is required, and no paid services are called.

To run the checks and a production build locally:

```sh
npm run check
npm test
npm run build
npm start
```

The application is intended for local, single-user use. The server binds to the loopback interface and rejects external hostnames. Deploying it publicly would require authentication, separation of private data, and a backup strategy.

## Usage

The interface currently uses French labels:

- **For me — Pour moi**: publications matching your profile, excluding items marked off-topic or already seen.
- **Full feed — Tout le flux**: all collected publications, with search and filters for source, topic, language, and format.
- **Saved — Sauvegardés**: bookmarked publications, preserved across restarts.
- **Sources**: add websites or feeds, edit their configuration, enable or disable collection, and inspect the collection method, address, status, and errors.
- **Monitoring profile — Profil de veille**: keywords, exclusions, and the minimum number of matches required. A single exclusion keyword removes a publication from the selection without removing it from the full feed.

Start collection with **Refresh sources — Actualiser les sources** or `npm run collect`. Collection is not scheduled automatically. By default, a source checked within the last 15 minutes is skipped. Set `DTM_COLLECTION_INTERVAL_MINUTES` to change this interval; source access restrictions and crawl delays still apply.

Feedback is saved as relevant, off-topic, or already seen. The profile view reports publications you marked relevant that the rules missed, and publications selected by the rules that you marked off-topic. Feedback does not trigger automatic model training.

### Similar announcements

**Group similar announcements — Regrouper les annonces similaires** reduces repeated coverage in the feed. A likely match keeps one full card and lists the other publications with their original titles, links, dates, and read/saved states. Expand each publication to read its available excerpt or change its own state. Reading, saving, or rating one publication never changes the others.

Grouping applies after the current view and filters. Saved publications remain individually saved, and filtering by source never brings hidden sources back into the results. Counters distinguish publications from displayed cards. Turn grouping off to see every publication as a full card.

Use **Keep separate — Conserver séparé** to exclude a publication from automatic groups. This choice survives collection and restarts; **Restore grouping — Rétablir le regroupement** reverses it. Related publications with differing details remain separate and can display a comparison link. These suggestions do not establish whether an article contains a genuine new development or whether several outlets independently confirmed a claim.

## Sources

The four initial sources are defined in [`config/sources.json`](config/sources.json) and seeded into the database on first launch. Existing database entries are not overwritten by this file. Sources added through the interface remain in the local database.

| Source                                                              | Collection method                                    | Available content                                                                |
| ------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Ukraine’s Arms Monitor](https://ukrainesarmsmonitor.substack.com/) | [RSS](https://ukrainesarmsmonitor.substack.com/feed) | Text provided by the feed                                                        |
| [Militarnyi](https://militarnyi.com/en/)                            | [English RSS](https://militarnyi.com/en/news/feed/)  | Text provided by the feed                                                        |
| [Brave1](https://brave1.gov.ua/en)                                  | Dedicated connector for its English public listing   | Titles, dates when provided, and original links; no article excerpts             |
| [Defender Media](https://thedefender.media/en/)                     | Dedicated connector for its English public listing   | Titles, dates when provided, original links, and excerpts from publication cards |

To add a source, enter its name and website under **Sources**. Brave1 and Defender Media are recognized automatically and do not require a feed URL. For other websites, the application looks for an RSS/Atom link explicitly advertised by the page; you can also provide a feed URL directly. Failure to discover a feed does not mean the website has stopped publishing.

Use **Edit — Modifier** on a source card to update its name, feed URL, or language. Its website address is read-only because it identifies the source. Saving changes preserves its enabled or disabled state. **Cancel — Annuler** clears the form without saving. Entering the same website URL through the add form also updates its configuration.

Each public-page connector reads one English listing page per collection: [Brave1 news](https://brave1.gov.ua/en/news) or [Defender Media](https://thedefender.media/en/). It does not follow pagination, import the full archive, or open individual article pages. The source card links to the page or feed used for collection. Website structure changes can interrupt extraction; check the collection status and any reported errors before assuming that a source has stopped publishing.

Collection respects `robots.txt`, limits response size, applies timeouts, and validates network destinations, including redirects. Failed sources retain previously collected articles and display their errors. Conditional HTTP requests (`ETag`, `Last-Modified`) and content hashes reduce repeated processing.

## Data and limitations

- Displayed publications come from real feeds and supported public pages. Only tests use synthetic data.
- Publication and collection timestamps are separate. Unknown publication dates remain unknown.
- Available feed text is analyzed up to a limit of 20,000 characters and is not necessarily the complete article. Public-page connectors use only the content available in listing cards: Brave1 provides metadata only, while Defender Media also provides card excerpts. The interface identifies the content used for analysis and displays excerpts of up to 400 characters; the API does not expose the stored article body. Metadata-only publications have no excerpt or generated summary.
- Full articles are not republished. The application does not bypass paywalls, transcribe videos, or invent summaries from titles.
- Classification uses deterministic keyword rules, with limitations around synonyms and languages. Matches indicate relevance to a profile, never the reliability of a claim.
- Repeated imports of a publication from the same source are detected through its identifier or normalized URL. Cross-source grouping requires the same known language, publication dates no more than seven days apart, and matching ordered title words after typographic normalization, including specific terms beyond generic defense vocabulary. When text is available, all collected text must also match in word order, not just the displayed excerpt. All members must match each other; a chain of loosely related articles is insufficient. Missing dates, different languages, changed numbers, follow-up signals, and different or incomplete text prevent grouping. Weaker title matches remain separate with comparison hints. This favors missed matches over hiding new information. It does not translate titles, fetch additional article bodies, or verify claims.
- This version does not include exhaustive archive imports, generated summaries, topic folders, alerts, or audio.
- The database and `.env` files are excluded from Git. The example configuration contains no secrets. To back up local data, stop the application and copy the `data/` directory.

Existing databases are upgraded automatically to schema version 3 when opened. Migrations add content provenance and a per-publication grouping preference while preserving collected publications, read and saved states, feedback, source activation settings, and the keyword profile. Groups are derived from the current publications; they do not merge or delete database records.

## Architecture

A [Next.js](https://nextjs.org/docs) monolith with React and TypeScript serves the interface and API. [Node.js’s built-in SQLite module](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) provides persistence without a separate database server. The `node:sqlite` module is still at the _release candidate_ stage in Node 24.

```text
src/lib/network.ts     HTTP, allowed destinations, and robots.txt
src/lib/feed.ts        RSS/Atom discovery and normalization
src/lib/connectors/    Brave1 and Defender Media public-page extraction
src/lib/collector.ts   Collection, caching, and error handling
src/lib/store.ts       SQLite persistence and personal state
src/lib/migrations.ts  Versioned database upgrades
src/lib/classifier.ts  Replaceable classification and explicit rules
src/lib/stories.ts     Conservative announcement grouping and comparison hints
src/lib/story-feed.ts  Group presentation after view and search filters
src/app/api/monitor/   Local reads and mutations
src/components/       Monitoring interface
scripts/collect.ts    Command-line collection
tests/                RSS/Atom, duplicates, selection, and error cases
```

Collection, classification, and any future summary generation are separate concerns. Another engine can implement the `Classifier` contract without changing the connectors. A future [Jev](https://docs.typesafe.ai/models) or text-generation integration would require explicit configuration, usage limits, and evaluation on the languages actually used.
