#!/usr/bin/env node
/**
 * Build the forecast payload the page reads.
 *
 * Run by GitHub Actions on a schedule. Every source is allowed to fail without
 * sinking the build: a missing wind model degrades the forecast, a missing buoy
 * removes the bias correction, but the page still renders and says plainly what
 * is missing. A surf forecast that silently drops a source and keeps looking
 * confident is worse than one that admits the gap.
 */

import { writeFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITE, SESSION_WINDOW, SOURCES, FORECAST_DAYS, CALIBRATION } from './config.js';
import { settleAll, trace } from './lib/http.js';
import * as cdip from './sources/cdip.js';
import * as ndbc from './sources/ndbc.js';
import * as tidesSrc from './sources/tides.js';
import * as om from './sources/openmeteo.js';
import * as mop from './sources/mop.js';
import { fetchSurfline, ENABLED as SURFLINE_ENABLED } from './sources/surfline.js';
import * as syn from './lib/synthetic.js';
import {
  buildHourly, buildDaily, computeModelBias, computeDrift, wetsuitCall, compass, median,
} from './model/forecast.js';
import { scoreSkill, nowcastCheck } from './model/verify.js';
import { buildNearshore, compareAtHome } from './model/nearshore.js';
import { stepState, describe, profileFor, COEFFS } from './model/beachstate.js';
import { mixForHour, mixForDay, smoothShares, CLASS_ORDER as MIX_ORDER } from './model/mix.js';
import { callFor, reliabilityFor, scoreHour } from './model/score.js';
import { gradeSessions } from './model/groundtruth.js';
import { M_TO_FT, wavePowerKwPerM, transformToBreak, faceHeights, sizeLabel, combineFaces } from './model/waves.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(__dirname, '..', 'docs');
const DATA = path.join(DOCS, 'data');
const ARCHIVE = path.join(DATA, 'archive');
const SYNTHETIC = process.argv.includes('--synthetic');

/**
 * How long a measured buoy spectrum stays the best description of what is in
 * the water. Swell takes many hours to change, so for the first half-day the
 * thing eight miles offshore beats a global model's guess at the same water -
 * and on 2026-09-16 it was carrying an 18.2 s south groundswell that neither
 * model had at all.
 */
const BUOY_ANCHOR_HOURS = 12;

const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const MAX_ARCHIVE_FILES = 160;

const log = (...a) => console.log('[tp-surfcast2]', ...a);

/* ----------------------------------------------------------- collection -- */

async function collect() {
  if (SYNTHETIC) {
    log('SYNTHETIC MODE - generating plausible data, not a real forecast');
    return {
      data: {
        buoy: syn.syntheticBuoy(),
        spectrum: syn.syntheticSpectrum(),
        tides: syn.syntheticTides(),
        marine: syn.syntheticMarine(),
        weather: syn.syntheticWeather(),
        waterTemp: { f: 66.9, station: 'synthetic' },
        surfline: null,
      },
      errors: {},
    };
  }

  const { out, errors } = await settleAll({
    buoy: () => cdip.fetchBuoy(),
    spectrum: () => cdip.fetchSpectrum(),
    tides: () => tidesSrc.fetchTides(),
    marine: () => om.fetchMarine(),
    weather: () => om.fetchWeather(),
    waterTemp: () => tidesSrc.fetchWaterTempF(),
    // Scripps' own nearshore model along this stretch of beach.
    transect: () => mop.fetchTransect(),
    // Which swells are in the water, kept separate rather than lumped.
    trains: () => om.fetchSwellTrains(),
    surfline: () => fetchSurfline(),
  });

  // Fallback chain for the buoy: CDIP THREDDS -> CDIP text -> NDBC mirror.
  if (!out.buoy) {
    for (const [name, fn] of [['cdip-justdar', () => cdip.fetchBuoyJustdar()], ['ndbc', () => ndbc.fetchStandard()]]) {
      try {
        out.buoy = await fn();
        log(`buoy: primary source failed, using ${name}`);
        errors.buoyFallback = `used ${name}`;
        break;
      } catch (e) { errors[`buoy:${name}`] = String(e.message); }
    }
  }
  // NDBC's spectral product is a usable stand-in if CDIP's spectrum is missing.
  if (!out.spectrum) {
    try { out.ndbcSpec = await ndbc.fetchSpec(); } catch (e) { errors['ndbc:spec'] = String(e.message); }
  }
  if (!out.waterTemp) {
    const c = out.buoy?.sstC;
    if (Number.isFinite(c)) out.waterTemp = { f: c * 9 / 5 + 32, station: 'buoy' };
    else {
      try { out.waterTemp = await om.fetchSeaTempF(); } catch (e) { errors.waterTemp2 = String(e.message); }
    }
  }
  return { data: out, errors };
}

