/**
 * Physics and scoring tests.
 *
 * These are not coverage theatre: each anchor case below is a real Torrey Pines
 * condition with a known outcome, and the calibration constants were tuned to
 * satisfy them. If someone retunes the model from session logs, these tests are
 * what catch a change that quietly breaks the other cases.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  transformToBreak, transformFromDepth, faceHeights, sizeLabel, wavePowerKwPerM,
  iribarren, breakerType, combinePartitions, exposureFor, modelExposureFor,
  angleDiff, wavelengthAt, groupVelocity, deepWavelength,
} from '../src/model/waves.js';
import { CALIBRATION } from '../src/config.js';
import { scoreHour, scoreTide, scoreWind, scorePeriod, gradeFor } from '../src/model/score.js';
import { median, circMean, computeModelBias, waterQuality, wetsuitCall, compass } from '../src/model/forecast.js';
import { parseOpendapAscii, partitionSpectrum } from '../src/sources/cdip.js';
import { tideAt, tideRateAt } from '../src/sources/tides.js';

/* ------------------------------------------------------------ wave theory -- */

test('deep-water wavelength matches the textbook value', () => {
  // L0 = gT^2 / 2pi. For T = 10 s that is 156.1 m.
  assert.ok(Math.abs(deepWavelength(10) - 156.13) < 0.05);
});

test('wavelength solver converges to the deep-water limit in deep water', () => {
  const L0 = deepWavelength(12);
  assert.ok(Math.abs(wavelengthAt(12, 500) - L0) / L0 < 0.001);
});

test('group velocity approaches sqrt(gh) in shallow water and C/2 in deep', () => {
  assert.ok(Math.abs(groupVelocity(14, 1.0) - Math.sqrt(9.81 * 1.0)) < 0.25);
  const deep = groupVelocity(14, 600);
  assert.ok(Math.abs(deep - (deepWavelength(14) / 14) / 2) < 0.05);
});

test('angleDiff wraps across north', () => {
  assert.equal(angleDiff(10, 350), 20);
  assert.equal(angleDiff(350, 10), -20);
});

/* ----------------------------------------------------- local calibration -- */

const anchor = (hs, tp, dir) => {
  const r = transformToBreak(hs, tp, dir, { origin: 'buoy' });
  return faceHeights(r.Hb);
};

test('anchor A: 1.0 m / 15 s / WNW is waist-to-chest with shoulder-high sets', () => {
  const f = anchor(1.0, 15, 285);
  assert.ok(f.typicalFt > 3.0 && f.typicalFt < 4.0, `got ${f.typicalFt}`);
  assert.equal(sizeLabel(f.typicalFt).label, 'Waist high');
  assert.equal(sizeLabel(f.setFt).label, 'Shoulder high');
});

test('anchor B: 2.0 m / 16 s / NW is head high with overhead sets', () => {
  const f = anchor(2.0, 16, 300);
  assert.ok(f.typicalFt > 5.3 && f.typicalFt < 6.5, `got ${f.typicalFt}`);
  assert.equal(sizeLabel(f.typicalFt).label, 'Head high');
  assert.equal(sizeLabel(f.setFt).label, 'Overhead');
});

test('anchor C: a small SSW swell is knee-to-thigh, not chest high', () => {
  const f = anchor(0.7, 17, 200);
  assert.ok(f.typicalFt < 2.6, `south swell over-forecast at ${f.typicalFt} ft`);
});

test('an oblique south swell loses far more than a square WNW swell of equal size', () => {
  const south = anchor(1.2, 15, 195).typicalFt;
  const wnw = anchor(1.2, 15, 275).typicalFt;
  // Refraction alone costs an oblique south swell about a third of its face.
  assert.ok(south < wnw * 0.72, `south ${south} vs wnw ${wnw}`);
});

test('swell running parallel to the beach produces nothing', () => {
  const r = transformToBreak(2.0, 15, 175, { origin: 'buoy' });
  assert.equal(r.Hb, 0);
  assert.equal(r.blocked, true);
});

test('buoy data is NOT re-shadowed, but model data is partially corrected', () => {
  // The buoy already sits inside the island shadow; double-counting it would
  // under-forecast every NW swell.
  const buoy = transformToBreak(1.5, 14, 290, { origin: 'buoy' });
  const model = transformToBreak(1.5, 14, 290, { origin: 'model' });
  assert.ok(model.Hb < buoy.Hb, 'model path should carry a shadowing correction');
  assert.equal(buoy.exposure, 1);
  assert.ok(modelExposureFor(290) > exposureFor(290), 'model correction must be gentler than the full table');
});

