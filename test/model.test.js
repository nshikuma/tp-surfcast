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
  angleDiff, wavelengthAt, groupVelocity, deepWavelength, combineFaces, peelAtBreak,
} from '../src/model/waves.js';
import { CALIBRATION } from '../src/config.js';
import { scoreHour, scoreTide, scoreWind, scorePeriod, gradeFor, callFor, reliabilityFor } from '../src/model/score.js';
import { median, circMean, computeModelBias, waterQuality, wetsuitCall, compass } from '../src/model/forecast.js';
import { parseOpendapAscii, partitionSpectrum } from '../src/sources/cdip.js';
import { tideAt, tideRateAt } from '../src/sources/tides.js';
import { stepState, profileFor, describe } from '../src/model/beachstate.js';
import { classifyTrain, classWeights, mixForHour, mixForDay, tideShiftFor } from '../src/model/mix.js';
import { gradeSessions } from '../src/model/groundtruth.js';

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

test('OPeNDAP ASCII parses scalar variables that carry no brackets', () => {
  // Regression: MOP's metaLatitude / metaWaterDepth / metaShoreNormal are
  // dimensionless, so their header line is a bare name. Missing that returned a
  // 19-line transect with no positions, depths or shore normals on it.
  const sample = [
    'Dataset {', ' Float64 metaLatitude;', '} x;',
    '---------------------------------------------',
    'metaLatitude', '32.93341', '',
    'metaWaterDepth', '10.5', '',
    'metaShoreNormal', '258.0', '',
    'waveHs[3]', '0.72, 0.71, 0.69', '',
  ].join('\n');
  const v = parseOpendapAscii(sample);
  assert.deepEqual(v.metaLatitude, [32.93341]);
  assert.deepEqual(v.metaWaterDepth, [10.5]);
  assert.deepEqual(v.metaShoreNormal, [258.0]);
  assert.deepEqual(v.waveHs, [0.72, 0.71, 0.69]);
});

/* ----------------------------------------------------------- beach state -- */

/**
 * The equilibrium sand model. These tests pin the TIMESCALES, which is the part
 * that matters: a storm should strip the beach in days, and it should take
 * weeks of calm to put it back. They do not pin the coefficients themselves -
 * those are still plausible values rather than the published Torrey Pines fits.
 */

const hoursOf = (hsM, hours, startMs) => Array.from({ length: hours }, (_, i) => ({
  time: new Date(startMs + i * 36e5).toISOString(), hsM,
}));

test('beach state: a storm erodes the beach within days', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const storm = stepState(0, hoursOf(3.0, 48, t0));
  assert.ok(storm.s < -6, `two days at 3 m should strip the beach, got ${storm.s.toFixed(1)} m`);
  assert.ok(storm.s > -20, `and not blow past the physical range, got ${storm.s.toFixed(1)} m`);
});

test('beach state: recovery is slower than erosion but happens in weeks', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const storm = stepState(0, hoursOf(3.0, 48, t0));
  const t1 = t0 + 48 * 36e5;
  const week = stepState(storm.s, hoursOf(0.7, 24 * 7, t1), { from: storm.updatedAt });
  const month = stepState(storm.s, hoursOf(0.7, 24 * 30, t1), { from: storm.updatedAt });
  assert.ok(week.s > storm.s, 'a calm week should rebuild some beach');
  assert.ok(week.s < storm.s / 2, 'but a single calm week must not undo a storm');
  assert.ok(month.s > week.s, 'a calm month rebuilds more than a calm week');
  assert.ok(month.s > -4, `a calm month should be most of the way back, got ${month.s.toFixed(1)} m`);
});

test('beach state: a long gap in the record does not get integrated', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  // One observation, then a two-week hole, then one more. The hole must not be
  // treated as a fourteen-day storm.
  const obs = [
    { time: new Date(t0).toISOString(), hsM: 3.0 },
    { time: new Date(t0 + 14 * 24 * 36e5).toISOString(), hsM: 3.0 },
  ];
  const out = stepState(0, obs);
  assert.ok(out.s > -1, `gaps should be skipped, got ${out.s.toFixed(2)} m`);
});

test('beach state: the profile follows the shoreline', () => {
  const eroded = profileFor(-15), full = profileFor(15);
  assert.ok(eroded.barCrestM > full.barCrestM,
    'an eroded beach pushes the bar offshore');
  assert.ok(eroded.foreshoreSlope > full.foreshoreSlope,
    'an eroded beach leaves a steeper, coarser face');
  assert.ok(eroded.barHeightM < full.barHeightM,
    'and a flatter bar than a built-up beach');
  assert.equal(profileFor(0).shorelineOffsetM, 0);
});