/* -------------------------------------------------------------- archive -- */

async function loadArchives() {
  if (!existsSync(ARCHIVE)) return [];
  const files = (await readdir(ARCHIVE)).filter((f) => f.endsWith('.json')).sort();
  const runs = [];
  for (const f of files) {
    try {
      runs.push(JSON.parse(await readFile(path.join(ARCHIVE, f), 'utf8')));
    } catch { /* a truncated archive file should never break a build */ }
  }
  return runs;
}

/** Pick the archived run closest to each target age, for the drift comparison. */
function pickForDrift(runs, targets = [24, 48, 120]) {
  const now = Date.now();
  const out = [];
  for (const ageHours of targets) {
    const want = now - ageHours * 36e5;
    let best = null, bestDt = Infinity;
    for (const r of runs) {
      const dt = Math.abs(Date.parse(r.issued) - want);
      if (dt < bestDt) { bestDt = dt; best = r; }
    }
    // Only meaningful if it is actually near the target age.
    if (best && bestDt < 12 * 36e5) out.push({ ageHours, days: best.days, issued: best.issued });
  }
  return out;
}

/* ------------------------------------------------------- current state --- */

/**
 * What the buoy says is happening RIGHT NOW, run through the same local
 * transformation as the forecast so the "current" number and the "forecast"
 * number are directly comparable.
 */
function buildCurrent(buoy, spectrum, ndbcSpec, tides) {
  if (!buoy?.latest) return null;
  const b = buoy.latest;
  const trains = spectrum
    ? cdip.partitionSpectrum(spectrum.bands)
    : ndbcSpec?.latest
      ? [ndbcSpec.latest.swell, ndbcSpec.latest.windSea]
        .filter((p) => p && p.hsM > 0.05)
        .map((p) => ({ hsM: p.hsM, periodS: p.periodS, dirDeg: p.dirDeg, energyFraction: null }))
      : [];

  const breaking = trains.map((t) => {
    const r = transformToBreak(t.hsM, t.periodS, t.dirDeg ?? b.dirDeg, { origin: 'buoy' });
    const f = faceHeights(r.Hb);
    return {
      hsM: t.hsM, hsFt: t.hsM * M_TO_FT, periodS: t.periodS,
      dirDeg: t.dirDeg, dirCompass: compass(t.dirDeg),
      energyFraction: t.energyFraction,
      powerKwPerM: wavePowerKwPerM(t.hsM, t.periodS),
      faceFt: f.typicalFt, sizeLabel: sizeLabel(f.typicalFt).label,
      kind: t.periodS >= 10 ? 'groundswell' : 'windswell',
    };
  }).sort((x, y) => y.faceFt - x.faceFt);

  const whole = transformToBreak(b.hsM, b.tpS || 12, b.dirDeg ?? SITE.shoreNormalDeg, { origin: 'buoy' });
  const face = faceHeights(whole.Hb);
  // Sets from the measured partitions, not from a flat multiple of the whole
  // sea: when three trains are running, the set waves are the ones where they
  // coincide, and that is a far bigger number than 1.3 times the average.
  const combined = breaking.length ? combineFaces(breaking.map((t) => t.faceFt)) : null;
  const setFt = combined ? Math.max(face.setFt, combined.setFt) : face.setFt;
  const nowIso = new Date().toISOString();

  return {
    observedAt: b.time,
    source: buoy.source,
    station: buoy.station,
    deepHsM: b.hsM,
    deepHsFt: b.hsM * M_TO_FT,
    periodS: b.tpS,
    dirDeg: b.dirDeg,
    dirCompass: compass(b.dirDeg),
    powerKwPerM: wavePowerKwPerM(b.hsM, b.tpS || 12),
    faceFt: face.typicalFt,
    faceSetFt: setFt,
    sizeLabel: sizeLabel(face.typicalFt).label,
    setSizeLabel: sizeLabel(setFt).label,
    superposition: combined ? Math.round(combined.superposition * 100) / 100 : 1,
    tideFt: tides ? tidesSrc.tideAt(tides, nowIso) : null,
    tideRate: tides ? tidesSrc.tideRateAt(tides, nowIso) : null,
    trains: breaking,
    history: buoy.records.slice(-96).map((r) => ({
      time: r.time, hsFt: r.hsM * M_TO_FT, periodS: r.tpS, dirDeg: r.dirDeg,
      powerKwPerM: wavePowerKwPerM(r.hsM, r.tpS || 12),
    })),
  };
}

