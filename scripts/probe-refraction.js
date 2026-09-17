/**
 * The measurement the two buoys make possible.
 *
 * Bulk Hs/Tp/Dp is the wrong comparison between these stations. The first probe
 * showed why: when the outer buoy peaks on an 18 s south swell, the nearshore
 * buoy frequently peaks on a 9 s west windswell, because the south has lost so
 * much energy on the way in that it is no longer the largest thing in the
 * spectrum. Differencing the two peak directions then reports a "+90 degree
 * turn" that is not refraction at all - it is the peak jumping trains.
 *
 * So compare BAND BY BAND. Both stations publish a 64-band directional
 * spectrum. For each frequency, the energy ratio between the two sites is the
 * shelf transformation at that period, and the direction difference is the
 * refraction turning at that period. Neither is contaminated by what the other
 * swells are doing.
 *
 * What this DOES measure: refraction, shoaling and bottom friction between 550 m
 * and 17 m. What it does NOT measure: island sheltering - both buoys sit behind
 * the same islands, so that cancels. The exposure table in config.js is about
 * deep-ocean-to-buoy sheltering and this cannot speak to it. What it can speak
 * to is shelfLoss and the refraction maths, which is the step that feeds
 * straight into breaking height.
 */

import { fetchSpectrum } from '../src/sources/cdip.js';
import { wavelengthAt, groupVelocity, deepWavelength } from '../src/model/waves.js';
import { SITE } from '../src/config.js';

const OUTER = '100p1';
const NEAR = '153p1';
const NEAR_DEPTH_M = 17;            // from the station metadata, measured
const log = (s) => console.log(s);

/** Snell + shoaling from deep water to a given depth, for one frequency. */
function propagate(periodS, dirDeg, depthM, shoreNormalDeg = SITE.shoreNormalDeg) {
  const omega = (2 * Math.PI) / periodS;
  const L0 = deepWavelength(periodS);
  const k0 = (2 * Math.PI) / L0;
  const c0 = L0 / periodS;
  const cg0 = groupVelocity(omega, k0, 4000);          // deep

  const L1 = wavelengthAt(periodS, depthM);
  const k1 = (2 * Math.PI) / L1;
  const c1 = L1 / periodS;
  const cg1 = groupVelocity(omega, k1, depthM);

  // Angles measured from the shore normal, i.e. from the depth-contour normal.
  const off0 = (((dirDeg - shoreNormalDeg + 540) % 360) - 180);
  const a0 = Math.abs(off0) * Math.PI / 180;
  const sinA1 = Math.min(0.999, (c1 / c0) * Math.sin(a0));
  const a1 = Math.asin(sinA1);

  const Ks = Math.sqrt(cg0 / cg1);
  const Kr = Math.sqrt(Math.cos(a0) / Math.cos(a1));
  return {
    offDeg0: off0,
    offDeg1: (off0 < 0 ? -1 : 1) * (a1 * 180 / Math.PI),
    predictedDirDeg: (shoreNormalDeg + (off0 < 0 ? -1 : 1) * (a1 * 180 / Math.PI) + 360) % 360,
    Ks, Kr,
    heightRatio: Ks * Kr,
    energyRatio: (Ks * Kr) ** 2,
  };
}

const angDiff = (a, b) => (((a - b + 540) % 360) - 180);

