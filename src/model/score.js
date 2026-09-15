/**
 * Turning physics into a decision: is it worth driving to the north lot at 7:30?
 *
 * Every sub-score returns 0..1 and carries a short human reason. The reasons
 * are what make the page trustworthy - a number with no explanation is just a
 * different brand of guessing.
 */

import { CALIBRATION, SITE, SESSION_WINDOW } from '../config.js';
import {
  angleDiff, iribarren, breakerType, faceHeights, sizeLabel, barAlignmentFor,
} from './waves.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, t) => a + (b - a) * t;

/** Ramp from 0 at `zero` to 1 at `one` (works in either direction). */
function ramp(x, zero, one) {
  if (zero === one) return x >= one ? 1 : 0;
  return clamp01((x - zero) / (one - zero));
}

/* ------------------------------------------------------------------ tide -- */

/**
 * Tide score for a beach break with a bar/trough profile.
 * @param {number} tideFt  height above MLLW, feet
 * @param {number} rateFtPerHr  positive = incoming
 */
export function scoreTide(tideFt, rateFtPerHr = 0) {
  const { best, usable, incomingBonus } = CALIBRATION.tide;
  let s;
  let reason;
  if (tideFt >= best[0] && tideFt <= best[1]) {
    s = 1;
    reason = `${tideFt.toFixed(1)} ft - in the sweet spot for the bars`;
  } else if (tideFt < best[0]) {
    s = ramp(tideFt, usable[0], best[0]);
    reason = tideFt < 0
      ? `${tideFt.toFixed(1)} ft - drained out, expect closeouts on dry sand`
      : `${tideFt.toFixed(1)} ft - low, steep and fast, some closeouts`;
  } else {
    s = 1 - ramp(tideFt, best[1], usable[1]);
    reason = `${tideFt.toFixed(1)} ft - high and fat, backwash off the upper beach`;
  }
  if (rateFtPerHr > 0.05) s = clamp01(s + incomingBonus);
  return { score: clamp01(s), reason, tideFt, rateFtPerHr };
}

/* ------------------------------------------------------------------ wind -- */

/**
 * @param {number} speedKt
 * @param {number} dirFromDeg  direction wind comes FROM, degrees true
 */
export function scoreWind(speedKt, dirFromDeg) {
  const w = CALIBRATION.wind;
  // Offshore here means blowing from the land, i.e. from the shore normal's
  // reciprocal (~085 true). Positive component = offshore.
  const offshoreBearing = (SITE.shoreNormalDeg + 180) % 360;
  const off = Math.cos((angleDiff(dirFromDeg, offshoreBearing) * Math.PI) / 180);
  const offshoreKt = speedKt * off;       // + offshore, - onshore
  const crossKt = speedKt * Math.sqrt(Math.max(0, 1 - off * off));

  let s, reason;
  if (speedKt <= w.glassyMax) {
    s = 1;
    reason = `${speedKt.toFixed(0)} kt - glassy`;
  } else if (offshoreKt > 0) {
    // Rises to 1 at the ideal, then falls off as it gets too strong.
    s = offshoreKt <= w.offshoreIdeal
      ? lerp(0.9, 1, ramp(offshoreKt, 0, w.offshoreIdeal))
      : 1 - 0.75 * ramp(offshoreKt, w.offshoreIdeal, w.offshoreMax);
    reason = offshoreKt > w.offshoreMax
      ? `${speedKt.toFixed(0)} kt offshore - too strong, holding them up`
      : `${speedKt.toFixed(0)} kt offshore - groomed`;
  } else {
    const on = -offshoreKt;
    s = 1 - 0.95 * ramp(on, w.onshoreTolerable, w.onshoreRuin);
    reason = on > w.onshoreRuin
      ? `${speedKt.toFixed(0)} kt onshore - blown out`
      : `${speedKt.toFixed(0)} kt onshore - textured`;
  }
  // A strong cross-shore still wrecks the shape even when the onshore
  // component alone looks survivable.
  s *= 1 - 0.35 * ramp(crossKt, 10, 22);
  return {
    score: clamp01(s), reason, speedKt, dirFromDeg,
    offshoreKt, crossKt,
    label: offshoreKt > 1 ? 'offshore' : offshoreKt < -1 ? 'onshore' : 'cross-shore',
  };
}

/* --------------------------------------------------------------- quality -- */

/** Period-driven power/organisation score. */
export function scorePeriod(Tp) {
  const p = CALIBRATION.period;
  if (!(Tp > 0)) return { score: 0, reason: 'no period data' };
  if (Tp < p.weakBelow) {
    return { score: clamp01(ramp(Tp, 4, p.weakBelow) * 0.45), reason: `${Tp.toFixed(0)}s - short-period windslop` };
  }
  if (Tp < p.goodBand[0]) {
    return { score: lerp(0.45, 1, ramp(Tp, p.weakBelow, p.goodBand[0])), reason: `${Tp.toFixed(0)}s - mid-period, moderate push` };
  }
  if (Tp <= p.goodBand[1]) {
    return { score: 1, reason: `${Tp.toFixed(0)}s - real groundswell energy` };
  }
  // Very long period at a beach break loves to close out.
  return { score: 1 - 0.3 * ramp(Tp, p.goodBand[1], 22), reason: `${Tp.toFixed(0)}s - long period, watch for closeouts` };
}