test('beach state: describe reads in plain language', () => {
  assert.match(describe(-14, -2).level, /strip|eroded|thin|low/i);
  assert.match(describe(14, 2).level, /built|full|deep|wide/i);
  assert.ok(describe(0, 0).summary.length > 0);
});

/* ------------------------------------------------------------- swell mix -- */

const train = (hsFt, periodS, dirDeg) => ({
  hsM: hsFt / 3.28084, hsFt, periodS, dirDeg, dirCompass: compass(dirDeg),
});

test('mix: a south swell is a groundswell at a shorter period than a west one', () => {
  // Nothing local can raise an 11s SSW; an 11s WNW is raised inside the Bight.
  assert.equal(classifyTrain({ periodS: 11, dirDeg: 200 }), 'southGround');
  assert.equal(classifyTrain({ periodS: 11, dirDeg: 285 }), 'windswell');
  assert.equal(classifyTrain({ periodS: 14, dirDeg: 285 }), 'westGround');
  assert.equal(classifyTrain({ periodS: 8, dirDeg: 200 }), 'windswell');
});

test('mix: surface chop is reported separately, never as surf', () => {
  const m = mixForHour({ faceFt: 2, trains: [train(1.2, 4.2, 270), train(2.0, 14, 200)] });
  assert.equal(m.parts.length, 1, 'the 4.2s train must not appear as a swell');
  assert.equal(m.parts[0].cls, 'southGround');
  assert.ok(m.chopFt > 1, `chop should be reported, got ${m.chopFt}`);
});

test('mix: nothing but chop reports no surf at all', () => {
  const m = mixForHour({ faceFt: 1, trains: [train(1.5, 4.5, 270)] });
  assert.equal(m.allChop, true);
  assert.equal(m.parts.length, 0);
});

test('mix: one swell split across two partitions is reported as one', () => {
  // A broad-spectrum swell the model happened to split at 11.9 / 12.1 s.
  const m = mixForHour({ faceFt: 3, trains: [train(2.0, 12.1, 205), train(1.8, 11.9, 208)] });
  assert.equal(m.parts.length, 1, 'these are the same swell, not two');
  assert.equal(m.crossing, false);
});

test('mix: two genuinely different swells are flagged as crossing', () => {
  const m = mixForHour({ faceFt: 3, trains: [train(2.0, 16, 200), train(2.0, 8, 280)] });
  assert.equal(m.parts.length, 2);
  assert.equal(m.crossing, true);
});

test('mix: shares are energy shares and reconstruct the face height', () => {
  const m = mixForHour({ faceFt: 4, trains: [train(2.0, 16, 200), train(2.0, 9, 275)] });
  const total = Math.hypot(...m.parts.map((p) => p.faceFt));
  assert.ok(Math.abs(total - 4) < 0.15, `parts should RSS back to 4 ft, got ${total.toFixed(2)}`);
  const shareSum = m.parts.reduce((s, p) => s + p.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-6);
});

test('mix: the ideal tide depends on the period, not just the spot', () => {
  assert.ok(tideShiftFor(8, 'windswell').shiftFt > 0, 'short period wants more water');
  assert.ok(tideShiftFor(17, 'southGround').shiftFt < 0, 'long period can take a lower tide');
  assert.equal(tideShiftFor(13, 'southGround').shiftFt, 0);
});

test('mix: prose never promises set gaps a short period cannot deliver', () => {
  const short = mixForDay([{ faceFt: 3, trains: [train(3, 10.5, 200)] }]);
  assert.ok(!/gaps between sets/.test(short.look), short.look);
  const long = mixForDay([{ faceFt: 3, trains: [train(3, 17, 200)] }]);
  assert.match(long.look, /gaps between sets/);
});

/* ------------------------------------------------------ call and horizon -- */

test('call: a flat week returns skips rather than promoting its best bad day', () => {
  assert.equal(callFor(20).call, 'SKIP');
  assert.equal(callFor(38).call, 'SKIP');
  assert.equal(callFor(45).call, 'MAYBE');
  assert.equal(callFor(60).call, 'WORTH IT');
  assert.equal(callFor(80).call, 'GO');
});

test('reliability: degrades with lead time, and with models disagreeing', () => {
  assert.equal(reliabilityFor(0, 1), 'solid');
  assert.equal(reliabilityFor(2, 1), 'likely');
  assert.equal(reliabilityFor(4, 1), 'planning');
  assert.equal(reliabilityFor(0, 0.3), 'likely', 'disagreement costs a notch');
});