async function main() {
  const [outer, near] = await Promise.all([fetchSpectrum(OUTER), fetchSpectrum(NEAR)]);
  log(`outer  ${OUTER}: ${outer.time}  ${outer.bands.length} bands`);
  log(`near   ${NEAR}: ${near.time}  ${near.bands.length} bands`);

  // The comparison only means anything if the two grids line up.
  const fo = outer.bands.map((b) => b.freqHz);
  const fn = near.bands.map((b) => b.freqHz);
  const sameGrid = fo.length === fn.length && fo.every((f, i) => Math.abs(f - fn[i]) < 1e-6);
  log(`frequency grids identical: ${sameGrid}`);
  if (!sameGrid) {
    log(`outer freqs: ${fo.slice(0, 8).map((f) => f.toFixed(4)).join(' ')} ...`);
    log(`near  freqs: ${fn.slice(0, 8).map((f) => f.toFixed(4)).join(' ')} ...`);
  }
  const dt = Math.abs(Date.parse(outer.time) - Date.parse(near.time)) / 60000;
  log(`observations ${dt.toFixed(0)} min apart`);

  const byFreq = new Map(near.bands.map((b) => [b.freqHz.toFixed(5), b]));
  const rows = [];
  for (const o of outer.bands) {
    const n = byFreq.get(o.freqHz.toFixed(5));
    if (!n) continue;
    if (!(o.energy > 0.02)) continue;                  // ignore empty bands
    const T = o.periodS;
    const pred = o.dirDeg == null ? null : propagate(T, o.dirDeg, NEAR_DEPTH_M);
    rows.push({
      T,
      eOuter: o.energy, eNear: n.energy,
      ratioE: n.energy / o.energy,
      ratioH: Math.sqrt(n.energy / o.energy),
      dirOuter: o.dirDeg, dirNear: n.dirDeg,
      turn: (o.dirDeg != null && n.dirDeg != null) ? angDiff(n.dirDeg, o.dirDeg) : null,
      pred,
    });
  }

  log('\n  T(s)   E_out   E_near  Hratio | dir_out dir_near turn | pred_dir pred_Hratio  Kr    Ks   | residual');
  log('  ' + '-'.repeat(108));
  for (const r of rows.sort((a, b) => b.T - a.T)) {
    const p = r.pred;
    const resid = p && p.heightRatio > 0 ? r.ratioH / p.heightRatio : null;
    log('  '
      + r.T.toFixed(1).padStart(5)
      + r.eOuter.toFixed(2).padStart(8)
      + r.eNear.toFixed(2).padStart(9)
      + r.ratioH.toFixed(2).padStart(8)
      + ' |' + String(Math.round(r.dirOuter ?? 0)).padStart(7)
      + String(Math.round(r.dirNear ?? 0)).padStart(9)
      + (r.turn == null ? '     --' : (r.turn > 0 ? '+' : '') + r.turn.toFixed(0)).padStart(6)
      + ' |' + (p ? String(Math.round(p.predictedDirDeg)).padStart(9) : '       --')
      + (p ? p.heightRatio.toFixed(2).padStart(12) : '          --')
      + (p ? p.Kr.toFixed(2).padStart(6) : '     --')
      + (p ? p.Ks.toFixed(2).padStart(6) : '     --')
      + ' |' + (resid == null ? '      --' : resid.toFixed(2).padStart(8)));
  }

  // The headline: how does the residual behave by period? A residual near 1
  // means the refraction and shoaling maths is already right and nothing needs
  // correcting. Consistently below 1 means real energy is being lost that the
  // model does not account for.
  log('\nresidual (measured height ratio / predicted) by period band:');
  for (const [lo, hi, name] of [[3, 7, 'chop'], [7, 10, 'windswell'], [10, 13, 'mid'], [13, 16, 'ground'], [16, 25, 'long S']]) {
    const inBand = rows.filter((r) => r.T >= lo && r.T < hi && r.pred && r.pred.heightRatio > 0);
    if (!inBand.length) { log(`  ${name.padEnd(10)} ${lo}-${hi}s: nothing in this band`); continue; }
    const weight = inBand.reduce((s, r) => s + r.eOuter, 0);
    const wResid = inBand.reduce((s, r) => s + (r.ratioH / r.pred.heightRatio) * r.eOuter, 0) / weight;
    const wTurnErr = inBand.filter((r) => r.turn != null)
      .reduce((s, r) => s + angDiff(r.dirNear, r.pred.predictedDirDeg) * r.eOuter, 0) / weight;
    log(`  ${name.padEnd(10)} ${lo}-${hi}s: n=${String(inBand.length).padStart(2)}`
      + `  energy-weighted residual ${wResid.toFixed(2)}`
      + `  direction error ${wTurnErr > 0 ? '+' : ''}${wTurnErr.toFixed(0)} deg`
      + `  (outer energy ${weight.toFixed(1)})`);
  }
  log('\nresidual 1.00 = the refraction/shoaling maths already agrees with the buoys.');
  log('below 1.00 = real energy lost that the model does not account for.');
}

main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
