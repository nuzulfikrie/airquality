# Sekolah Al-Amin and Boarding School Selangor Air Quality

Static dashboard (no build step) for Cloudflare Pages. Shows live AQI / PM2.5 for
Sekolah Al-Amin campuses across Selangor on a Leaflet map + card grid.

## Data flow (reverse-engineered from aqicn.org `airnet.js`)

| Purpose | Endpoint | Auth |
|---|---|---|
| Official stations in bbox | `POST https://api.waqi.info/mapq/bounds` (form: `bounds,inc,viewer`) | none |
| AirNet community sensors in bbox | `POST https://airnet.waqi.info/airnet/map/bounds` (JSON: `bounds,zoom,xscale,width`) | none |
| AirNet hourly species (PM2.5 series) | `GET https://airnet.waqi.info/airnet/feed/hourly/{id}` | none |
| Official station feed (PM2.5, time) | `GET /api/feed/{id}` → Pages Function → `api.waqi.info/api/feed/@{id}/aqi.json` | `WAQI_TOKEN` secret |
| WAQI map (same-origin proxy) | `POST /api/waqi-map` → `api.waqi.info/mapq/bounds` | none |
| AirNet map (same-origin proxy) | `POST /api/airnet-map` → `airnet.waqi.info/airnet/map/bounds` | none |
| AirNet hourly feed (same-origin proxy) | `GET /api/airnet-feed/{id}` → `airnet.waqi.info/airnet/feed/hourly/{id}` | none |

The app tries the same-origin Pages Functions first (zero CORS risk from your Pages domain) and
falls back to calling the upstream endpoints directly — the exact pattern aqicn.org uses.
The official feed requires a token; the Pages Function keeps it server-side. Without the token the
dashboard still works — official stations show AQI-only.

## Deploy

```bash
npm i -g wrangler
wrangler login
npx wrangler pages deploy . --project-name=alamin-aq
```

Optional PM2.5 for official stations:

```bash
npx wrangler pages secret put WAQI_TOKEN --project-name=alamin-aq
# paste token from https://aqicn.org/data-platform/token/
```

## Fine-tune school coordinates

Edit `data/schools.json`. Entries with `"approx": false` were checked against OpenStreetMap or the
school's published address (Bukit Beruntung from a Google Maps pin). `"approx": true` (currently only
`kajang`) is unconfirmed: drop a pin in Google Maps, replace lat/lon, then set `approx` to false.

## What the numbers mean

- The AQI is the US EPA scale. Official DOE stations (WAQI) report an overall AQI plus its dominant
  pollutant (`pol`), often PM10, so cards show e.g. `AQI 172 · PM10`.
- PM2.5 in µg/m³ comes from AirNet sensors. The card's AQI is computed from that same reading
  (latest `feed.pm25`, else the map's `c`, else the last hourly mean) with the 2024 EPA PM2.5
  breakpoints (truncate to 0.1 µg/m³, interpolate, round).
- The search box is ±0.25° around each campus; only stations within 25 km and newer than 48 h are used.

## GitHub Pages (static hosting)

GitHub Pages serves files only, so `functions/` does not run there. The app notices the missing
`/api/*` proxies (it skips them on `*.github.io`, and remembers the first 404/405 elsewhere) and the
browser calls `api.waqi.info` and `airnet.waqi.info` directly. Both send `Access-Control-Allow-Origin: *`.
The optional official-station detail (`/api/feed`, needs `WAQI_TOKEN`) is unavailable there, so official
stations show the AQI and its dominant pollutant only. `.nojekyll` keeps Pages from running Jekyll.

## Local preview

Any static server works (Pages Functions won't run locally without `wrangler pages dev`):

```bash
npx wrangler pages dev .   # full preview incl. functions
```
