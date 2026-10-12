# Folio VaultnCo

A minimal websites directory — **folio.vaultnco.store**.
Pitch-black, monospace, zero build step. Every site verified live before it appears.

## How it works

- **`index.html`** — the entire frontend. Vanilla JS + exact design tokens.
  - Loads `data/sites.json` (pre-verified snapshot) for instant rendering.
  - Serves screenshots locally from `data/screenshots/*.webp` — millisecond loads.
  - Falls back to the backend API → committed JSON → CSV if needed.
- **`server.js`** — zero-dependency Node backend + sync engine.
  - `node server.js` — serves the site at `localhost:3000`
  - `node server.js sync` — pulls the source sheet and drip-feeds up to 3 new
    URLs per run (live-checked, never duplicated); dead links are skipped and
    retried on the next run. Each new site records its `added` date.
- **`cache-screenshots.js`** — captures missing/blank previews with headless
  Chrome and normalises every preview to a real 1280×800 WebP (needs `cwebp`).
- **`engine/`** — the self-updating engine (`node engine/run.js [--dry-run]`).
  Publishes 1 new site per day through verified steps:

  ```
  candidate ─► live ─► screenshot ─► AI review ─► publish
     │          │          │             │            │
   verify     verify     verify        verify       verify
  ```

  Candidates come from the sheet; when it runs dry, a free OpenRouter model
  discovers new sites. Each step has a deterministic code verifier — bad AI
  output is retried on another free model, unsuitable sites go to
  `data/rejected.json`, and every run is logged in `data/engine-log.json`.
  Verifier tests: `node engine/test.js`.
- **`.github/workflows/update.yml`** — runs **once a day** on GitHub's servers:
  self-test → engine → screenshot normalisation → auto-commit.
  Needs repo secret **`OPENROUTER_API_KEY`** (free key from openrouter.ai) for
  AI review/discovery; without it the engine uses heuristic checks only.
- **`og.png`, `favicon.svg`, `apple-touch-icon.png`** — link-preview + icons.

## Run locally

```bash
git clone https://github.com/omyvnss/folio-vaultnco.git
cd folio-vaultnco
node server.js          # → http://localhost:3000
```

## Structure

```
├── index.html                  # the app (single file)
├── server.js                   # backend + sync engine
├── cache-screenshots.js        # screenshot capture + WebP normalisation
├── og.png                      # 1200×630 social preview
├── CNAME                       # folio.vaultnco.store
├── data/
│   ├── sites.json              # live-verified site list (auto-updated)
│   ├── sites.csv               # CSV mirror of sites.json
│   ├── history/                # dated snapshots per sync day
│   └── screenshots/            # cached WebP previews (1280×800)
└── .github/workflows/
    └── update.yml              # daily auto-sync
```

## Update the directory

Add or remove URLs at the source. Verified changes appear on the site within a
day automatically (1 new verified site per day; set repo variable `PER_DAY` to change). Manual sync anytime:
repo → **Actions** → *update-archive* → **Run workflow**.

---

Curated by [Om Yaduvanshi](https://github.com/omyvnss).
