/**
 * The alongshore picture: what every 100 m of this beach is doing, hour by hour.
 *
 * Each CDIP MOP line publishes height, period and direction at its own depth,
 * refracted over surveyed bathymetry, plus its own latitude, longitude and
 * shore normal. Carrying each line the last step to breaking and scoring it
 * against the same tide and wind gives the thing a single spot forecast cannot:
 * WHERE along the beach it is worth paddling out today.
 */

import { transformFromDepth, faceHeights, sizeLabel, wavePowerKwPerM, M_TO_FT } from './waves.js';
import { scoreHour } from './score.js';
import { compass } from './forecast.js';

const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const r0 = (x) => (Number.isFinite(x) ? Math.round(x) : null);

/**
 * Sampling times: hourly while it matters, thinning out further ahead. Keeps
 * the payload small enough to ship without losing the detail you would act on.
 */
export function sampleTimes(hourly, { denseHours = 48, totalDays = 7 } = {}) {
  const now = Date.now();
  const end = now + totalDays * 864e5;
  const out = [];
  for (const h of hourly) {
    const t = Date.parse(h.time);
    if (t < now - 36e5 || t > end) continue;
    const ahead = (t - now) / 36e5;
    if (ahead <= denseHours || new Date(t).getUTCHours() % 3 === 0) out.push(h);
  }
  return out;
}

/**
 * @param {object} transect  from sources/mop.js
 * @param {Array}  hourly    the main hourly forecast, for tide and wind
 */
export function buildNearshore(transect, hourly) {
  if (!transect?.lines?.length || !hourly?.length) return null;

  const frames = sampleTimes(hourly);
  if (!frames.length) return null;
  const frameAt = new Map();
  frames.forEach((h) => frameAt.set(new Date(h.time).setMinutes(0, 0, 0), h));

  const lines = transect.lines.map((line) => {
    const byHour = new Map();
    for (const rec of line.records) {
      byHour.set(new Date(rec.time).setMinutes(0, 0, 0), rec);
    }

    const faceFt = [], setFt = [], score = [], dirDeg = [], periodS = [];
    for (const f of frames) {
      const key = new Date(f.time).setMinutes(0, 0, 0);
      const rec = byHour.get(key);
      if (!rec || !(rec.hsM > 0) || !(rec.periodS > 0)) {
        faceFt.push(null); setFt.push(null); score.push(null);
        dirDeg.push(null); periodS.push(null);
        continue;
      }
      const br = transformFromDepth(rec.hsM, rec.periodS, rec.dirDeg ?? line.shoreNormalDeg,
        line.depthM, { shoreNormal: line.shoreNormalDeg });
      const face = faceHeights(br.Hb);
      const scored = scoreHour({
        HbM: br.Hb,
        faceTypicalFt: face.typicalFt,
        faceSetFt: face.setFt,
        Tp: rec.periodS,
        swellDirDeg: rec.dirDeg ?? line.shoreNormalDeg,
        tideFt: f.tideFt ?? 2,
        tideRate: f.tideRate ?? 0,
        windKt: f.windKt ?? 0,
        windDirDeg: f.windDirDeg ?? 0,
        powerKwPerM: wavePowerKwPerM(rec.hsM, rec.periodS),
      });
      faceFt.push(r1(face.typicalFt));
      setFt.push(r1(face.setFt));
      score.push(scored.total);
      dirDeg.push(r0(rec.dirDeg));
      periodS.push(r1(rec.periodS));
    }

    return {
      id: line.id,
      lat: line.lat, lon: line.lon,
      depthM: r1(line.depthM),
      shoreNormalDeg: r0(line.shoreNormalDeg),
      faceFt, setFt, score, dirDeg, periodS,
    };
  });

  // The best stretch of beach, per frame: which line is scoring highest.
  const best = frames.map((_, i) => {
    let bestLine = null, bestScore = -1;
    for (const l of lines) {
      const s = l.score[i];
      if (s != null && s > bestScore) { bestScore = s; bestLine = l; }
    }
    return bestLine ? { id: bestLine.id, score: bestScore, lat: bestLine.lat, lon: bestLine.lon } : null;
  });

  const home = lines.find((l) => l.id === transect.home?.id) || lines[Math.floor(lines.length / 2)];

  return {
    source: 'CDIP MOP alongshore (Scripps), refracted over surveyed bathymetry',
    kind: transect.kind,
    homeLine: home?.id ?? null,
    meanShoreNormalDeg: r0(transect.meanShoreNormalDeg),
    lineErrors: transect.errors || {},
    times: frames.map((f) => f.time),
    localHours: frames.map((f) => r1(f.localHour)),
    lines,
    best,
  };
}

/**
 * How far the new nearshore source sits from what the global-model pipeline
 * already said, at the north lot. Printed on every run: if these two diverge,
 * one of them is wrong and it should be visible rather than averaged away.
 */
export function compareAtHome(nearshore, hourly) {
  if (!nearshore) return null;
  const home = nearshore.lines.find((l) => l.id === nearshore.homeLine);
  if (!home) return null;
  const diffs = [];
  nearshore.times.forEach((t, i) => {
    const mine = hourly.find((h) => h.time === t);
    if (!mine || home.faceFt[i] == null) return;
    diffs.push({ t, mop: home.faceFt[i], models: r1(mine.faceFt) });
  });
  if (!diffs.length) return null;
  const err = diffs.map((d) => d.mop - d.models);
  const mean = err.reduce((a, b) => a + b, 0) / err.length;
  const mae = err.reduce((a, b) => a + Math.abs(b), 0) / err.length;
  return {
    n: diffs.length,
    meanDiffFt: r1(mean),
    maeFt: r1(mae),
    note: `MOP reads ${Math.abs(mean) < 0.15 ? 'about the same as' : mean > 0 ? 'bigger than' : 'smaller than'} the global-model pipeline at the north lot (mean ${mean >= 0 ? '+' : ''}${r1(mean)} ft over ${diffs.length} hours).`,
    sample: diffs.slice(0, 6),
  };
}
