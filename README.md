# Defense Tech Monitor

A personal monitoring application for following developments in drones, robotics, and defense technology from sources you choose.

Publications are collected through RSS/Atom, stored locally, and selected using an editable keyword profile. Each publication retains its original title, source, language, and link.

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
- **Sources**: add websites or feeds, enable or disable collection, and inspect collection status and errors.
- **Monitoring profile — Profil de veille**: keywords, exclusions, and the minimum number of matches required. A single exclusion keyword removes a publication from the selection without removing it from the full feed.

Start collection with **Refresh sources — Actualiser les sources** or `npm run collect`. Collection is not scheduled automatically. By default, a source checked within the last 15 minutes is skipped. Set `DTM_COLLECTION_INTERVAL_MINUTES` to change this interval; source access restrictions and crawl delays still apply.

Feedback is saved as relevant, off-topic, or already seen. The profile view reports publications you marked relevant that the rules missed, and publications selected by the rules that you marked off-topic. Feedback does not trigger automatic model training.

## Sources

The four initial sources are defined in [`config/sources.json`](config/sources.json) and seeded into the database on first launch. Existing database entries are not overwritten by this file. Sources added through the interface remain in the local database.

| Source                                                              | Current collection support                           |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| [Ukraine’s Arms Monitor](https://ukrainesarmsmonitor.substack.com/) | [RSS](https://ukrainesarmsmonitor.substack.com/feed) |
| [Militarnyi](https://militarnyi.com/en/)                            | [English RSS](https://militarnyi.com/en/news/feed/)  |
| [Brave1](https://brave1.gov.ua/en)                                  | Source registered; a dedicated connector is required |
| [Defender Media](https://thedefender.media/en/)                     | Source registered; a dedicated connector is required |

To add a source, enter its name and website under **Sources**. The application looks for an RSS/Atom link explicitly advertised by the page; you can also provide a feed URL directly. Failure to discover a feed does not mean the website has stopped publishing. Entering the same website URL again updates its configuration.

Collection respects `robots.txt`, limits response size, applies timeouts, and validates network destinations, including redirects. Failed sources retain previously collected articles and display their errors. Conditional HTTP requests (`ETag`, `Last-Modified`) and content hashes reduce repeated processing.

## Data and limitations

- Displayed publications come from real feeds. Only tests use synthetic data.
- Publication and collection timestamps are separate. Unknown publication dates remain unknown.
- Available feed text is analyzed up to a limit of 20,000 characters. Feed text is not necessarily the complete article. The interface displays excerpts of up to 400 characters; the API does not expose the stored article body.
- Full articles are not republished. The application does not bypass paywalls, transcribe videos, or invent summaries from titles.
- Classification uses deterministic keyword rules, with limitations around synonyms and languages. Matches indicate relevance to a profile, never the reliability of a claim.
- Repeated imports of a publication from the same source are detected through its identifier or normalized URL. **Coverage of the same announcement across different outlets is not yet grouped**, and repeated coverage is not presented as independent confirmation.
- This version does not include exhaustive archive imports, generated summaries, topic folders, alerts, or audio.
- The database and `.env` files are excluded from Git. The example configuration contains no secrets. To back up local data, stop the application and copy the `data/` directory.

## Architecture

A [Next.js](https://nextjs.org/docs) monolith with React and TypeScript serves the interface and API. [Node.js’s built-in SQLite module](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) provides persistence without a separate database server. The `node:sqlite` module is still at the _release candidate_ stage in Node 24.

```text
src/lib/network.ts     HTTP, allowed destinations, and robots.txt
src/lib/feed.ts        RSS/Atom discovery and normalization
src/lib/collector.ts   Collection, caching, and error handling
src/lib/store.ts       SQLite persistence and personal state
src/lib/classifier.ts  Replaceable classification and explicit rules
src/app/api/monitor/   Local reads and mutations
src/components/       Monitoring interface
scripts/collect.ts    Command-line collection
tests/                RSS/Atom, duplicates, selection, and error cases
```

Collection, classification, and any future summary generation are separate concerns. Another engine can implement the `Classifier` contract without changing the connectors. A future [Jev](https://docs.typesafe.ai/models) or text-generation integration would require explicit configuration, usage limits, and evaluation on the languages actually used.