/** Breaker shape from the Iribarren number plus how the angle hits the bars. */
export function scoreShape(HbM, Tp, swellDirDeg) {
  const xi = iribarren(HbM, Tp);
  const bt = breakerType(xi);
  // Plunging (xi ~ 0.5-1.4) is what we want; spilling mush and surging
  // shorebreak both lose points.
  let s;
  if (xi < 0.4) s = lerp(0.35, 0.8, ramp(xi, 0.1, 0.4));
  else if (xi <= 1.4) s = 1;
  else s = 1 - 0.5 * ramp(xi, 1.4, 2.6);
  const align = barAlignmentFor(swellDirDeg);
  s = clamp01(s * Math.min(1.12, align));
  return {
    score: s, xi, breakerType: bt.type,
    reason: `${bt.type} (${bt.desc}); swell angle ${align >= 1.05 ? 'lines up well with the bars' : align < 0.9 ? 'hits the bars poorly' : 'is workable'}`,
  };
}

/* ------------------------------------------------------------- board fit -- */

/**
 * Mixed-quiver call: rate the day on whichever board actually suits it, and
 * say which one to bring.
 */
export function boardCall(faceFt, xi, powerKwPerM) {
  // A 3% beach slope puts most rideable days in the 0.3-0.5 Iribarren band,
  // so 'punchy' has to be judged against that, not against a point-break scale.
  const punchy = xi > 0.32 && powerKwPerM > 5;
  if (faceFt >= 8.0) {
    return { board: 'Step-up / semi-gun', fitScore: 0.9, note: 'Real size - bring something with paddle power and hold.' };
  }
  if (faceFt >= 4.2) {
    return punchy
      ? { board: 'Shortboard', fitScore: 1.0, note: 'Enough size and push to go small and rail-to-rail.' }
      : { board: 'Shortboard (or a groveller)', fitScore: 0.85, note: 'Size is there but it is soft - a wider, flatter board will go better.' };
  }
  if (faceFt >= 3.2) {
    return punchy
      ? { board: 'Shortboard', fitScore: 0.95, note: 'Marginal for a shortboard on size, but it has enough push to make it work.' }
      : { board: 'Mid-length', fitScore: 0.9, note: 'Rideable on a shortboard, but a mid-length will double your wave count.' };
  }
  if (faceFt >= 2.2) {
    return { board: 'Mid-length / fun shape', fitScore: 0.8, note: 'Too small and soft for a shortboard - glide-friendly.' };
  }
  if (faceFt >= 1.4) {
    return { board: 'Longboard', fitScore: 0.6, note: 'Log-only. Fine for a cruisy paddle, not worth a special trip.' };
  }
  return { board: 'Not worth it', fitScore: 0.15, note: 'Flat to ankle-slappers. Go for a run instead.' };
}

/**
 * Size score for a mixed quiver. Unlike a shortboard-only model this does not
 * crater on small days - it just caps how good a small day can be.
 */
export function scoreSize(faceFt) {
  if (faceFt < 1.4) return { score: 0.05, reason: 'flat' };
  if (faceFt < 2.2) return { score: lerp(0.12, 0.38, ramp(faceFt, 1.4, 2.2)), reason: 'tiny, log-only' };
  if (faceFt < 3.2) return { score: lerp(0.38, 0.68, ramp(faceFt, 2.2, 3.2)), reason: 'small but surfable' };
  if (faceFt < 4.5) return { score: lerp(0.68, 0.95, ramp(faceFt, 3.2, 4.5)), reason: 'solid, fun size' };
  if (faceFt <= 7.0) return { score: 1, reason: 'prime size' };
  if (faceFt <= 9.5) return { score: 1 - 0.25 * ramp(faceFt, 7.0, 9.5), reason: 'big - serious but rideable' };
  return { score: 0.55 - 0.3 * ramp(faceFt, 9.5, 14), reason: 'very big, closing out / hard to get out' };
}

/* --------------------------------------------------------- overall score -- */

// Tide carries real weight here: dead low genuinely closes this beach out,
// no matter how good everything else looks.
const WEIGHTS = { size: 0.28, wind: 0.26, shape: 0.16, tide: 0.20, period: 0.10 };

/**
 * One hour, fully scored.
 * @returns {{total:number, grade:string, parts:object, board:object, size:object}}
 */
export function scoreHour({ HbM, faceTypicalFt, faceSetFt, Tp, swellDirDeg, tideFt, tideRate, windKt, windDirDeg, powerKwPerM }) {
  const parts = {
    size: scoreSize(faceTypicalFt),
    wind: scoreWind(windKt, windDirDeg),
    shape: scoreShape(HbM, Tp, swellDirDeg),
    tide: scoreTide(tideFt, tideRate),
    period: scorePeriod(Tp),
  };
  let total = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) total += w * parts[k].score;

  // A weighted mean alone is far too forgiving: it will happily call a
  // knee-high day "good" because the wind and tide happen to be perfect.
  // Size sets a ceiling on how good the day can possibly be, and a single
  // ruinous factor caps it outright.
  const sizeCeiling = 0.15 + 0.85 * parts.size.score;
  const cap = Math.min(
    sizeCeiling,
    parts.wind.score < 0.25 ? 0.42 : 1,
    parts.size.score < 0.2 ? 0.30 : 1,
  );
  total = Math.min(total, cap);

  const board = boardCall(faceTypicalFt, parts.shape.xi, powerKwPerM);
  return {
    total: Math.round(total * 100),
    grade: gradeFor(total),
    parts, board,
    size: { faceTypicalFt, faceSetFt, label: sizeLabel(faceTypicalFt).label, setLabel: sizeLabel(faceSetFt).label },
  };
}

export function gradeFor(t) {
  if (t >= 0.88) return 'Epic';
  if (t >= 0.72) return 'Very good';
  if (t >= 0.56) return 'Good';
  if (t >= 0.40) return 'Fair';
  if (t >= 0.25) return 'Poor';
  return 'Flat / blown';
}

/** Is this hour inside the crew's window? */
export const inSessionWindow = (hourFloat) =>
  hourFloat >= SESSION_WINDOW.startHour && hourFloat <= SESSION_WINDOW.endHour;