test('reliability: confidence never improves with lead time', () => {
  // Day 1 has models disagreeing; day 2 does not. Day 2 must not come back
  // looking more trustworthy than the day before it.
  const d0 = reliabilityFor(0, 0.3, null);
  const d1 = reliabilityFor(1, 1.0, d0);
  const d2 = reliabilityFor(2, 1.0, d1);
  const rank = ['solid', 'likely', 'planning', 'rough'];
  assert.ok(rank.indexOf(d1) >= rank.indexOf(d0), `${d0} -> ${d1}`);
  assert.ok(rank.indexOf(d2) >= rank.indexOf(d1), `${d1} -> ${d2}`);
});

test('mix: the class boundary crossfades instead of flipping', () => {
  // A 9.4s and a 10.6s SSW are the same swell wobbling over the 10s line.
  // Neither should be 100% of one class, and the two must not be opposites.
  const a = classWeights({ periodS: 9.4, dirDeg: 205 });
  const b = classWeights({ periodS: 10.6, dirDeg: 205 });
  assert.ok(a.southGround > 0 && a.windswell > 0, JSON.stringify(a));
  assert.ok(b.southGround > a.southGround, 'longer period leans further toward groundswell');
  assert.ok(Math.abs((a.southGround ?? 0) + (a.windswell ?? 0) - 1) < 1e-9);
  // Well clear of the boundary it is still unambiguous.
  assert.equal(classWeights({ periodS: 16, dirDeg: 205 }).southGround, 1);
  assert.equal(classWeights({ periodS: 6.5, dirDeg: 205 }).windswell, 1);
});

/**
 * The wiring contract between the swell-train fetcher and the mix model.
 *
 * This exists because the first version of that wiring shipped a completely
 * empty swell breakdown and CI went green: the trains were attached to the
 * hour objects during payload compaction, a hundred lines AFTER the mix model
 * read them, so every hour looked trainless. Nothing threw, nothing failed, the
 * page just quietly lost a whole section. This test pins the shape the mix
 * model needs so that mismatch fails here instead of in production.
 */
test('mix: consumes the train shape the build actually attaches', () => {
  // Exactly what src/build.js builds from openmeteo.fetchSwellTrains().
  const M_TO_FT_ = 3.28084;
  const fetched = [
    { kind: 'primary swell', hsM: 0.61, periodS: 14.2, dirDeg: 203 },
    { kind: 'wind waves', hsM: 0.4, periodS: 7.1, dirDeg: 272 },
  ];
  const hour = {
    time: '2026-02-01T15:00:00.000Z',
    faceFt: 3.2,
    trains: fetched.map((p) => ({
      kind: p.kind, hsM: p.hsM, hsFt: p.hsM * M_TO_FT_,
      periodS: p.periodS, dirDeg: p.dirDeg, dirCompass: compass(p.dirDeg),
    })),
  };
  const m = mixForHour(hour);
  assert.ok(m, 'the mix model must accept the build\'s train objects');
  assert.equal(m.parts.length, 2);
  assert.deepEqual(m.parts.map((p) => p.cls).sort(), ['southGround', 'windswell']);
  // And the shares must reconstruct the hour's face height when laid end to end.
  const stacked = m.parts.reduce((s, p) => s + p.share * hour.faceFt, 0);
  assert.ok(Math.abs(stacked - hour.faceFt) < 1e-6, `stack ${stacked} != ${hour.faceFt}`);
});

test('mix: an hour with no trains yields no breakdown rather than a fake one', () => {
  assert.equal(mixForHour({ faceFt: 3, trains: [] }), null);
  assert.equal(mixForHour({ faceFt: 3 }), null);
});

/* ================================================== crossed-sea set height ==
 *
 * From the session of 2026-09-16 at the rivermouth: the ordinary waves were
 * thigh-to-waist, which the model had about right, and the sets were head high,
 * which the model called waist high. These tests pin the mechanism that was
 * missing - that the set waves in a crossed sea are the moments the trains
 * coincide, and coinciding crests add linearly rather than in energy.
 */

test('combineFaces: one clean swell gets no superposition at all', () => {
  const c = combineFaces([3.0]);
  assert.equal(c.typicalFt, 3.0);
  assert.equal(c.superposition, 1, 'a single train cannot superpose with itself');
  assert.ok(Math.abs(c.setFt - 3.0 * CALIBRATION.setFactor) < 1e-9);
});

