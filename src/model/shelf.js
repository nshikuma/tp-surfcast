/**
 * What the shelf does to a swell, measured rather than assumed.
 *
 * Two CDIP buoys straddle the transformation: 100p1 sits in 550 m about eight
 * miles out, 153p1 (Del Mar Nearshore) sits in 17 m. Both are behind the same
 * islands, so sheltering cancels between them and what is left is exactly the
 * step this model has always had to compute rather than observe - refraction,
 * shoaling and dissipation across the shelf.
 *
 * THE COMPARISON HAS TO BE BAND BY BAND. Bulk height, period and direction are
 * useless here: when the outer buoy peaks on an 18 s south swell, the nearshore
 * buoy often peaks on a 9 s west windswell, because the south has lost so much
 * on the way in that it is no longer the largest thing in the spectrum.
 * Differencing the peak directions then reports a 90-degree "turn" that is just
 * the peak jumping trains. Both stations publish a 64-band directional
 * spectrum, so each frequency is compared with itself.
 *
 * WHAT THE FIRST SNAPSHOT SAID. Direction: every south band, arriving anywhere
 * from 187 to 222 degrees offshore, converged to about 240 degrees at Del Mar,
 * and the Snell prediction tracked it to within 4-8 degrees. The refraction
 * geometry is sound. Amplitude: long-period south measured 0.41-0.47 of its
 * offshore height against a predicted 0.51-0.55, which is close; but 8-9 s
 * windswell measured 0.41-0.47 against a predicted 0.91. The model thinks
 * windswell crosses the shelf almost untouched and the buoys say it loses more
 * than half its height.
 *
 * That is one thirty-minute record, which is nowhere near enough to retune
 * anything on - short-period windswell is also broadly spread in direction and
 * genuinely variable over the 3 km between the two stations, and a single
 * snapshot cannot separate those from a real modelling error. So this module
 * MEASURES and ACCUMULATES and does not correct. The correction comes later,
 * out of a sample big enough to mean something.
 */

import { wavelengthAt, groupVelocity, deepWavelength, angleDiff } from './waves.js';
import { SITE } from '../config.js';

/** Del Mar Nearshore, from the station's own metadata. */
export const NEARSHORE = { station: '153p1', depthM: 17, lat: 32.95654, lon: -117.27956 };

/** Bands are coarse on purpose: fine bins would take years to fill. */
export const PERIOD_BANDS = [
  { id: 'chop', lo: 3, hi: 7, label: 'Chop, under 7s' },
  { id: 'windswell', lo: 7, hi: 10, label: 'Windswell, 7-10s' },
  { id: 'mid', lo: 10, hi: 13, label: 'Mid, 10-13s' },
  { id: 'ground', lo: 13, hi: 16, label: 'Groundswell, 13-16s' },
  { id: 'long', lo: 16, hi: 26, label: 'Long-period, 16s+' },
];

export const DIR_BANDS = [
  { id: 'S', lo: 160, hi: 200, label: 'S' },
  { id: 'SSW', lo: 200, hi: 225, label: 'SSW' },
  { id: 'SW', lo: 225, hi: 250, label: 'SW' },
  { id: 'W', lo: 250, hi: 275, label: 'W' },
  { id: 'WNW', lo: 275, hi: 300, label: 'WNW' },
  { id: 'NW', lo: 300, hi: 340, label: 'NW' },
];

const bandFor = (bands, v) => bands.find((b) => v >= b.lo && v < b.hi) || null;

/**
 * Snell refraction plus shoaling from deep water to a given depth, for one
 * frequency. This is the model's own prediction, isolated so it can be put
 * side by side with what the two buoys actually measured.
 */
