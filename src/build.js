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
import { callFor, reliabilityFor } from './model/score.js';
import { M_TO_FT, wavePowerKwPerM, transformToBreak, faceHeights, sizeLabel } from './model/waves.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(__dirname, '..', 'docs');
const DATA = path.join(DOCS, 'data');
const ARCHIVE = path.join(DATA, 'archive');
const SYNTHETIC = process.argv.includes('--synthetic');
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
    faceSetFt: face.setFt,
    sizeLabel: sizeLabel(face.typicalFt).label,
    setSizeLabel: sizeLabel(face.setFt).label,
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

  const allDays = buildDaily(hourly, { weatherDaily: data.weather.daily, rainHistory });
  const todayLocal = hourly.find((h) => Date.parse(h.time) >= Date.now() - 36e5)?.localDate
    ?? allDays[0]?.date;
  const days = allDays.filter((d) => d.date >= todayLocal).slice(0, FORECAST_DAYS.outlook);

  // What each day's swell is MADE of, and the one-word call. Computed here
  // rather than in the page so the browser never has to run wave physics to
  // render a headline.
  // Hourly mixes first, then smoothed, so the daily rollup and the chart are
  // built from exactly the same numbers.
  for (const h of hourly) h.mix = mixForHour(h);
  smoothShares(hourly);

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
  const nowcast = data.buoy ? nowcastCheck(hourly, data.buoy.records) : null;
  const current = buildCurrent(data.buoy, data.spectrum, data.ndbcSpec, data.tides);

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
  const trainsByTime = data.trains || null;
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
    trains: (trainsByTime?.get(h.time) || []).slice(0, 4).map((p) => ({
      kind: p.kind, hsM: r(p.hsM, 2), hsFt: r(p.hsM * M_TO_FT, 1),
      periodS: r(p.periodS, 1), dirDeg: r(p.dirDeg, 0),
      dirCompass: compass(p.dirDeg),
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
    beach,
    nearshore,
    mopCheck,
    wetsuit,
    nowcast,
    days: compactDays,
    drift,
    skill,
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