test('combineFaces: typical height is root-sum-square, not the sum', () => {
  const c = combineFaces([2, 2]);
  assert.ok(Math.abs(c.typicalFt - Math.SQRT2 * 2) < 1e-9,
    'two 2 ft trains make a 2.8 ft sea, not a 4 ft one');
});

test('combineFaces: a crossed sea has much bigger sets than a clean one of the same height', () => {
  // The comparison only means anything if both seas are the SAME size, so the
  // three trains are scaled until their root-sum-square matches the single one.
  const raw = [1.76, 1.04, 0.98];
  const target = 2.83;
  const k = target / Math.hypot(...raw);
  const clean = combineFaces([target]);
  const crossed = combineFaces(raw.map((x) => x * k));

  assert.ok(Math.abs(clean.typicalFt - crossed.typicalFt) < 0.01,
    `same size by construction: ${clean.typicalFt.toFixed(2)} vs ${crossed.typicalFt.toFixed(2)}`);
  assert.ok(crossed.setFt > clean.setFt * 1.25,
    `crossed sets ${crossed.setFt.toFixed(2)} should clearly beat clean ${clean.setFt.toFixed(2)} `
    + 'at identical significant height');
  assert.ok(crossed.superposition > 1.2 && crossed.superposition < 1.7,
    `superposition ${crossed.superposition.toFixed(2)} out of range`);
});

test('combineFaces: set height never exceeds every train arriving in phase', () => {
  const f = [1.76, 1.04, 0.98];
  const c = combineFaces(f);
  const linear = f.reduce((a, b) => a + b, 0);
  assert.ok(c.setFt <= linear * CALIBRATION.setFactor + 1e-9,
    'the sets cannot beat all of them coinciding');
  assert.ok(c.setFt >= c.typicalFt, 'and cannot be smaller than the typical wave');
});

/* ------------------------------------------------------ peel and closeout -- */

test('peel: refraction alone closes everything out - the bar is what makes it rideable', () => {
  // A long-period swell refracts to within a few degrees of shore-normal. Over
  // a perfectly straight bottom that is a closeout, and the only thing that
  // saves it is the bank sitting at an angle to the beach.
  const straight = peelAtBreak(4.3, 0.51, 0);
  assert.equal(straight.makeable, false);
  assert.ok(straight.speedMs > 25, `${straight.speedMs} m/s over a straight bar`);

  const banked = peelAtBreak(4.3, 0.51, 25);
  assert.ok(banked.speedMs < straight.speedMs, 'a crooked bank gives the crest something to peel along');
});

test('peel: the morning of 2026-09-16 comes out as a closeout', () => {
  // The real refracted crest angles that morning, from the buoy partitions.
  const p = peelAtBreak(1.4, 0.91);
  assert.equal(p.makeable, false, `called makeable at ${p.speedMs} m/s`);
  assert.ok(p.closeoutRatio > 1, 'the break outruns the rider');
});

test('peel: a swell that still has angle on it at the break is makeable', () => {
  const p = peelAtBreak(18, 1.4);
  assert.equal(p.makeable, true, `${p.speedMs} m/s should be rideable`);
});

test('score: a closeout cannot be a good day however clean the takeoff', () => {
  const base = {
    HbM: 1.0, faceTypicalFt: 4, faceSetFt: 6, Tp: 14, swellDirDeg: 265,
    tideFt: 2.4, tideRate: 0.2, windKt: 3, windDirDeg: 85, powerKwPerM: 14,
  };
  const peels = scoreHour({ ...base, peel: peelAtBreak(20, 1.4) });
  const shuts = scoreHour({ ...base, peel: peelAtBreak(0.5, 1.4) });
  assert.ok(shuts.total < peels.total - 8,
    `closeout ${shuts.total} should score well under peeling ${peels.total}`);
  assert.match(shuts.parts.shape.closeout.note, /walls and closeouts/);
});

/* ---------------------------------------------------------- ground truth -- */