export function propagateToDepth(periodS, dirDeg, depthM, shoreNormalDeg = SITE.shoreNormalDeg) {
  if (!(periodS > 0) || !Number.isFinite(dirDeg) || !(depthM > 0)) return null;
  const L0 = deepWavelength(periodS);
  const c0 = L0 / periodS;
  const cg0 = groupVelocity(periodS, 4000);
  const L1 = wavelengthAt(periodS, depthM);
  const c1 = L1 / periodS;
  const cg1 = groupVelocity(periodS, depthM);
  if (!(cg1 > 0) || !(c0 > 0)) return null;

  const off0 = angleDiff(dirDeg, shoreNormalDeg);
  const a0 = Math.abs(off0) * Math.PI / 180;
  const sinA1 = Math.min(0.999, (c1 / c0) * Math.sin(a0));
  const a1 = Math.asin(sinA1);
  const sign = off0 < 0 ? -1 : 1;

  const Ks = Math.sqrt(cg0 / cg1);
  const Kr = Math.sqrt(Math.cos(a0) / Math.cos(a1));
  if (!Number.isFinite(Ks) || !Number.isFinite(Kr)) return null;

  return {
    Ks, Kr,
    heightRatio: Ks * Kr,
    offDeg0: off0,
    offDeg1: sign * (a1 * 180 / Math.PI),
    predictedDirDeg: (shoreNormalDeg + sign * (a1 * 180 / Math.PI) + 360) % 360,
  };
}

/**
 * One observation: two spectra taken at about the same moment, compared band by
 * band. Returns a row per usable frequency plus a rollup by period band.
 *
 * @param {{time:string, bands:Array}} outerSpec   100p1
 * @param {{time:string, bands:Array}} nearSpec    153p1
 */
export function compareSpectra(outerSpec, nearSpec, { depthM = NEARSHORE.depthM, minEnergy = 0.05 } = {}) {
  if (!outerSpec?.bands?.length || !nearSpec?.bands?.length) return null;

  // The two stations must be reporting the same moment and the same grid, or
  // the comparison is between different things.
  const apartMin = Math.abs(Date.parse(outerSpec.time) - Date.parse(nearSpec.time)) / 60000;
  if (!(apartMin <= 45)) {
    return { usable: false, reason: `observations ${Math.round(apartMin)} min apart`, apartMin };
  }
  const near = new Map(nearSpec.bands.map((b) => [b.freqHz.toFixed(5), b]));

  const rows = [];
  for (const o of outerSpec.bands) {
    const n = near.get(o.freqHz.toFixed(5));
    if (!n) continue;
    // Low-energy bands are mostly noise, and a ratio of two small numbers is
    // the noisiest thing there is.
    if (!(o.energy > minEnergy) || !(n.energy >= 0)) continue;
    if (!Number.isFinite(o.dirDeg)) continue;
    const pred = propagateToDepth(o.periodS, o.dirDeg, depthM);
    if (!pred || !(pred.heightRatio > 0)) continue;

    const measuredH = Math.sqrt(n.energy / o.energy);
    rows.push({
      periodS: o.periodS,
      dirOuterDeg: o.dirDeg,
      dirNearDeg: Number.isFinite(n.dirDeg) ? n.dirDeg : null,
      energyOuter: o.energy,
      measuredHeightRatio: measuredH,
      predictedHeightRatio: pred.heightRatio,
      residual: measuredH / pred.heightRatio,
      predictedDirDeg: pred.predictedDirDeg,
      dirErrorDeg: Number.isFinite(n.dirDeg) ? angleDiff(n.dirDeg, pred.predictedDirDeg) : null,
      Kr: pred.Kr, Ks: pred.Ks,
    });
  }
  if (!rows.length) return { usable: false, reason: 'no bands carried enough energy to compare' };

  return {
    usable: true,
    time: outerSpec.time,
    apartMin,
    rows,
    byPeriod: rollup(rows),
  };
}

function rollup(rows) {
  const out = {};
  for (const pb of PERIOD_BANDS) {
    const inBand = rows.filter((r) => r.periodS >= pb.lo && r.periodS < pb.hi);
    if (!inBand.length) continue;
    // Energy-weighted: a band carrying a tenth of a square metre should not
    // count the same as the one carrying the swell.
    const w = inBand.reduce((s, r) => s + r.energyOuter, 0);
    if (!(w > 0)) continue;
    const dirRows = inBand.filter((r) => r.dirErrorDeg != null);
    const dirW = dirRows.reduce((s, r) => s + r.energyOuter, 0);
    out[pb.id] = {
      n: inBand.length,
      energy: w,
      measuredHeightRatio: inBand.reduce((s, r) => s + r.measuredHeightRatio * r.energyOuter, 0) / w,
      predictedHeightRatio: inBand.reduce((s, r) => s + r.predictedHeightRatio * r.energyOuter, 0) / w,
      residual: inBand.reduce((s, r) => s + r.residual * r.energyOuter, 0) / w,
      dirErrorDeg: dirW > 0 ? dirRows.reduce((s, r) => s + r.dirErrorDeg * r.energyOuter, 0) / dirW : null,
    };
  }
  return out;
}

