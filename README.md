# tp-surfcast2

A surf forecast built for one place and one crew: **Torrey Pines State Beach at
the north lot**, for surfing, in the 7:30&ndash;10:00am window.

It is not a regional forecast with a spot name attached. Every number is
transformed onto this beach's own orientation, slope and sandbar behaviour, then
anchored to the buoy sitting eight miles straight offshore.

---

## Why this can beat a generic forecast here

A regional service has to be roughly right at a thousand spots. This has to be
right at one, which buys four specific advantages:

1. **It is anchored to CDIP 100p1.** Every run measures how far each global wave
   model has drifted from what the Torrey Pines Outer buoy actually recorded over
   the last 24 hours, and corrects that model before using it. A forecast that
   ignores the buoy eight miles offshore is throwing away the best data available.

2. **It does the local wave transformation.** Deep-water height is refracted and
   shoaled onto a 265&deg; shore normal and a 3% beach face, per swell partition,
   then broken with a depth-limited criterion. That is why a 290&deg; swell and a
   250&deg; swell of identical height produce different surf here &mdash; which they
   genuinely do, and which a single regional number cannot express.

3. **It reports uncertainty instead of hiding it.** Three wave models are kept
   separate and their disagreement is shown. When they agree, the day is locked
   in. When they argue, you are told so rather than being handed a confident
   single number.

4. **It keeps score.** Every run is archived and later graded against what the
   buoy actually measured, by lead time. The scoreboard is on the page. No
   forecast deserves trust without one.

It also reads the full 1-D energy spectrum from the buoy rather than just height
and period, which is how it can separate the swell trains in the water and tell
you a new long-period pulse is filling in before it shows up in the bulk height.

## What is on the page

- **Today** &mdash; the call for your window, face height with body-scale wording,
  board recommendation, wetsuit, and a post-rain water quality advisory.
- **Hour by hour** &mdash; surf size, total wave energy (kW/m), swell direction and
  period, wind and tide, each on its own axis with the 7:30&ndash;10:00 band shaded.
- **7-day** &mdash; every day scored for your window, not for its best hour.
- **14-day outlook** &mdash; score by day plus the spread between wave models.
- **What changed** &mdash; this run against the runs from 24, 48 and 120 hours ago.
- **Buoy** &mdash; live CDIP 100p1 readings, the swell trains in the water, and a
  nowcast check of the model against the buoy right now.
- **Skill** &mdash; forecast error against buoy observations, by lead time.
- **Session log** &mdash; rate what it was actually like; entries carry what we
  predicted alongside what you saw.

## Setup (one time)

1. **Turn on Pages.** Settings &rarr; Pages &rarr; Source: **GitHub Actions**.
2. **Run it once.** Actions &rarr; `forecast` &rarr; Run workflow.

The site then lives at <https://nshikuma.github.io/tp-surfcast/> and rebuilds
itself every few hours. GitHub runs free scheduled jobs when it has capacity, so
the three-hour cron in practice lands every three to five hours.

> This repository is public so GitHub Pages can serve the page for free. It
> holds only forecast code and forecast data &mdash; no credentials &mdash; and commits
> are authored under a GitHub noreply address rather than a personal email.
>
> Until Pages is switched on, the `publish` job fails on its own while `build`
> keeps fetching and committing forecast data. That is deliberate: a missing
> one-time settings step should never cost a forecast run.

## Running it locally

```bash
npm test                 # 32 physics and scoring tests
node src/build.js        # real data (needs outbound network)
node src/build.js --synthetic   # plausible fake data, for layout work
npx http-server docs     # or any static server
```

## How it works

```
CDIP 100p1 buoy  ──┐
NOAA 9410230 tide ─┤
Open-Meteo marine ─┼─► src/build.js ─► docs/data/forecast.json ─► docs/index.html
Open-Meteo wind  ──┘        │
                            └─► docs/data/archive/*.json  (drift + skill history)
```

| File | What it does |
|---|---|
| `src/config.js` | Site geometry and **every tunable constant**, each with its basis written down |
| `src/model/waves.js` | Refraction, shoaling, depth-limited breaking, energy, breaker type |
| `src/model/score.js` | Tide / wind / period / shape / size scoring and the board call |
| `src/model/forecast.js` | Model ensembling, buoy bias correction, daily rollup, drift |
| `src/model/verify.js` | Skill scoring against buoy observations |
| `src/sources/*.js` | One adapter per data source, each with a fallback |
| `docs/` | The published page: no build step, no CDN, no dependencies |

## Calibration

The model is tuned against three real anchor cases, locked in by the test suite:

| Buoy reading | Expected at the north lot |
|---|---|
| 1.0 m / 15 s / WNW | waist-to-chest, shoulder-high sets |
| 2.0 m / 16 s / NW | head high, overhead sets |
| 0.7 m / 17 s / SSW | knee-to-thigh, inconsistent |

**Retuning from real sessions** is the intended path to getting sharper:

1. Log sessions on the page, then use **Export log for calibration**.
2. Compare `observedSize` against the `forecast` recorded in each entry.
3. Adjust `CALIBRATION.faceFactor` (overall size bias), `CALIBRATION.tide`
   (which tide the bars actually like), or `BAR_ALIGNMENT` (which swell angles
   line up) in `src/config.js`.
4. Run `npm test`. The anchor cases will catch a change that breaks the others.

## Honest limitations

- **The source adapters are proven against live data.** They were written blind -
  the build environment blocked every marine data host - but live runs reach CDIP,
  NOAA CO-OPS and the wave models with no errors, and the forecast tracks the buoy
  to within about 0.2 ft. `docs/data/diagnostics.json` records the status of every
  request per run, plus how many hours each wave model contributed.
- **GFS-Wave currently contributes nothing.** Open-Meteo serves its partition
  heights without partition periods, so it abstains from the ensemble rather than
  voting (see `modelHourCounts` in the diagnostics). The forecast is effectively a
  two-model ensemble - ECMWF-WAM and Meteo-France WAM - until that feed carries
  periods again.
- **The exposure and bar-alignment tables are engineering estimates**, not
  measured transmission coefficients. They are the first thing to retune.
- **Beyond about seven days** a wave model is identifying patterns, not days.
  The 14-day view is for spotting swell, not for planning a session.
- **Surfline comparison is off.** `src/sources/surfline.js` is a working seam:
  return `{hourly:[{time, surfMinFt, surfMaxFt}]}` and set `SURFLINE_ENABLED=1`
  to turn the head-to-head back on.
- **No crowd or parking forecast, and no dedicated big-day hazard panel** &mdash;
  both were left out by choice. Days with sets over 8 ft still get a current
  warning in the daily verdict.

## Data sources

| Source | Used for |
|---|---|
| [CDIP 100p1](https://cdip.ucsd.edu/m/products/?stn=100p1&param=waveHs) | Height, period, direction, full energy spectrum, SST |
| NDBC 46225 | Fallback mirror of the same buoy, plus a swell/windsea split |
| NOAA CO-OPS 9410230 (Scripps Pier) | Tide predictions and water temperature |
| Open-Meteo Marine (ECMWF-WAM, GFS-Wave, M&eacute;t&eacute;o-France WAM) | Wave forecast ensemble |
| Open-Meteo Weather (ECMWF-IFS, GFS) | Wind, rain, sunrise/sunset |

All are public and unauthenticated. Be a good citizen about request rates.
