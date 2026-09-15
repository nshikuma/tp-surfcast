/**
 * Linear wave transformation: deep water at the buoy -> what actually breaks
 * on the sand at the north lot.
 *
 * This is the part that a generic regional forecast does not do. Surfline and
 * the raw model grids give you a deep-water or shelf-edge significant height.
 * We take that and run it through refraction, shoaling and depth-limited
 * breaking for THIS beach's orientation and slope, then convert the resulting
 * statistical height into a face height a person can picture.
 */

import { SITE, EXPOSURE, BAR_ALIGNMENT, CALIBRATION, SIZE_LADDER } from '../config.js';

const G = 9.81;
const RHO = 1025; // seawater density, kg/m^3
export const M_TO_FT = 3.28084;

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Smallest signed angle from b to a, in (-180, 180]. */
export function angleDiff(a, b) {
  let d = ((a - b + 540) % 360) - 180;
  return d;
}

/** Deep-water wavelength for period T. */
export const deepWavelength = (T) => (G * T * T) / (2 * Math.PI);

/**
 * Wavelength at depth h, solving L = L0 * tanh(2*pi*h/L) by fixed-point
 * iteration seeded with the Fenton & McKee approximation.
 */
export function wavelengthAt(T, h) {
  const L0 = deepWavelength(T);
  if (h <= 0) return 0;
  let L = L0 * Math.pow(Math.tanh(Math.pow((2 * Math.PI / T) * Math.sqrt(h / G), 1.5)), 2 / 3);
  for (let i = 0; i < 60; i++) {
    const next = L0 * Math.tanh((2 * Math.PI * h) / L);
    if (Math.abs(next - L) < 1e-7) return next;
    L = next;
  }
  return L;
}

/** Group velocity at depth h. */
export function groupVelocity(T, h) {
  const L = wavelengthAt(T, h);
  if (L === 0) return 0;
  const k = (2 * Math.PI) / L;
  const C = L / T;
  const kh2 = 2 * k * h;
  // n = 0.5 * (1 + 2kh/sinh(2kh)); guard the deep-water limit where sinh overflows.
  const n = kh2 > 50 ? 0.5 : 0.5 * (1 + kh2 / Math.sinh(kh2));
  return n * C;
}

/**
 * Transform one swell partition from the buoy to the break.
 *
 * @param {number} Hs0  significant height at source, metres
 * @param {number} T    peak (or partition) period, seconds
 * @param {number} dir0 direction waves come FROM, degrees true
 * @param {object} opts
 * @param {'buoy'|'model'} opts.origin  Where Hs0 came from. This matters a lot:
 *        the CDIP buoy sits inside the Channel Islands shadow so its reading
 *        already contains the blocking, while a 0.25-degree global model only
 *        crudely resolves the islands and needs a partial correction.
 * @returns {{Hb:number, depth:number, angle0:number, angleB:number,
 *            Kr:number, Ks:number, exposure:number, blocked:boolean}}
 */
export function transformToBreak(Hs0, T, dir0, opts = {}) {
  const shoreNormal = opts.shoreNormal ?? SITE.shoreNormalDeg;
  const gamma = opts.gamma ?? CALIBRATION.gammaBreak;
  const origin = opts.origin ?? 'buoy';
  const shelfLoss = opts.shelfLoss ?? CALIBRATION.shelfLoss;

  const exposure = origin === 'buoy' ? 1 : modelExposureFor(dir0);
  // Angle between the swell's travel direction and shore normal.
  const angle0 = angleDiff(dir0, shoreNormal);

  const empty = {
    Hb: 0, depth: 0, angle0, angleB: 0, Kr: 0, Ks: 0, exposure, blocked: true,
  };
  // Beyond ~80 degrees off shore-normal the swell is running down the coast,
  // not into it. Nothing meaningful arrives.
  if (Math.abs(angle0) >= 80 || !(Hs0 > 0) || !(T > 0)) return empty;

  const H0 = Hs0 * exposure * shelfLoss;
  if (H0 <= 0.005) return { ...empty, blocked: false };

  const C0 = deepWavelength(T) / T;
  const Cg0 = C0 / 2;
  const sin0 = Math.sin(rad(angle0));

  // H(h) with refraction + shoaling, assuming straight parallel contours.
  const heightAt = (h) => {
    const L = wavelengthAt(T, h);
    const C = L / T;
    const sinB = Math.max(-1, Math.min(1, (C / C0) * sin0));
    const angleB = Math.asin(sinB);
    const Kr = Math.sqrt(Math.cos(rad(angle0)) / Math.cos(angleB));
    const Ks = Math.sqrt(Cg0 / groupVelocity(T, h));
    return { H: H0 * Kr * Ks, Kr, Ks, angleB: deg(angleB) };
  };

  // f(h) = H(h) - gamma*h. Negative in deep water, positive as it shoals.
  // Bisect for the crossing: that depth is where it breaks.
  let lo = 0.05, hi = 80;
  const f = (h) => heightAt(h).H - gamma * h;
  if (f(hi) > 0) hi = 300; // enormous swell; push the bracket out
  if (f(lo) < 0) return { ...empty, blocked: false }; // never steep enough to break
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > 0) lo = mid; else hi = mid;
  }
  const depth = 0.5 * (lo + hi);
  const at = heightAt(depth);

  return {
    Hb: at.H, depth, angle0, angleB: at.angleB,
    Kr: at.Kr, Ks: at.Ks, exposure, blocked: false,
    // The effective deep-water height after shadowing and shelf losses. The
    // 2-D simulation propagates from exactly this, so its breaking heights
    // agree with the 1-D forecast instead of quietly disagreeing on screen.
    H0,
  };
}

