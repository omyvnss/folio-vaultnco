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
    URLs per run (live-checked, never duplicated); dead/unpublished links
    are skipped permanently. Screenshots via headless Chrome.
- **`.github/workflows/update.yml`** — runs **3× per day** on GitHub's servers.
  Same sync flow, then auto-commits fresh data so the live site stays current.
  No secrets, no external services.

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
├── cache-screenshots.js        # batch screenshot capture (Chrome headless)
├── CNAME                       # folio.vaultnco.store
├── data/
│   ├── sites.json              # live-verified site list (auto-updated)
│   ├── sites.csv               # CSV mirror of sites.json
│   ├── history/                # dated snapshots per sync day
│   └── screenshots/            # cached WebP previews (1280×800)
└── .github/workflows/
    └── update.yml              # 3× daily auto-sync
```

## Update the directory

Add or remove URLs at the source. Verified changes appear on the site within a
few hours automatically. Manual sync anytime:
repo → **Actions** → *update-archive* → **Run workflow**.

---

Curated by [Om Yaduvanshi](https://github.com/omyvnss).