/* ------------------------------------------------------------ accumulate -- */

/**
 * Fold one observation into the running record.
 *
 * Kept as energy-weighted sums rather than a list of observations: the file has
 * to stay small enough to live in the repository for years, and the statistic
 * that matters is the weighted mean and its spread.
 *
 * Bins are period band CROSSED with the direction the swell arrived from,
 * because the two are not separable here - a south swell is both long-period
 * and very oblique, and it is the combination that decides how much survives.
 */
export function accumulate(prev, observation) {
  const state = {
    version: 1,
    observations: prev?.observations ?? 0,
    firstAt: prev?.firstAt ?? null,
    lastAt: prev?.lastAt ?? null,
    bins: { ...(prev?.bins || {}) },
  };
  if (!observation?.usable) return state;

  for (const r of observation.rows) {
    const pb = bandFor(PERIOD_BANDS, r.periodS);
    const db = bandFor(DIR_BANDS, r.dirOuterDeg);
    if (!pb || !db) continue;
    const key = `${pb.id}|${db.id}`;
    const b = state.bins[key] || {
      periodBand: pb.id, dirBand: db.id,
      n: 0, weight: 0,
      sumResidual: 0, sumResidualSq: 0,
      sumMeasured: 0, sumPredicted: 0,
      sumDirError: 0, dirWeight: 0,
    };
    const w = r.energyOuter;
    b.n += 1;
    b.weight += w;
    b.sumResidual += r.residual * w;
    b.sumResidualSq += r.residual * r.residual * w;
    b.sumMeasured += r.measuredHeightRatio * w;
    b.sumPredicted += r.predictedHeightRatio * w;
    if (r.dirErrorDeg != null) { b.sumDirError += r.dirErrorDeg * w; b.dirWeight += w; }
    state.bins[key] = b;
  }

  state.observations += 1;
  state.firstAt = state.firstAt || observation.time;
  state.lastAt = observation.time;
  return state;
}

/** Turn the running sums into the numbers a person reads. */
export function summarise(state) {
  const bins = Object.values(state?.bins || {})
    .filter((b) => b.weight > 0)
    .map((b) => {
      const mean = b.sumResidual / b.weight;
      const varr = Math.max(0, b.sumResidualSq / b.weight - mean * mean);
      return {
        periodBand: b.periodBand,
        dirBand: b.dirBand,
        n: b.n,
        measuredHeightRatio: round2(b.sumMeasured / b.weight),
        predictedHeightRatio: round2(b.sumPredicted / b.weight),
        residual: round2(mean),
        residualSd: round2(Math.sqrt(varr)),
        dirErrorDeg: b.dirWeight > 0 ? Math.round(b.sumDirError / b.dirWeight) : null,
        // Enough samples to say something. Deliberately conservative: this
        // number is going to be used to argue with a wave model.
        settled: b.n >= 200,
      };
    })
    .sort((a, b) => (a.periodBand + a.dirBand).localeCompare(b.periodBand + b.dirBand));

  const settled = bins.filter((b) => b.settled).length;
  return {
    observations: state?.observations ?? 0,
    firstAt: state?.firstAt ?? null,
    lastAt: state?.lastAt ?? null,
    bins,
    settledBins: settled,
    note: settled === 0
      ? 'Still collecting. Nothing here is being applied to the forecast yet - a bin needs 200 band-samples before it is allowed to argue with the physics.'
      : `${settled} bin${settled === 1 ? '' : 's'} have enough samples to be worth acting on.`,
  };
}

const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