/**
 * Exposure correction for global-model data, which under-resolves the islands.
 * Blends the full shadowing table toward 1.0 by modelExposureStrength.
 */
export function modelExposureFor(dirDeg) {
  const full = exposureFor(dirDeg);
  const k = CALIBRATION.modelExposureStrength;
  return 1 - k * (1 - full);
}

/** Piecewise directional exposure lookup (island + headland shadowing). */
export function exposureFor(dirDeg) {
  const d = ((dirDeg % 360) + 360) % 360;
  for (const band of EXPOSURE) {
    if (d >= band.from && d < band.to) return band.t;
  }
  return 0.15; // anything unmapped is effectively offshore-blocked
}

/** How well this swell angle lines up with the north-lot bars. 1.0 = neutral. */
export function barAlignmentFor(dirDeg) {
  const d = ((dirDeg % 360) + 360) % 360;
  for (const band of BAR_ALIGNMENT) {
    if (d >= band.from && d < band.to) return band.q;
  }
  return 0.85;
}

/**
 * Deep-water wave power per metre of crest, kW/m. This is the "total energy"
 * number - it is what actually distinguishes a 3 ft 18-second groundswell
 * (powerful) from a 3 ft 8-second windswell (gutless), which a height-only
 * forecast cannot tell you.
 */
export function wavePowerKwPerM(HsM, Tp) {
  if (!(HsM > 0) || !(Tp > 0)) return 0;
  const Te = 0.9 * Tp; // energy period for a typical wind-sea/swell spectrum
  return ((RHO * G * G) / (64 * Math.PI)) * HsM * HsM * Te / 1000;
}

/** Wave energy density, kJ/m^2. */
export function energyDensityKjPerM2(HsM) {
  if (!(HsM > 0)) return 0;
  return (RHO * G * HsM * HsM) / 16 / 1000;
}

/**
 * Iribarren (surf similarity) number at breaking - tells you the breaker type.
 * < 0.4 spilling (mushy), 0.4-2.0 plunging (the good stuff), > 2.0 surging.
 */
export function iribarren(HbM, T, slope = SITE.beachSlope) {
  if (!(HbM > 0) || !(T > 0)) return 0;
  return slope / Math.sqrt(HbM / deepWavelength(T));
}

export function breakerType(xi) {
  if (xi < 0.4) return { type: 'spilling', desc: 'soft, crumbly shoulders' };
  if (xi < 1.2) return { type: 'plunging', desc: 'steep takeoff, some barrel potential' };
  if (xi < 2.0) return { type: 'plunging-hard', desc: 'heavy, fast, close-out risk' };
  return { type: 'surging', desc: 'shorebreak-ish, backing off then slamming' };
}

/**
 * Physical breaking significant height (m) -> the face heights a surfer would
 * quote, in feet. See CALIBRATION.faceFactor for why this scales DOWN.
 */
export function faceHeights(HbM) {
  const typical = HbM * M_TO_FT * CALIBRATION.faceFactor;
  return { typicalFt: typical, setFt: typical * CALIBRATION.setFactor };
}

/** Face height in feet -> the body-scale phrase the crew actually uses. */
export function sizeLabel(faceFt) {
  for (const step of SIZE_LADDER) {
    if (faceFt < step.max) return step;
  }
  return SIZE_LADDER[SIZE_LADDER.length - 1];
}

/**
 * Combine several swell partitions arriving at once. Heights add in energy
 * (root-sum-square), not linearly - two 2 ft swells make a 2.8 ft sea, not 4 ft.
 * Getting this wrong is a classic way to over-forecast a mixed-swell day.
 */
export function combinePartitions(parts) {
  const live = parts.filter((p) => p && p.HbM > 0);
  if (!live.length) return { HbM: 0, dominant: null, parts: [] };
  const HbM = Math.sqrt(live.reduce((s, p) => s + p.HbM * p.HbM, 0));
  const dominant = live.reduce((a, b) => (b.HbM > a.HbM ? b : a));
  return { HbM, dominant, parts: live };
}