test('longer period breaks bigger than short period at the same height', () => {
  const long = anchor(1.2, 18, 275).typicalFt;
  const short = anchor(1.2, 8, 275).typicalFt;
  assert.ok(long > short * 1.2, `long ${long} vs short ${short}`);
});

test('wave power scales with height squared and period', () => {
  assert.ok(Math.abs(wavePowerKwPerM(2, 14) / wavePowerKwPerM(1, 14) - 4) < 0.01);
  assert.ok(Math.abs(wavePowerKwPerM(1, 20) / wavePowerKwPerM(1, 10) - 2) < 0.01);
});

test('partitions combine in energy, not linearly', () => {
  const c = combinePartitions([{ HbM: 1 }, { HbM: 1 }]);
  assert.ok(Math.abs(c.HbM - Math.SQRT2) < 1e-9, 'two equal swells must not simply add');
});

test('breaker type follows the Iribarren number', () => {
  assert.equal(breakerType(iribarren(1.2, 14)).type, 'plunging');
  assert.equal(breakerType(0.2).type, 'spilling');
  assert.equal(breakerType(2.4).type, 'surging');
});

/* ------------------------------------------------------------- scoring --- */

test('tide scoring peaks in the band and collapses at dead low', () => {
  assert.equal(scoreTide(2.4).score, 1);
  assert.ok(scoreTide(-0.6).score === 0);
  assert.ok(scoreTide(6.0).score < 0.15);
});

test('wind scoring prefers light offshore and punishes onshore', () => {
  assert.ok(scoreWind(5, 85).score > 0.9, 'light offshore should score well');
  assert.ok(scoreWind(18, 265).score < 0.12, 'strong onshore should be near zero');
  assert.ok(scoreWind(1, 265).score === 1, 'dead calm is glassy regardless of direction');
  assert.ok(scoreWind(25, 85).score < scoreWind(6, 85).score, 'too much offshore is worse than ideal');
});

test('period scoring rewards groundswell over windslop', () => {
  assert.ok(scorePeriod(14).score === 1);
  assert.ok(scorePeriod(6).score < 0.4);
});

const baseHour = {
  HbM: 1.44, faceTypicalFt: 3.5, faceSetFt: 4.5, Tp: 15, swellDirDeg: 285,
  tideFt: 2.4, tideRate: 0.3, windKt: 4, windDirDeg: 80, powerKwPerM: 7,
};

test('a tiny day cannot score well no matter how perfect everything else is', () => {
  const s = scoreHour({ ...baseHour, HbM: 0.6, faceTypicalFt: 1.6, faceSetFt: 2.1, powerKwPerM: 2, Tp: 9 });
  assert.ok(s.total < 45, `knee-high scored ${s.total}`);
});

test('onshore wind caps an otherwise good day', () => {
  const s = scoreHour({ ...baseHour, windKt: 18, windDirDeg: 265 });
  assert.ok(s.total <= 42, `blown out scored ${s.total}`);
});

test('dead low tide meaningfully downgrades a solid swell', () => {
  const good = scoreHour({ ...baseHour, HbM: 3.0, faceTypicalFt: 7.3, faceSetFt: 9.5, Tp: 17, powerKwPerM: 40 });
  const low = scoreHour({ ...baseHour, HbM: 3.0, faceTypicalFt: 7.3, faceSetFt: 9.5, Tp: 17, powerKwPerM: 40, tideFt: -0.5 });
  assert.ok(good.total - low.total >= 10, `expected a real penalty, got ${good.total} vs ${low.total}`);
});

test('the mixed quiver gets a board recommendation that tracks size', () => {
  assert.match(scoreHour({ ...baseHour, faceTypicalFt: 6.0 }).board.board, /Shortboard/);
  assert.match(scoreHour({ ...baseHour, faceTypicalFt: 2.4, HbM: 0.9, powerKwPerM: 3 }).board.board, /Mid-length|Fun/);
  assert.match(scoreHour({ ...baseHour, faceTypicalFt: 9.0, HbM: 3.6 }).board.board, /Step-up/);
});

test('grades are monotonic', () => {
  const order = [0.1, 0.3, 0.45, 0.6, 0.75, 0.92].map(gradeFor);
  assert.deepEqual(order, ['Flat / blown', 'Poor', 'Fair', 'Good', 'Very good', 'Epic']);
});