/* ----------------------------------------------------------------- main -- */

async function main() {
  const startedAt = new Date().toISOString();
  const { data, errors } = await collect();

  if (!data.marine) {
    throw new Error(`Fatal: no wave model data available. ${JSON.stringify(errors)}`);
  }
  if (!data.weather) {
    throw new Error(`Fatal: no wind data available. ${JSON.stringify(errors)}`);
  }

  // Bias-correct each wave model against the buoy.
  const biasByModel = {};
  for (const model of data.marine.models) {
    biasByModel[model] = data.buoy
      ? computeModelBias(data.buoy.records, data.marine.byModel[model])
      : { factor: 1, n: 0, note: 'no buoy data - models used uncorrected' };
    log(`bias ${model}: x${biasByModel[model].factor.toFixed(3)} (${biasByModel[model].note})`);
  }

  const hourly = buildHourly({
    marine: data.marine,
    weather: data.weather,
    tides: data.tides,
    biasByModel,
  });
  if (!hourly.length) throw new Error('Fatal: hourly forecast came out empty');

  // Precipitation history for the water-quality advisory.
  const firstWind = data.weather.byModel[data.weather.models[0]] || [];
  const rainHistory = firstWind.map((r) => ({ time: r.time, precipIn: r.precipIn }));


  // What each day's swell is MADE of, and the one-word call. Computed here
  // rather than in the page so the browser never has to run wave physics to
  // render a headline.
  // Attach the partitioned swell trains to the hourly objects BEFORE anything
  // reads them. They used to be bolted on during payload compaction, which runs
  // a hundred lines below this - so the mix model saw every hour as trainless
  // and shipped an empty swell breakdown while the build went green.
  const trains = data.trains || null;
  for (const h of hourly) {
    h.trains = (trains?.get(h.time) || []).slice(0, 4).map((p) => ({
      kind: p.kind,
      hsM: p.hsM,
      hsFt: p.hsM * M_TO_FT,
      periodS: p.periodS,
      dirDeg: p.dirDeg,
      dirCompass: compass(p.dirDeg),
    }));
  }
  // A source outage is survivable; wiring the source to nothing is not. If the
  // trains came back but none of them reached an hour, that is a bug in this
  // file and the build should say so rather than quietly publishing a page with
  // the swell breakdown missing - which is exactly what happened the first time.
  if (trains?.size && !hourly.some((h) => h.trains.length)) {
    throw new Error(`Fatal: ${trains.size} swell-train records fetched but none matched an hourly timestamp.`);
  }
  if (!trains?.size) {
    log('WARNING: no partitioned swell trains in this run - the swell breakdown will be empty.');
  }

  // The buoy is eight miles straight out and measures the real spectrum. On
  // 2026-09-16 it was reading an 18.2 s south groundswell that NEITHER global
  // model had in its partitions - they showed 12.8 s and nothing longer - and
  // the page called a head-high-sets morning waist high partly because of it.
  // For the hours close to an observation, what is in the water IS what the
  // buoy just measured, so use that instead of the models' guess at it.
  const current = buildCurrent(data.buoy, data.spectrum, data.ndbcSpec, data.tides);

  /**
   * Are the buoy and the global models describing the same ocean?
   *
   * On 2026-09-16 they were not: the buoy's peak period was 18.2 s and the
   * models' was 11.5 s, because neither model had the south groundswell in its
   * partitions at all. That is not a small error to average away - it is the
   * difference between a clean long-period pulse and a lump of windswell, and
   * it is worth saying out loud on the page rather than quietly splitting the
   * difference.
   */
  let buoyCheck = null;
  if (current && hourly.length) {
    const nearest = hourly.reduce((a, b) => (
      Math.abs(Date.parse(b.time) - Date.parse(current.observedAt))
        < Math.abs(Date.parse(a.time) - Date.parse(current.observedAt)) ? b : a));
    const dT = (current.periodS ?? 0) - (nearest.periodS ?? 0);
    const dH = (current.deepHsFt ?? 0) - (nearest.deepHsFt ?? 0);
    buoyCheck = {
      observedAt: current.observedAt,
      buoyPeriodS: round1(current.periodS),
      modelPeriodS: round1(nearest.periodS),
      periodGapS: round1(dT),
      buoyHsFt: round1(current.deepHsFt),
      modelHsFt: round1(nearest.deepHsFt),
      heightGapFt: round1(dH),
      // Four seconds of peak period is a different swell, not a tuning error.
      periodDisagrees: Math.abs(dT) >= 4,
      note: Math.abs(dT) >= 4
        ? `The buoy is reading a ${round1(current.periodS)} s peak and the models are on `
          + `${round1(nearest.periodS)} s. A gap that size usually means the models are `
          + 'missing a swell the buoy can already see, so the near-term size and shape here '
          + 'are taken from the buoy rather than from them.'
        : 'Buoy and models agree on the period to within a few seconds.',
    };
    log(`buoy check: Tp buoy ${round1(current.periodS)}s vs model ${round1(nearest.periodS)}s`
      + `${buoyCheck.periodDisagrees ? '  <-- DISAGREE, models may be missing a swell' : ''}`);
  }

  const buoyTrains = current?.trains?.length ? current.trains : null;
  const buoyAt = current?.observedAt ? Date.parse(current.observedAt) : null;
  let anchoredHours = 0;
  if (buoyTrains && buoyAt) {
    for (const h of hourly) {
      const ageH = Math.abs(Date.parse(h.time) - buoyAt) / 36e5;
      if (ageH > BUOY_ANCHOR_HOURS) continue;
      // Substituted whole rather than blended: the two lists are measured at
      // different places (the buoy sits inside the island shadow, the models
      // publish deep water before it) and averaging them would be the
      // double-counting bug this model has already been bitten by once.
      h.trains = buoyTrains.map((t) => ({
        kind: t.kind, hsM: t.hsM, hsFt: t.hsFt,
        periodS: t.periodS, dirDeg: t.dirDeg, dirCompass: t.dirCompass,
        origin: 'buoy',
      }));
      h.trainsFrom = 'buoy';
      anchoredHours++;
    }
    log(`buoy anchor: ${anchoredHours} hours using measured partitions (within ${BUOY_ANCHOR_HOURS} h of the obs)`);
  }

  // Hourly mixes first, then smoothed, so the daily rollup and the chart are
  // built from exactly the same numbers.
  for (const h of hourly) h.mix = mixForHour(h);
  smoothShares(hourly);

  // Set height now comes from the partitions rather than from a flat multiple
  // of the typical wave: the sets are the moments the trains coincide, and a
  // crossed sea makes far bigger sets than a clean one of the same height.
  for (const h of hourly) {
    if (!h.mix?.setFt) continue;
    h.faceSetFt = Math.max(h.faceSetFt, h.mix.setFt);
    h.setSizeLabel = sizeLabel(h.faceSetFt).label;
    h.peel = h.mix.peel;
  }

  // Re-score every hour now that the closeout geometry is known. The first pass
  // in buildHourly cannot do this: the swell partitions it needs are fetched
  // separately and attached above. Scoring a morning of walls as if it peeled
  // is most of why this page called a closed-out day "makeable".
  for (const h of hourly) {
    if (!h.peel) continue;
    const rescored = scoreHour({
      HbM: h.HbM,
      faceTypicalFt: h.faceFt,
      faceSetFt: h.faceSetFt,
      Tp: h.periodS,
      swellDirDeg: h.dirDeg ?? SITE.shoreNormalDeg,
      tideFt: h.tideFt ?? 2,
      tideRate: h.tideRate ?? 0,
      windKt: h.windKt,
      windDirDeg: h.windDirDeg,
      powerKwPerM: h.powerKwPerM,
      peel: h.peel,
    });
    h.score = rescored.total;
    h.grade = rescored.grade;
    h.parts = rescored.parts;
    h.board = rescored.board;
  }

  const allDays = buildDaily(hourly, { weatherDaily: data.weather.daily, rainHistory });
  const todayLocal = hourly.find((h) => Date.parse(h.time) >= Date.now() - 36e5)?.localDate
    ?? allDays[0]?.date;
  const days = allDays.filter((d) => d.date >= todayLocal).slice(0, FORECAST_DAYS.outlook);
  // Measured against the hours that HAVE trains, not against the whole grid.
  // The partitioned fields run about eight days and the hourly grid runs
  // fifteen, so comparing to hourly.length would have the assertion tripping
  // on a perfectly healthy run.
  const withTrains = hourly.filter((h) => h.trains.length).length;
  const classified = hourly.filter((h) => h.mix?.parts?.length).length;
  log(`mix: ${classified} classified of ${withTrains} hours with trains (${hourly.length} hours total)`);
  if (withTrains && classified < withTrains * 0.5) {
    throw new Error(`Fatal: ${withTrains} hours carry swell trains but only ${classified} got a breakdown.`);
  }

  let worstReliability = null;
  days.forEach((d, i) => {
    d.mix = mixForDay(d.hours);
    Object.assign(d, callFor(d.windowScore));
    d.reliability = reliabilityFor(i, d.confidence ?? 1, worstReliability);
    worstReliability = d.reliability;
  });

  // Synthetic runs must never contaminate the drift comparison or the skill
  // scoreboard - they would make the forecast look accurate against data that
  // was never measured.
  /**
   * How much sand is on the beach. The state persists between runs so it
   * accumulates real memory of what the ocean has been doing: a week of swell
   * pulls the berm down and drags the bar offshore, and a calm spell walks it
   * back. Starts neutral and earns its history.
   */
  const STATE_FILE = path.join(DATA, 'beach-state.json');
  let beach = null;
  try {
    let prev = { s: 0, updatedAt: null, history: [] };
    if (existsSync(STATE_FILE)) prev = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    const obs = (data.buoy?.records || []).filter((r) =>
      !prev.updatedAt || Date.parse(r.time) > Date.parse(prev.updatedAt));
    const stepped = stepState(prev.s ?? 0, obs, { from: prev.updatedAt });
    const trend = (stepped.s - (prev.s ?? 0));
    const words = describe(stepped.s, trend);
    const history = [...(prev.history || []), {
      t: startedAt, s: Math.round(stepped.s * 100) / 100,
      e: stepped.meanEnergy == null ? null : Math.round(stepped.meanEnergy * 1e4) / 1e4,
    }].slice(-240);

    beach = {
      shorelineM: Math.round(stepped.s * 100) / 100,
      trendMPerRun: Math.round(trend * 100) / 100,
      hoursStepped: stepped.hoursStepped,
      observations: obs.length,
      updatedAt: stepped.lastObservation || prev.updatedAt || startedAt,
      spinUpRuns: history.length,
      profile: profileFor(stepped.s),
      coefficients: COEFFS,
      ...words,
      note: 'Equilibrium model of the Yates/Guza/O\'Reilly form, driven by measured buoy energy. '
        + 'Coefficients are plausible, not the published Torrey Pines fits; refit them from the '
        + 'Ludka survey data. State accumulates across runs, so early runs carry little memory.',
      history,
    };
    await writeFile(STATE_FILE, JSON.stringify({
      s: stepped.s, updatedAt: beach.updatedAt, history,
    }, null, 1));
    log(`beach: shoreline ${beach.shorelineM} m (${words.level}, ${words.moving}), `
      + `${obs.length} new buoy obs over ${stepped.hoursStepped} h`);
  } catch (e) {
    log(`beach state unavailable: ${e.message}`);
  }

  // The alongshore picture: every 100 m of beach, carried to breaking.
  const nearshore = data.transect ? buildNearshore(data.transect, hourly) : null;
  const mopCheck = nearshore ? compareAtHome(nearshore, hourly) : null;
  if (nearshore) {
    log(`nearshore: ${nearshore.lines.length} MOP lines, home ${nearshore.homeLine}, `
      + `mean shore normal ${nearshore.meanShoreNormalDeg} deg`);
    if (mopCheck) log(`  ${mopCheck.note}`);
  } else {
    log('nearshore: MOP unavailable this run');
  }

  const archives = (await loadArchives()).filter((r) => !r.synthetic);
  const drift = computeDrift(days, pickForDrift(archives));
  const skill = scoreSkill(archives, data.buoy?.records || []);

  // Graded against sessions the crew actually surfed. The buoy comparison above
  // grades the swell; this grades the SURF, which is a different and harder
  // thing, and it is the only check that can see the parts of this model with
  // no instrument behind them - set size, shape, and where the sand is.
  let groundTruth = null;
  try {
    const obsFile = path.join(__dirname, 'data', 'observations.json');
    if (existsSync(obsFile)) {
      const obs = JSON.parse(await readFile(obsFile, 'utf8'));
      groundTruth = gradeSessions(obs.sessions || [], hourly, archives);
      const g = groundTruth.summary;
      log(`ground truth: ${g.n} logged session(s)`
        + (g.setBiasRatio ? `, sets running x${g.setBiasRatio} vs forecast` : ''));
    }
  } catch (e) {
    log(`ground truth unavailable: ${e.message}`);
  }
  const nowcast = data.buoy ? nowcastCheck(hourly, data.buoy.records) : null;

  const windowHoursToday = hourly.filter((h) => h.localDate === todayLocal && h.inWindow);
  const waterF = data.waterTemp?.f ?? null;
  const wetsuit = wetsuitCall(
    waterF,
    median(windowHoursToday.map((h) => h.airF)),
    median(windowHoursToday.map((h) => h.windKt)) ?? 0,
  );

  /**
   * Trim the payload. `buildDaily` keeps each day's full hour objects for its
   * own rollup, but shipping them duplicates the entire hourly array inside
   * `days` and blows the JSON up past a megabyte. The page regroups hours by
   * local date from the single `hourly` array instead.
   */
  const r = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x ?? null);
  const compactHour = (h) => ({
    time: h.time, localDate: h.localDate, localHour: r(h.localHour, 2), inWindow: h.inWindow,
    deepHsM: r(h.deepHsM, 3), deepHsFt: r(h.deepHsFt),
    faceFt: r(h.faceFt), faceSetFt: r(h.faceSetFt),
    sizeLabel: h.sizeLabel, setSizeLabel: h.setSizeLabel,
    periodS: r(h.periodS, 1), dirDeg: r(h.dirDeg, 0), dirCompass: h.dirCompass,
    powerKwPerM: r(h.powerKwPerM, 1), energyKjPerM2: r(h.energyKjPerM2, 1),
    windKt: r(h.windKt, 1), gustKt: r(h.gustKt, 1), windDirDeg: r(h.windDirDeg, 0),
    windCompass: h.windCompass, windLabel: h.windLabel,
    tideFt: r(h.tideFt), tideRate: r(h.tideRate),
    score: h.score, grade: h.grade, confidence: r(h.confidence),
    board: h.board.board,
    parts: { tide: r(h.parts.tide.score), wind: r(h.parts.wind.score), size: r(h.parts.size.score), shape: r(h.parts.shape.score) },
    modelSpread: { heightFt: h.modelSpread.heightFt.map((m) => ({ model: m.model, faceFt: r(m.faceFt) })) },
    // Swell trains in the water, for the nearshore simulation. Deep-water
    // height per train, so the simulation starts where the forecast started.
    // Deep-water swell trains at this hour. The nearshore direction MOP
    // publishes barely moves - refraction compresses everything toward
    // shore-normal - so the offshore direction is what tells you where the
    // swell is from and how it will hit.
    trains: (h.trains || []).map((p) => ({
      kind: p.kind, hsM: r(p.hsM, 2), hsFt: r(p.hsFt, 1),
      periodS: r(p.periodS, 1), dirDeg: r(p.dirDeg, 0), dirCompass: p.dirCompass,
    })),
    // Each swell class's SHARE of this hour's face height, in the fixed order
    // [south, W/NW, windswell]. These are shares of the real wave, not each
    // class's independent height, so they sum LINEARLY back to faceFt and a
    // stacked chart of them has the whole wave at the top of the stack.
    // (Independent heights would not: energies add, so two 2 ft swells make a
    // 2.8 ft wave and a stack of their own heights would claim 4 ft.)
    mixFt: h.mix
      ? MIX_ORDER.map((id) => r((h.mix.parts.find((q) => q.cls === id)?.share ?? 0) * (h.faceFt ?? 0), 2))
      : null,
    crossing: h.mix ? h.mix.crossing : null,
    chopFt: h.mix ? h.mix.chopFt : null,
    // How much bigger the sets are than the average wave, because the trains
    // coincide. 1.0 is a single clean swell; 1.4 is a properly crossed sea.
    superposition: h.mix ? h.mix.superposition : null,
    peel: h.peel ? {
      alphaDeg: h.peel.alphaDeg, speedMs: h.peel.speedMs,
      makeable: h.peel.makeable, closeoutRatio: h.peel.closeoutRatio,
    } : null,
    trainsFrom: h.trainsFrom || 'model',
  });
  const compactDays = days.map(({ hours, ...rest }) => rest);

  const payload = {
    meta: {
      generatedAt: startedAt,
      finishedAt: new Date().toISOString(),
      synthetic: SYNTHETIC,
      site: SITE,
      sessionWindow: SESSION_WINDOW,
      horizons: FORECAST_DAYS,
      calibration: {
        faceFactor: CALIBRATION.faceFactor,
        shelfLoss: CALIBRATION.shelfLoss,
        gammaBreak: CALIBRATION.gammaBreak,
        modelExposureStrength: CALIBRATION.modelExposureStrength,
      },
      sources: {
        buoy: data.buoy ? `CDIP/NDBC ${data.buoy.station} (${data.buoy.source})` : 'unavailable',
        tides: data.tides ? `NOAA CO-OPS ${SOURCES.tideStation} (La Jolla / Scripps Pier)` : 'unavailable',
        waveModels: data.marine.models,
        nearshore: data.transect ? `CDIP MOP ${mop.NORTH_LOT_LINE} +/- ${data.transect.lines.length - 1} lines` : 'unavailable',
        windModels: data.weather.models,
        surfline: SURFLINE_ENABLED ? 'enabled' : 'disabled by configuration',
      },
      errors,
      biasByModel,
    },
    current,
    buoyCheck,
    beach,
    nearshore,
    mopCheck,
    wetsuit,
    nowcast,
    days: compactDays,
    drift,
    skill,
    groundTruth,
    hourly: hourly
      .filter((h) => Date.parse(h.time) >= Date.now() - 12 * 36e5)
      .map(compactHour),
  };

  await mkdir(ARCHIVE, { recursive: true });
  await writeFile(path.join(DATA, 'forecast.json'), JSON.stringify(payload, null, 1));

  // A trimmed archive record: enough to measure drift and skill, small enough
  // that years of history stays a reasonable size in the repo.
  const stamp = startedAt.replace(/[:.]/g, '-');
  await writeFile(path.join(ARCHIVE, `${stamp}.json`), JSON.stringify({
    issued: startedAt,
    synthetic: SYNTHETIC,
    days: days.map((d) => ({
      date: d.date, windowScore: d.windowScore, faceMinFt: d.faceMinFt,
      faceMaxFt: d.faceMaxFt, periodS: d.periodS, dirDeg: d.dirDeg, windKt: d.windKt,
    })),
    hourly: hourly
      .filter((h) => Date.parse(h.time) >= Date.parse(startedAt))
      .map((h) => ({
        time: h.time, deepHsM: Math.round(h.deepHsM * 1000) / 1000,
        periodS: Math.round(h.periodS * 10) / 10,
        dirDeg: h.dirDeg == null ? null : Math.round(h.dirDeg),
        faceFt: Math.round(h.faceFt * 10) / 10, score: h.score,
        // The set height and the shape call have to live in the archive too.
        // Without them a logged session can only ever be graded on the typical
        // wave - and the typical wave is the part this model was already good
        // at. The set size is the part it got wrong by a factor of two, and
        // until now the permanent record had no way to prove it either way.
        faceSetFt: Math.round(h.faceSetFt * 10) / 10,
        makeable: h.peel ? h.peel.makeable : null,
      })),
  }));

  // Keep the archive bounded.
  const files = (await readdir(ARCHIVE)).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - MAX_ARCHIVE_FILES))) {
    await unlink(path.join(ARCHIVE, f));
  }

  await writeFile(path.join(DATA, 'diagnostics.json'), JSON.stringify({
    generatedAt: startedAt, synthetic: SYNTHETIC, errors, trace, biasByModel,
    // Hours each wave model actually contributed. A model far below the others
    // is abstaining rather than forecasting - that is how the GFS-Wave outage
    // was caught, and it would otherwise be invisible.
    modelHourCounts: buildHourly.lastModelHourCounts ?? {},
    counts: {
      buoyRecords: data.buoy?.records?.length ?? 0,
      spectrumBands: data.spectrum?.bands?.length ?? 0,
      tideSeries: data.tides?.series?.length ?? 0,
      hourly: hourly.length, days: days.length, archives: archives.length,
      mopLines: nearshore?.lines?.length ?? 0, mopFrames: nearshore?.times?.length ?? 0,
    },
  }, null, 1));

  log(`wrote ${days.length} days, ${hourly.length} hours`);
  log(`today: ${days[0]?.date} window ${days[0]?.windowScore} (${days[0]?.windowGrade}) - ${days[0]?.verdict}`);
  if (Object.keys(errors).length) log('non-fatal source errors:', errors);
}

main().catch((err) => {
  console.error('[tp-surfcast2] BUILD FAILED:', err);
  process.exit(1);
});
