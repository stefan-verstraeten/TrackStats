# TrackStats

A small, private web app for recording and summarizing your own health monitoring data on your phone.
You define your own trackers; the app stores everything **only on your device** and works offline.

## Tracker types

| Type | Use it for | Logging | Stats |
|---|---|---|---|
| **Measurement** | Blood pressure, weight, glucose, sleep hours… One or more values, each with a unit, decimals and an optional target range | Form with one input per value | Line chart with target bands; average ± SD, latest, change, min, max, % in target |
| **Scale** | Mood, pain, energy (0/1 to 3–10) | Tap a number | Line chart; average, latest, min, max |
| **Counter** | Liquid intake (ml), episodes | One-tap **+amount** (e.g. +250 ml, set per tracker) or any amount | Daily bars with goal line; per-day average, total, best day, goal days |
| **Yes / No** | Medication taken, exercise done | One-tap **✓** | Calendar grid; % of days, current and best streak |

On first launch, **Add my 3 trackers** sets up the default set: blood pressure (systolic/diastolic/pulse),
liquid intake (ml, +250 per tap) and a 1–10 headache score. Everything is editable afterwards.

Every entry has a date/time (editable, so you can log after the fact) and an optional note.
Periods: 7 days, 30 days, 90 days, 1 year, all.

## Use it on your iPhone

1. Open the hosted URL in **Safari** (see *Hosting* below).
2. Tap **Share → Add to Home Screen**. It now opens full-screen like an app, and works offline.
3. Data lives in that home-screen app only. Use **Trackers → Back up (JSON)** regularly; **Restore backup** merges a backup back in. **Export CSV** gives a spreadsheet-friendly file.

## Run locally

No build step and no dependencies — plain HTML, CSS and JavaScript modules.

```bash
python3 -m http.server 8765
```

Then open <http://localhost:8765>.

## Hosting (GitHub Pages)

1. Create an empty GitHub repository named `TrackStats` and push this folder to it.
2. In the repository: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root**.
3. The app is then served at `https://<your-user>.github.io/TrackStats/`.

When you change files, bump `CACHE` in `sw.js` so installed copies pick up the new version.

## Project layout

```
index.html            app shell
css/styles.css        styles (light + dark)
js/app.js             screens, forms, events
js/store.js           data model + localStorage persistence, backup/restore
js/stats.js           date helpers and statistics (pure functions)
js/charts.js          dependency-free SVG charts
sw.js                 service worker (offline)
manifest.webmanifest  install metadata
icons/                app icons
```

## Privacy

No accounts, no server, no analytics. Nothing leaves the phone unless you export it.
TrackStats is a personal logging tool, not a medical device; example target ranges are placeholders — set your own with your doctor.