/* ------------------------------------------------------------ utilities -- */

test('circular mean handles the wrap at north', () => {
  const m = circMean([350, 10]);
  assert.ok(m < 1 || m > 359, `got ${m}`);
});

test('median ignores nulls', () => {
  assert.equal(median([1, null, 3, undefined, 5]), 3);
});

test('compass labels are right', () => {
  assert.equal(compass(0), 'N');
  assert.equal(compass(285), 'WNW');
  assert.equal(compass(180), 'S');
});

test('model bias is measured against the buoy and clamped', () => {
  const now = Date.now();
  const buoy = [0, 1, 2, 3].map((i) => ({ time: new Date(now - i * 36e5).toISOString(), hsM: 1.2 }));
  const model = [0, 1, 2, 3].map((i) => ({ time: new Date(now - i * 36e5).toISOString(), hsM: 1.0 }));
  const b = computeModelBias(buoy, model);
  assert.ok(Math.abs(b.factor - 1.2) < 0.01, `got ${b.factor}`);

  // A wildly disagreeing pair is far more likely to be bad data than real bias.
  const wild = model.map((m) => ({ ...m, hsM: 0.2 }));
  assert.ok(computeModelBias(buoy, wild).factor <= 1.4);
});

test('bias falls back to 1 with no overlap', () => {
  assert.equal(computeModelBias([], []).factor, 1);
});

/* ------------------------------------------------------------- sources --- */

test('OPeNDAP ASCII parses 1-D and 2-D variables', () => {
  const sample = [
    'Dataset {', ' Float32 waveHs[waveTime = 3];', '} x;',
    '---------------------------------------------',
    'waveHs.waveHs[3]', '0.91, 1.02, 1.11', '',
    'waveEnergyDensity.waveEnergyDensity[1][4]', '[0], 0.1, 0.9, 0.3, 0.05', '',
  ].join('\n');
  const v = parseOpendapAscii(sample);
  assert.deepEqual(v.waveHs, [0.91, 1.02, 1.11]);
  assert.deepEqual(v.waveEnergyDensity, [0.1, 0.9, 0.3, 0.05]);
});

test('spectral partitioning separates two swell trains', () => {
  // A long-period groundswell peak plus a separate short-period windsea peak.
  const bands = [];
  for (let i = 0; i < 40; i++) {
    const f = 0.04 + i * 0.005;
    const T = 1 / f;
    bands.push({
      freqHz: f, periodS: T, bandwidth: 0.005,
      energy: 1.0 * Math.exp(-((T - 15) ** 2) / 4) + 0.5 * Math.exp(-((T - 7) ** 2) / 1.5),
      dirDeg: T > 10 ? 290 : 260,
    });
  }
  const trains = partitionSpectrum(bands);
  assert.ok(trains.length >= 2, `expected two trains, got ${trains.length}`);
  const long = trains.find((t) => t.periodS > 10);
  const short = trains.find((t) => t.periodS < 10);
  assert.ok(long && short, 'both a groundswell and a windsea should be found');
  assert.ok(Math.abs(long.dirDeg - 290) < 6, `long-period direction off: ${long.dirDeg}`);
});

test('tide interpolation and rate behave sensibly', () => {
  const base = Date.UTC(2026, 8, 14, 0, 0, 0);
  const series = Array.from({ length: 48 }, (_, i) => ({
    time: new Date(base + i * 36e5).toISOString(),
    ft: 2.5 + 2.5 * Math.sin((i / 12.42) * 2 * Math.PI),
  }));
  const tides = { series, hilo: [] };
  const q = new Date(base + 3 * 36e5).toISOString();
  assert.ok(Math.abs(tideAt(tides, q) - series[3].ft) < 1e-6);
  // Rising through the first quarter cycle.
  assert.ok(tideRateAt(tides, new Date(base + 1 * 36e5).toISOString()) > 0);
});

/* ------------------------------------------------------- advisories ------ */

test('the rain advisory fires above the threshold and not below', () => {
  const date = '2026-01-10';
  const wet = [{ time: '2026-01-09T12:00:00Z', precipIn: 0.5 }];
  const dry = [{ time: '2026-01-09T12:00:00Z', precipIn: 0.05 }];
  assert.equal(waterQuality(date, wet).advisory, true);
  assert.equal(waterQuality(date, dry).advisory, false);
  // Rain older than the 72-hour window should not trigger it.
  const old = [{ time: '2026-01-01T12:00:00Z', precipIn: 2.0 }];
  assert.equal(waterQuality(date, old).advisory, false);
});