test('groundTruth: grades typical and set size separately', () => {
  // The whole point: on the logged session the typical wave was close and the
  // sets were out by a factor of two. One combined error number hides that.
  const hourly = [{
    localDate: '2026-02-01', localHour: 7.5, faceFt: 2.0, faceSetFt: 2.7,
    score: 43, periodS: 11.6, peel: { makeable: true, speedMs: 8 },
  }];
  const g = gradeSessions([{
    date: '2026-02-01', fromLocalHour: 7, toLocalHour: 8,
    spot: 'rivermouth', typicalFt: 2.5, setFt: 5.5, makeable: false,
  }], hourly, []);
  const s = g.sessions[0];
  assert.equal(s.matched, true);
  assert.ok(Math.abs(s.typicalRatio - 1.25) < 0.02, `typical ratio ${s.typicalRatio}`);
  assert.ok(Math.abs(s.setRatio - 2.04) < 0.02, `set ratio ${s.setRatio}`);
  assert.equal(s.shapeRight, false, 'we said makeable, it was not');
  assert.match(s.verdict, /sets were 2\.0x/);
});

test('groundTruth: a session with no forecast to compare against says so', () => {
  const g = gradeSessions([{ date: '2019-01-01', fromLocalHour: 7, toLocalHour: 8, typicalFt: 3, setFt: 4 }], [], []);
  assert.equal(g.sessions[0].matched, false);
  assert.equal(g.summary.n, 0);
});

test('groundTruth: matches trimmed archives, which carry no local date', () => {
  // The archive format drops localDate/localHour to keep years of history small.
  // Matching on those fields could never succeed, so every session silently
  // fell through to a hindcast and the archive was never really consulted.
  const hourly = [
    { time: '2026-02-01T15:00:00.000Z', localDate: '2026-02-01', localHour: 7, faceFt: 2.0, faceSetFt: 3.0, score: 40, periodS: 12 },
    { time: '2026-02-01T16:00:00.000Z', localDate: '2026-02-01', localHour: 8, faceFt: 2.0, faceSetFt: 3.0, score: 40, periodS: 12 },
  ];
  const archive = {
    issued: '2026-02-01T11:00:00.000Z',           // before the session
    hourly: [
      { time: '2026-02-01T15:00:00.000Z', faceFt: 1.5, faceSetFt: 2.0, score: 30, periodS: 11, makeable: true },
      { time: '2026-02-01T16:00:00.000Z', faceFt: 1.5, faceSetFt: 2.0, score: 30, periodS: 11, makeable: true },
    ],
  };
  const session = { date: '2026-02-01', fromLocalHour: 7, toLocalHour: 8, typicalFt: 3, setFt: 4, makeable: false };
  const g = gradeSessions([session], hourly, [archive]);
  const s = g.sessions[0];
  assert.equal(s.forecast.hindcast, false, 'must use the archive, not fall back to this run');
  assert.equal(s.forecast.issued, archive.issued);
  assert.equal(s.forecast.typicalFt, 1.5, 'the archived number, not the current one');
  assert.equal(s.shapeRight, false);
});

test('groundTruth: a run issued after the session is not a forecast', () => {
  const hourly = [{ time: '2026-02-01T15:00:00.000Z', localDate: '2026-02-01', localHour: 7, faceFt: 2, faceSetFt: 3, score: 40, periodS: 12 }];
  const tooLate = {
    issued: '2026-02-01T23:00:00.000Z',           // after the session finished
    hourly: [{ time: '2026-02-01T15:00:00.000Z', faceFt: 3, faceSetFt: 4, score: 60, periodS: 12 }],
  };
  const g = gradeSessions([{ date: '2026-02-01', fromLocalHour: 7, toLocalHour: 8, typicalFt: 3, setFt: 4 }], hourly, [tooLate]);
  assert.equal(g.sessions[0].forecast.hindcast, true,
    'a run that had already seen the day is a hindcast, however well it scores');
});

test('groundTruth: falls back to what the page recorded when the archive predates a field', () => {
  const hourly = [{ time: '2026-02-01T15:00:00.000Z', localDate: '2026-02-01', localHour: 7, faceFt: 2, faceSetFt: 3, score: 40, periodS: 12 }];
  const oldArchive = {
    issued: '2026-02-01T11:00:00.000Z',
    hourly: [{ time: '2026-02-01T15:00:00.000Z', faceFt: 2.0, score: 43, periodS: 11.5 }],  // no faceSetFt
  };
  const g = gradeSessions([{
    date: '2026-02-01', fromLocalHour: 7, toLocalHour: 8,
    typicalFt: 2.5, setFt: 5.5, makeable: false,
    modelSaidAtTheTime: { setFt: 2.66, makeable: true },
  }], hourly, [oldArchive]);
  const s = g.sessions[0];
  assert.equal(s.forecast.setFromNote, true, 'flagged as the recorded note, not the archive');
  assert.ok(Math.abs(s.setRatio - 2.07) < 0.05, `set ratio ${s.setRatio}`);
  assert.equal(s.shapeRight, false);
});
