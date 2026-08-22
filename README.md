# MNMM.CLONE

A single-file clone of [mnmm.xyz](https://mnmm.xyz) — a minimal websites directory.
Pitch-black, monospace, zero build step.

## How it works

- **`index.html`** — the entire app. Tailwind (CDN) + vanilla JS.
  - Fetches the archive live from the Google Sheet CSV on every visit.
  - Falls back to `data/sites.csv` (last committed snapshot) if the sheet is unreachable.
  - Shows a clean monospace error if both fail.
  - Screenshots via Microlink: `https://api.microlink.io/?url=https://{URL}&screenshot=true&meta=false&embed=screenshot.url`
  - Grayscale → full color on hover. `NEW` badge on sites added in the last 7 days (from the sheet's `Date Added` column). "Top 5 New" section above the full archive.
- **`.github/workflows/update.yml`** — daily cron at **17:00 IST**. Downloads the CSV, and if it changed, commits it to `data/sites.csv` plus a dated copy in `data/history/YYYY-MM-DD.csv`.

The live site always shows fresh data (client-side fetch); the cron gives you
versioned history and an offline fallback — it does not need to run for the site to work.

## Run locally

No build step. Open `index.html`, or serve it:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

## Import to GitHub

```bash
git init                       # already done in this folder
git add .
git commit -m "feat: mnmm.clone — minimal sites directory"
gh repo create mnmm-clone --public --source=. --push
```

Or create an empty repo on github.com and push manually. VS Code is only your
editor here — the cron runs on GitHub's servers (repo → Actions tab).

## Update the directory

Edit the Google Sheet (`Website URL`, `Date Added`). Changes appear on the site
immediately for new visitors; the cron snapshots them daily at 17:00 IST.
Manual sync anytime: repo → **Actions** → *update-archive* → **Run workflow**.

## Structure

```
├── index.html                     # the app
├── data/
│   ├── sites.csv                  # latest snapshot (cron-maintained)
│   └── history/                   # dated snapshots YYYY-MM-DD.csv
└── .github/workflows/update.yml   # daily cron @ 17:00 IST
```