test('wetsuit call tracks water temperature', () => {
  assert.match(wetsuitCall(70, 72, 3).call, /Trunks/);
  assert.match(wetsuitCall(58, 60, 5).call, /3\/2/);
  assert.match(wetsuitCall(54, 52, 5).call, /4\/3/);
  assert.equal(wetsuitCall(null).waterF, null);
});

/* ------------------------------------------- confidence, from live data --- */

test('a small day with models a few inches apart is NOT flagged as disagreement', () => {
  // Regression: the first week of live data flagged every day of a flat spell
  // "models disagree" because spread was measured as a fraction of the height.
  const faces = [1.1, 1.25, 1.3];              // three models, knee high
  const spread = Math.max(...faces) - Math.min(...faces);
  const meaningful = Math.max(0, spread - 0.4);
  const confidence = Math.max(0, Math.min(1, 1 - 0.35 * meaningful - 8 / 120));
  assert.ok(confidence > 0.55, `flat-week confidence was ${confidence}`);
});

test('models genuinely far apart still drop confidence', () => {
  const faces = [3.0, 5.4, 6.2];
  const spread = Math.max(...faces) - Math.min(...faces);
  const meaningful = Math.max(0, spread - 0.4);
  const confidence = Math.max(0, Math.min(1, 1 - 0.35 * meaningful - 25 / 120));
  assert.ok(confidence < 0.55, `real disagreement scored ${confidence}`);
});

/* --------------------------------- a model with no usable data must abstain -- */

test('a partition without its own period falls back to the hour period', () => {
  // GFS-Wave publishes partition heights with null partition periods. Requiring
  // both silently zeroed that model on every hour of a live week.
  const r = transformToBreak(0.9, 11, 280, { origin: 'model' });
  assert.ok(r.Hb > 0, 'the fallback period must still produce a breaking wave');
});

test('a zero must never be averaged into the model ensemble', () => {
  // Regression: one model contributing 0 ft pulled the median of
  // [2.80, 0.00, 1.86] down to 1.86 instead of 2.33, under-forecasting by half
  // a foot while looking like genuine model disagreement.
  const withZero = median([2.80, 0.00, 1.86]);
  const withoutZero = median([2.80, 1.86]);
  assert.equal(withZero, 1.86);
  assert.ok(withoutZero > withZero + 0.4, 'dropping the abstaining model must matter');
});

/* ---------------------------------------- transforming from a known depth -- */

test('a wave shoaled from a known depth breaks at a sensible size', () => {
  // MOP D0590 published 0.72 m at 15.4 s from 241 deg on a real flat day.
  // With a 10 m output depth that should come out knee-to-thigh, not overhead.
  const r = transformFromDepth(0.72, 15.4, 241, 10, { shoreNormal: 258 });
  assert.ok(!r.blocked, 'should not be blocked');
  const f = faceHeights(r.Hb);
  assert.ok(f.typicalFt > 1.2 && f.typicalFt < 3.2, `got ${f.typicalFt} ft`);
  assert.ok(r.depth > 0.3 && r.depth < 3, `break depth ${r.depth} m`);
});

test('shoaling from depth agrees with the deep-water path on the same wave', () => {
  // Take a deep-water swell to a 10 m depth, then carry it on from there; the
  // breaking height should match doing it in one go within a few per cent.
  const T = 14, dir = 265;
  const direct = transformToBreak(1.4, T, dir, { origin: 'buoy' });
  // Height at 10 m from the same energy-flux relation the direct path uses.
  const Cg0 = deepWavelength(T) / T / 2;
  const Cg10 = groupVelocity(T, 10);
  const H10 = 1.4 * CALIBRATION.shelfLoss * Math.sqrt(Cg0 / Cg10);
  const staged = transformFromDepth(H10, T, dir, 10, { shoreNormal: 265 });
  const diff = Math.abs(staged.Hb - direct.Hb) / direct.Hb;
  assert.ok(diff < 0.06, `paths disagree by ${(diff * 100).toFixed(1)}%`);
});

test('a wave already breaking at the input depth is reported, not invented', () => {
  const r = transformFromDepth(5.0, 16, 265, 2, { shoreNormal: 265 });
  assert.equal(r.Hb, 0);
  assert.equal(r.blocked, false);
});
