/**
 * Assemble everything into an hourly forecast and a daily call.
 *
 * Three things here are what make this better than a generic regional forecast:
 *
 *  1. BUOY ANCHORING. Global wave models carry a persistent bias at any given
 *     spot. We measure that bias against the last day of CDIP 100p1 readings
 *     and correct each model before using it, instead of trusting raw output.
 *  2. LOCAL TRANSFORMATION. Every swell partition is refracted and shoaled onto
 *     this beach's orientation and slope, so a 290-degree swell and a 250-degree
 *     swell of the same height produce different surf, which they genuinely do.
 *  3. HONEST UNCERTAINTY. Models are kept separate and their disagreement is
 *     reported as confidence, rather than blended into a single false-precision
 *     number.
 */

import { SITE, SESSION_WINDOW, CALIBRATION, FORECAST_DAYS } from '../config.js';
import {
  transformToBreak, combinePartitions, faceHeights, sizeLabel,
  wavePowerKwPerM, energyDensityKjPerM2, iribarren, M_TO_FT, angleDiff,
} from './waves.js';
import { scoreHour, gradeFor, inSessionWindow } from './score.js';
import { tideAt, tideRateAt } from '../sources/tides.js';

/* ------------------------------------------------------------- utilities -- */

export function median(xs) {
  const a = xs.filter(Number.isFinite).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Vector mean of compass directions - a plain average of 350 and 10 gives 180. */
export function circMean(dirs) {
  const live = dirs.filter(Number.isFinite);
  if (!live.length) return null;
  let x = 0, y = 0;
  for (const d of live) {
    x += Math.cos((d * Math.PI) / 180);
    y += Math.sin((d * Math.PI) / 180);
  }
  if (x === 0 && y === 0) return null;
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Largest pairwise angular separation in a set of directions, degrees. */
function circSpread(dirs) {
  const live = dirs.filter(Number.isFinite);
  if (live.length < 2) return 0;
  const mean = circMean(live);
  return Math.max(...live.map((d) => Math.abs(angleDiff(d, mean))));
}

const DIR_NAMES = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (d) => (Number.isFinite(d) ? DIR_NAMES[Math.round((((d % 360) + 360) % 360) / 22.5) % 16] : '--');

/* ------------------------------------------------------- buoy anchoring -- */

/**
 * Measure each model's height bias against the buoy over the recent past and
 * return a multiplicative correction.
 *
 * Clamped to [0.72, 1.40]: a correction bigger than that is much more likely to
 * be a bad buoy record or a timing mismatch than a real model bias, and blindly
 * applying it would make the forecast worse, not better.
 */
export function computeModelBias(buoyRecords, modelHours, { hoursBack = 24 } = {}) {
  if (!buoyRecords?.length || !modelHours?.length) return { factor: 1, n: 0, note: 'no overlap available' };
  const cutoff = Date.now() - hoursBack * 36e5;
  const ratios = [];
  const byHour = new Map();
  for (const h of modelHours) byHour.set(new Date(h.time).setMinutes(0, 0, 0), h);

  for (const b of buoyRecords) {
    const t = Date.parse(b.time);
    if (!(t >= cutoff && t <= Date.now())) continue;
    const m = byHour.get(new Date(t).setMinutes(0, 0, 0));
    if (!m || !(m.hsM > 0.05) || !(b.hsM > 0.05)) continue;
    ratios.push(b.hsM / m.hsM);
  }
  const med = median(ratios);
  if (med == null) return { factor: 1, n: 0, note: 'no overlapping hours' };
  const factor = Math.max(0.72, Math.min(1.40, med));
  return {
    factor, n: ratios.length,
    raw: med,
    note: `buoy ran ${((med - 1) * 100).toFixed(0)}% ${med >= 1 ? 'above' : 'below'} this model over the last ${hoursBack} h (${ratios.length} matched hours)`,
  };
}

/* -------------------------------------------------- per-hour transform --- */

/**
 * Take one model hour's swell partitions through to breaking surf.
 */
function breakingForHour(h, bias) {
  const parts = [];
  const push = (p, kind) => {
    if (!p || !(p.hsM > 0.02)) return;
    // A partition that is missing its own period still counts: fall back to the
    // overall period for the hour. GFS-Wave publishes partition heights without
    // partition periods, and requiring both silently reduced that whole model to
    // zero on every hour.
    const T = p.periodS > 0 ? p.periodS : (h.periodS > 0 ? h.periodS : null);
    if (!T) return;
    const r = transformToBreak(p.hsM * bias, T, p.dirDeg ?? h.dirDeg, { origin: 'model' });
    if (r.Hb > 0) parts.push({ ...r, HbM: r.Hb, periodS: T, dirDeg: p.dirDeg ?? h.dirDeg, kind });
  };
  push(h.swell, 'groundswell');
  push(h.windSea, 'windswell');
  // If the model gave no partitions, fall back to the total sea state.
  if (!parts.length) push({ hsM: h.hsM, periodS: h.periodS, dirDeg: h.dirDeg }, 'total');

  // Nothing usable from this model this hour. Returning null keeps it OUT of
  // the ensemble entirely; returning a zero would let it vote, and a zero in a
  // three-model median drags the forecast down by a foot while looking like
  // genuine disagreement rather than missing data.
  if (!parts.length) return null;

  const combined = combinePartitions(parts);
  const dom = combined.dominant;
  return {
    HbM: combined.HbM,
    dominantPeriodS: dom?.periodS ?? h.periodS,
    dominantDirDeg: dom?.dirDeg ?? h.dirDeg,
    parts: combined.parts.map((p) => ({
      kind: p.kind, HbM: p.HbM, periodS: p.periodS, dirDeg: p.dirDeg,
      faceFt: faceHeights(p.HbM).typicalFt,
    })),
    deepHsM: h.hsM * bias,
  };
}

/* ----------------------------------------------------- hourly ensemble --- */

/**
 * Build the hourly forecast: ensemble the wave models, ensemble the wind
 * models, layer the tide on top, and score every hour.
 */
export function buildHourly({ marine, weather, tides, biasByModel }) {
  // Index wind by UTC hour.
  const windIndex = new Map();
  for (const [model, rows] of Object.entries(weather.byModel)) {
    for (const r of rows) {
      const key = new Date(r.time).setMinutes(0, 0, 0);
      if (!windIndex.has(key)) windIndex.set(key, { stamps: r, models: {} });
      windIndex.get(key).models[model] = r;
    }
  }

  // Index waves by UTC hour, per model.
  const waveIndex = new Map();
  const modelHourCounts = {};
  for (const [model, rows] of Object.entries(marine.byModel)) {
    const bias = biasByModel?.[model]?.factor ?? 1;
    modelHourCounts[model] = 0;
    for (const r of rows) {
      const broken = breakingForHour(r, bias);
      if (!broken) continue;              // model contributed nothing this hour
      const key = new Date(r.time).setMinutes(0, 0, 0);
      if (!waveIndex.has(key)) waveIndex.set(key, { stamps: r, models: {} });
      waveIndex.get(key).models[model] = { ...broken, raw: r };
      modelHourCounts[model]++;
    }
  }
  buildHourly.lastModelHourCounts = modelHourCounts;

  const hours = [];
  for (const [key, entry] of [...waveIndex.entries()].sort((a, b) => a[0] - b[0])) {
    const wind = windIndex.get(key);
    if (!wind) continue;
    const iso = new Date(key).toISOString();

    const modelNames = Object.keys(entry.models);
    if (!modelNames.length) continue;
    const HbList = modelNames.map((m) => entry.models[m].HbM);
    const HbM = median(HbList) ?? 0;
    const periodS = median(modelNames.map((m) => entry.models[m].dominantPeriodS)) ?? 0;
    const dirDeg = circMean(modelNames.map((m) => entry.models[m].dominantDirDeg));
    const deepHsM = median(modelNames.map((m) => entry.models[m].deepHsM)) ?? 0;

    // Model disagreement -> confidence, judged in FACE FEET rather than as a
    // percentage of the height.
    //
    // Scoring it relatively was wrong and the first week of live data proved
    // it: three models landing within two tenths of a foot of each other on a
    // knee-high day is near-perfect agreement, but as a fraction of a 1.2 ft
    // day it looks like a 20% spread, so every single day of a small week came
    // back flagged "models disagree". A flag that fires on every day carries no
    // information. Absolute spread is what a surfer actually cares about:
    // whether the models could be arguing about something that changes the call.
    const faceList = modelNames.map((m) => faceHeights(entry.models[m].HbM).typicalFt);
    const faceSpreadFt = Math.max(...faceList) - Math.min(...faceList);
    const meaningfulSpreadFt = Math.max(0, faceSpreadFt - 0.4); // under ~5 in is noise
    const dSpread = circSpread(modelNames.map((m) => entry.models[m].dominantDirDeg));
    const confidence = Math.max(0, Math.min(1, 1 - 0.35 * meaningfulSpreadFt - dSpread / 120));

    const windModels = Object.keys(wind.models);
    const windKt = median(windModels.map((m) => wind.models[m].windKt)) ?? 0;
    const gustKt = median(windModels.map((m) => wind.models[m].gustKt)) ?? null;
    const windDirDeg = circMean(windModels.map((m) => wind.models[m].windDirDeg)) ?? 0;
    const precipIn = median(windModels.map((m) => wind.models[m].precipIn)) ?? 0;
    const airF = median(windModels.map((m) => wind.models[m].airF));

    const tideFt = tides ? tideAt(tides, iso) : null;
    const tideRate = tides ? tideRateAt(tides, iso) : 0;

    const face = faceHeights(HbM);
    const powerKwPerM = wavePowerKwPerM(deepHsM, periodS);
    const scored = scoreHour({
      HbM,
      faceTypicalFt: face.typicalFt,
      faceSetFt: face.setFt,
      Tp: periodS,
      swellDirDeg: dirDeg ?? SITE.shoreNormalDeg,
      tideFt: tideFt ?? 2.0,
      tideRate,
      windKt,
      windDirDeg,
      powerKwPerM,
    });

    hours.push({
      time: iso,
      localDate: entry.stamps.localDate,
      localHour: entry.stamps.localHour,
      inWindow: inSessionWindow(entry.stamps.localHour),
      deepHsM,
      deepHsFt: deepHsM * M_TO_FT,
      HbM,
      faceFt: face.typicalFt,
      faceSetFt: face.setFt,
      sizeLabel: sizeLabel(face.typicalFt).label,
      setSizeLabel: sizeLabel(face.setFt).label,
      periodS,
      dirDeg,
      dirCompass: compass(dirDeg),
      powerKwPerM,
      energyKjPerM2: energyDensityKjPerM2(deepHsM),
      iribarren: iribarren(HbM, periodS),
      windKt, gustKt, windDirDeg, windCompass: compass(windDirDeg),
      windLabel: scored.parts.wind.label,
      precipIn, airF,
      tideFt, tideRate,
      score: scored.total,
      grade: scored.grade,
      board: scored.board,
      parts: scored.parts,
      partitions: entry.models[modelNames[0]]?.parts ?? [],
      confidence,
      modelSpread: {
        heightFt: modelNames.map((m, i) => ({ model: m, faceFt: faceList[i] })),
        faceSpreadFt,
        dirSpreadDeg: dSpread,
      },
    });
  }
  return hours;
}

/* --------------------------------------------------------- daily rollup -- */

const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/**
 * Collapse hours into a day, with the crew's 7:30-10:00 window front and centre.
 * The headline number is the window score, not the day's best - a perfect 4pm
 * is not useful if nobody is going to be there.
 */
export function buildDaily(hours, { weatherDaily = [], rainHistory = [] } = {}) {
  const byDate = new Map();
  for (const h of hours) {
    if (!byDate.has(h.localDate)) byDate.set(h.localDate, []);
    byDate.get(h.localDate).push(h);
  }

  const days = [];
  for (const [date, hs] of [...byDate.entries()].sort()) {
    const daylight = hs.filter((h) => h.localHour >= 6 && h.localHour <= 19);
    const win = hs.filter((h) => h.inWindow);
    const pool = win.length ? win : daylight.length ? daylight : hs;

    const best = pool.reduce((a, b) => (b.score > a.score ? b : a), pool[0]);
    const bestAnyTime = daylight.length
      ? daylight.reduce((a, b) => (b.score > a.score ? b : a), daylight[0]) : best;
    const windowScore = Math.round(win.length ? win.reduce((s, h) => s + h.score, 0) / win.length : best.score);

    const faces = pool.map((h) => h.faceFt);
    const sets = pool.map((h) => h.faceSetFt);
    const sun = weatherDaily.find((d) => d.localDate === date) || {};

    days.push({
      date,
      weekday: new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
      windowScore,
      windowGrade: gradeFor(windowScore / 100),
      score: best.score,
      grade: best.grade,
      confidence: round1(pool.reduce((s, h) => s + h.confidence, 0) / pool.length),
      faceMinFt: round1(Math.min(...faces)),
      faceMaxFt: round1(Math.max(...faces)),
      setMaxFt: round1(Math.max(...sets)),
      sizeLabel: sizeLabel(Math.max(...faces)).label,
      setSizeLabel: sizeLabel(Math.max(...sets)).label,
      periodS: round1(median(pool.map((h) => h.periodS))),
      dirDeg: round1(circMean(pool.map((h) => h.dirDeg))),
      dirCompass: compass(circMean(pool.map((h) => h.dirDeg))),
      powerKwPerM: round1(median(pool.map((h) => h.powerKwPerM))),
      windKt: round1(median(pool.map((h) => h.windKt))),
      windCompass: compass(circMean(pool.map((h) => h.windDirDeg))),
      windLabel: best.windLabel,
      tideAtWindowFt: round1(median(win.length ? win.map((h) => h.tideFt) : pool.map((h) => h.tideFt))),
      board: best.board,
      bestHour: { time: best.time, localHour: round1(best.localHour), score: best.score },
      bestHourAnyTime: { time: bestAnyTime.time, localHour: round1(bestAnyTime.localHour), score: bestAnyTime.score },
      betterOutsideWindow: bestAnyTime.score - best.score >= 12,
      sunrise: sun.sunrise ?? null,
      sunset: sun.sunset ?? null,
      water: waterQuality(date, rainHistory),
      hours: hs,
      verdict: '',
    });
  }

  for (const d of days) d.verdict = verdictFor(d);
  return days;
}

/**
 * Plain-language call for the day. Written the way you would actually text the
 * crew, and it leads with the thing that decides whether to go.
 */
function verdictFor(d) {
  // Within a 2.5-hour window the min and max are usually the same number;
  // printing "4-4 ft" reads like a bug, so collapse it.
  const size = Math.abs((d.faceMaxFt ?? 0) - (d.faceMinFt ?? 0)) < 0.35
    ? `${d.faceMaxFt} ft (${d.sizeLabel.toLowerCase()})`
    : `${d.faceMinFt}-${d.faceMaxFt} ft (${d.sizeLabel.toLowerCase()})`;
  const bits = [];

  if (d.water.advisory) {
    bits.push(`Rain advisory in effect - ${d.water.reason}`);
  }
  if (d.windowScore >= 72) bits.push(`Go. ${size}, ${d.dirCompass} at ${d.periodS}s, ${d.windLabel} ${d.windKt} kt in the window.`);
  else if (d.windowScore >= 56) bits.push(`Worth it. ${size}, ${d.windLabel} ${d.windKt} kt, tide ${d.tideAtWindowFt} ft.`);
  else if (d.windowScore >= 40) bits.push(`Marginal. ${size} but ${d.windLabel === 'onshore' ? 'the wind is on it' : 'it lacks punch'}.`);
  else bits.push(`Skip. ${size}, ${d.windLabel} ${d.windKt} kt.`);

  if (d.betterOutsideWindow) {
    const h = d.bestHourAnyTime.localHour;
    const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
    bits.push(`Note: it scores ${d.bestHourAnyTime.score} around ${hh}:${String(mm).padStart(2, '0')}, better than your 7:30-10 window.`);
  }
  if (d.confidence != null && d.confidence < 0.55) {
    bits.push('Models disagree on this day - treat it as provisional.');
  }
  if (d.setMaxFt >= 8) {
    bits.push(`Sets to ${d.setMaxFt} ft - real size, expect strong current along the beach.`);
  }
  return bits.join(' ');
}

/* -------------------------------------------------------- water quality -- */

/**
 * San Diego County advises staying out of the ocean for 72 hours after rain.
 * Los Penasquitos Lagoon empties at the north end of this beach, so the north
 * lot is the worst possible place to ignore that rule.
 */
export function waterQuality(localDate, rainHistory) {
  const { advisoryHours, triggerInches, lagoonOutletNote } = CALIBRATION.rain;
  const dayStart = Date.parse(`${localDate}T00:00:00Z`);
  let recent = 0;
  let lastWet = null;
  for (const r of rainHistory) {
    const t = Date.parse(r.time);
    if (t <= dayStart && t >= dayStart - advisoryHours * 36e5) {
      recent += r.precipIn || 0;
      if ((r.precipIn || 0) > 0.01) lastWet = r.time;
    }
  }
  const advisory = recent >= triggerInches;
  return {
    rain72hIn: Math.round(recent * 100) / 100,
    advisory,
    lastRain: lastWet,
    reason: advisory
      ? `${recent.toFixed(2)} in of rain in the last ${advisoryHours} h. ${lagoonOutletNote}`
      : `${recent.toFixed(2)} in in the last ${advisoryHours} h - below the ${triggerInches} in advisory threshold.`,
  };
}

/* ------------------------------------------------------------- wetsuit --- */

export function wetsuitCall(waterF, airF, windKt) {
  if (!Number.isFinite(waterF)) return { call: 'No water temp available', waterF: null };
  const base = CALIBRATION.wetsuit.find((w) => waterF >= w.minF);
  let call = base.call;
  // A cold, windy dawn makes a borderline temperature feel a full step colder.
  if (Number.isFinite(airF) && airF < waterF - 6 && windKt > 8 && waterF < 66) {
    call += ' - air is colder than the water and it is breezy, size up if you run cold';
  }
  return { call, waterF: Math.round(waterF * 10) / 10 };
}

/* ------------------------------------------------ run-to-run drift ------- */

/**
 * "What changed?" Compare this run's daily window scores and sizes against
 * previous archived runs. With Surfline out of the picture, this is the
 * comparison that actually matters: is the forecast for Saturday settling down,
 * or is it still moving?
 */
export function computeDrift(currentDays, archives) {
  const out = [];
  for (const day of currentDays) {
    const changes = [];
    for (const { ageHours, days } of archives) {
      const prev = days?.find((d) => d.date === day.date);
      if (!prev) continue;
      changes.push({
        ageHours,
        scoreDelta: day.windowScore - prev.windowScore,
        faceDeltaFt: round1((day.faceMaxFt ?? 0) - (prev.faceMaxFt ?? 0)),
        periodDeltaS: round1((day.periodS ?? 0) - (prev.periodS ?? 0)),
        prevScore: prev.windowScore,
      });
    }
    const worst = changes.reduce((a, c) => (Math.abs(c.scoreDelta) > Math.abs(a?.scoreDelta ?? 0) ? c : a), null);
    out.push({
      date: day.date,
      changes,
      headline: worst && Math.abs(worst.scoreDelta) >= 8
        ? `${worst.scoreDelta > 0 ? 'Upgraded' : 'Downgraded'} ${Math.abs(worst.scoreDelta)} pts vs ${worst.ageHours} h ago (${worst.prevScore} -> ${day.windowScore})${Math.abs(worst.faceDeltaFt) >= 0.5 ? `, size ${worst.faceDeltaFt > 0 ? '+' : ''}${worst.faceDeltaFt} ft` : ''}`
        : changes.length ? 'Steady - no meaningful change since the last runs' : 'No prior run to compare',
      stable: !worst || Math.abs(worst.scoreDelta) < 8,
    });
  }
  return out;
}

export const HORIZONS = FORECAST_DAYS;
export { SESSION_WINDOW };
