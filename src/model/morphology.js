/**
 * Beach state: what shape the sandbars are in, and therefore what the waves
 * will do on them.
 *
 * This is the distilled product of an enormous number of visual observations.
 * Wright & Short (1984) classified surf zones into six states from years of
 * daily observations of Australian beaches - photographs, sketches and notes of
 * how waves were actually breaking - and found that the state is predicted by a
 * single dimensionless number:
 *
 *     omega = Hb / (ws * T)
 *
 * breaker height over settling velocity times period. Masselink & Short (1993)
 * added a second axis for beaches where the tide range is large compared with
 * the waves, which is squarely this beach on a small day.
 *
 * WHY IT MATTERS HERE. The peel calculation needs to know how crooked the bank
 * is, and until now that was a hard-coded constant with a comment on it saying
 * no wave model knows this. A wave model does not, but a MORPHOLOGICAL model
 * does: a longshore bar-trough state is a straight continuous bar and closes
 * out; a transverse bar and rip state is all corners and channels. That is the
 * difference between "makeable" and "walled and broke", which is the call this
 * page got wrong on 2026-09-16.
 *
 * THE STATE IS NOT TODAY'S WAVES. Sandbars respond over days and weeks, not
 * hours, so omega is accumulated over a fortnight with recent days weighted
 * more heavily. Today's waves decide how a wave breaks; the last fortnight
 * decides what it breaks on.
 */

import { CALIBRATION } from '../config.js';

/**
 * Settling velocity of a sand grain, Ferguson & Church (2004).
 *
 * Computed rather than tabulated so the grain size stays the tunable, which is
 * the number somebody could actually go and measure with a sieve.
 *
 * @param {number} d50mm  median grain diameter, millimetres
 */
export function settlingVelocity(d50mm = CALIBRATION.sand.d50mm) {
  const D = d50mm / 1000;                 // metres
  const R = 1.65;                         // submerged specific gravity of quartz
  const g = 9.81;
  const nu = 1e-6;                        // kinematic viscosity of seawater, m^2/s
  const C1 = 18, C2 = 1.0;                // natural, slightly angular grains
  return (R * g * D * D) / (C1 * nu + Math.sqrt(0.75 * C2 * R * g * D * D * D));
}

/** Dimensionless fall velocity, the Dean number. */
export function dimensionlessFallVelocity(HbM, periodS, ws = settlingVelocity()) {
  if (!(HbM > 0) || !(periodS > 0) || !(ws > 0)) return null;
  return HbM / (ws * periodS);
}

/**
 * The six states, from reflective through the intermediate sequence to
 * dissipative. `skewDeg` is how far off shore-parallel the bank sits, which is
 * what decides whether a wave peels or shuts down, and is the whole reason this
 * module exists.
 */
export const STATES = {
  reflective: {
    id: 'reflective', order: 1, label: 'Reflective',
    bars: 'No bar. Steep beach face, waves break right on the sand.',
    waves: 'Shorebreak. Sucks dry, breaks hard in inches of water, almost nothing to ride.',
    skewDeg: 6, ripSpacingM: null, closeoutProne: true,
  },
  lowTideTerrace: {
    id: 'lowTideTerrace', order: 2, label: 'Low tide terrace',
    bars: 'A flat terrace welded to the beach, exposed at low tide.',
    waves: 'Plunging on the terrace edge, quick and shallow. Better with water on it; shuts down hard on a low tide.',
    skewDeg: 10, ripSpacingM: null, closeoutProne: true,
  },
  transverseBarRip: {
    id: 'transverseBarRip', order: 3, label: 'Transverse bar and rip',
    bars: 'Bars running out from the beach at an angle, with rip channels between them.',
    waves: 'The good one. Defined peaks over each bar, corners either side, channels to paddle out through.',
    skewDeg: 24, ripSpacingM: 150, closeoutProne: false,
  },
  rhythmicBarBeach: {
    id: 'rhythmicBarBeach', order: 4, label: 'Rhythmic bar and beach',
    bars: 'A crescentic bar, further out, still with a rhythm to it.',
    waves: 'Peaks on the crescents with makeable shoulders, deeper spots between. Reads well from the sand.',
    skewDeg: 16, ripSpacingM: 250, closeoutProne: false,
  },
  longshoreBarTrough: {
    id: 'longshoreBarTrough', order: 5, label: 'Longshore bar and trough',
    bars: 'One straight continuous bar parallel to the beach, with a trough inside it.',
    waves: 'Walls. The bar is straight so the whole line trips at once - long closeouts on the bar, then reform in the trough.',
    skewDeg: 5, ripSpacingM: 400, closeoutProne: true,
  },
  dissipative: {
    id: 'dissipative', order: 6, label: 'Dissipative',
    bars: 'Multiple flat bars, very gentle slope, wide surf zone.',
    waves: 'Spilling and gutless. Breaks a long way out and crumbles all the way in.',
    skewDeg: 8, ripSpacingM: 500, closeoutProne: false,
  },
  // Masselink & Short's tide-modified end: a big tide range against small waves.
  tideModified: {
    id: 'tideModified', order: 2.5, label: 'Tide-modified terrace',
    bars: 'A low-tide bar or terrace that the tide drags the break across all morning.',
    waves: 'A different wave every two hours. Works for a window and shuts down either side of it.',
    skewDeg: 12, ripSpacingM: 200, closeoutProne: false,
  },
  ultraDissipative: {
    id: 'ultraDissipative', order: 6.5, label: 'Tide-dominated flats',
    bars: 'Tide range swamps the waves entirely. Wide, flat, featureless.',
    waves: 'Barely surf.',
    skewDeg: 6, ripSpacingM: null, closeoutProne: false,
  },
};

/**
 * Classify from the two dimensionless numbers.
 *
 * @param {number} omega  Hb / (ws * T), accumulated over the last fortnight
 * @param {number} rtr    relative tide range, tide range / breaker height
 */
export function classify(omega, rtr) {
  if (!Number.isFinite(omega)) return null;

  // Masselink & Short: once the tide range is several times the wave height,
  // the tide moves the break across the profile faster than the waves can build
  // a bar, and the wave-dominated sequence stops applying. Torrey Pines crosses
  // this line on any small day - a 1.7 m spring range against a 0.4 m breaker
  // is an RTR over 4.
  if (Number.isFinite(rtr)) {
    if (rtr > 7) return { ...STATES.ultraDissipative, omega, rtr, regime: 'tide-dominated' };
    if (rtr > 3) return { ...STATES.tideModified, omega, rtr, regime: 'tide-modified' };
  }

  const s = omega < 1.5 ? STATES.reflective
    : omega < 2.4 ? STATES.lowTideTerrace
      : omega < 3.4 ? STATES.transverseBarRip
        : omega < 4.7 ? STATES.rhythmicBarBeach
          : omega < 6.0 ? STATES.longshoreBarTrough
            : STATES.dissipative;
  return { ...s, omega, rtr: Number.isFinite(rtr) ? rtr : null, regime: 'wave-dominated' };
}

/**
 * The state the beach is actually in, from the recent wave record.
 *
 * Bars integrate weeks of forcing, so this weights the last fortnight with an
 * exponential decay: a swell three days ago matters much more than one from
 * twelve days ago, but neither is ignored. Using today's waves alone would have
 * the beach flipping state every time a pulse arrived, which is not a thing
 * sand does.
 *
 * @param {Array} hours      hourly records with HbM (or faceFt) and periodS
 * @param {number} tideRangeM  observed tide range over the same window
 */
export function morphologyFrom(hours, tideRangeM, { halfLifeDays = 4, windowDays = 14 } = {}) {
  const ws = settlingVelocity();
  const now = Date.now();
  const cutoff = now - windowDays * 24 * 36e5;

  let wSum = 0, oSum = 0, hSum = 0, n = 0;
  for (const h of hours || []) {
    const t = Date.parse(h.time);
    if (!Number.isFinite(t) || t > now || t < cutoff) continue;
    const HbM = Number.isFinite(h.HbM) ? h.HbM
      : Number.isFinite(h.faceFt) ? h.faceFt / 3.28084 / CALIBRATION.faceFactor : null;
    const om = dimensionlessFallVelocity(HbM, h.periodS, ws);
    if (om == null) continue;
    const ageDays = (now - t) / (24 * 36e5);
    // Energy-weighted as well as time-weighted: a fortnight of knee-high does
    // less to a sandbar than one day of overhead, and the bars know it.
    const w = Math.pow(0.5, ageDays / halfLifeDays) * Math.max(0.05, HbM * HbM);
    wSum += w; oSum += om * w; hSum += HbM * w; n++;
  }
  if (!n || !(wSum > 0)) return null;

  const omega = oSum / wSum;
  const meanHbM = hSum / wSum;
  const rtr = Number.isFinite(tideRangeM) && meanHbM > 0 ? tideRangeM / meanHbM : null;
  const state = classify(omega, rtr);
  if (!state) return null;

  return {
    ...state,
    omega: round2(omega),
    rtr: rtr == null ? null : round2(rtr),
    meanBreakerM: round2(meanHbM),
    settlingVelocityMs: round3(ws),
    d50mm: CALIBRATION.sand.d50mm,
    samples: n,
    windowDays,
    summary: `${state.label}. ${state.bars}`,
    note: 'Wright & Short (1984) beach-state classification, with the Masselink & Short (1993) '
      + 'tide-modified extension. Derived from the last fortnight of breaker height and period, '
      + 'not from today - sandbars respond over weeks. It is a statistical expectation from a very '
      + 'large body of field observation, not a picture of this particular sandbar.',
  };
}

/**
 * Accumulate omega across runs, the way the sand actually integrates it.
 *
 * A single run only holds a couple of days of measurement, and a sandbar has a
 * memory of weeks, so this keeps an exponentially-weighted running mean that
 * decays with REAL elapsed time and survives between runs. Weighted by energy
 * as well as by age: a fortnight of knee-high does less to a bar than one day
 * of overhead, and the bars know it.
 *
 * @param {object|null} prev        previous persisted state
 * @param {Array} records           buoy records {time, hsM, tpS}, measured
 * @param {object} opts
 */
export function stepMorphology(prev, records, { from = null, halfLifeDays = 4, shelfLoss = CALIBRATION.shelfLoss } = {}) {
  const ws = settlingVelocity();
  let wSum = prev?.wSum ?? 0;
  let owSum = prev?.owSum ?? 0;
  let hwSum = prev?.hwSum ?? 0;
  let last = from ? Date.parse(from) : null;
  let used = 0;

  for (const r of (records || []).slice().sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) {
    const t = Date.parse(r.time);
    if (!Number.isFinite(t)) continue;
    if (last != null && t <= last) continue;
    if (!(r.hsM > 0) || !(r.tpS > 0)) continue;

    // Decay what is already there by the real gap since the last sample, so a
    // build outage leaves a hole rather than a distortion.
    if (last != null) {
      const gapDays = Math.min(30, (t - last) / (24 * 36e5));
      const lambda = Math.pow(0.5, gapDays / halfLifeDays);
      wSum *= lambda; owSum *= lambda; hwSum *= lambda;
    }

    // Deep-water Hs carried to a nominal breaker height. The classification
    // wants BREAKER height, not what the buoy reads eight miles out.
    const HbM = r.hsM * shelfLoss;
    const om = dimensionlessFallVelocity(HbM, r.tpS, ws);
    if (om == null) { last = t; continue; }
    const w = Math.max(0.02, HbM * HbM);
    wSum += w; owSum += om * w; hwSum += HbM * w;
    last = t; used++;
  }

  return {
    version: 1,
    wSum, owSum, hwSum,
    updatedAt: last ? new Date(last).toISOString() : (prev?.updatedAt ?? null),
    samples: (prev?.samples ?? 0) + used,
    newThisRun: used,
    omega: wSum > 0 ? owSum / wSum : null,
    meanBreakerM: wSum > 0 ? hwSum / wSum : null,
  };
}

/** Turn the accumulated state into a classified beach state. */
export function stateFrom(acc, tideRangeM) {
  if (!acc || !Number.isFinite(acc.omega)) return null;
  const rtr = Number.isFinite(tideRangeM) && acc.meanBreakerM > 0 ? tideRangeM / acc.meanBreakerM : null;
  const state = classify(acc.omega, rtr);
  if (!state) return null;
  return {
    ...state,
    omega: round2(acc.omega),
    rtr: rtr == null ? null : round2(rtr),
    meanBreakerM: round2(acc.meanBreakerM),
    tideRangeM: round2(tideRangeM),
    settlingVelocityMs: round3(settlingVelocity()),
    d50mm: CALIBRATION.sand.d50mm,
    samples: acc.samples,
    // Four-day half-life, so a fortnight is roughly when the weight runs out.
    spunUp: acc.samples >= 300,
    summary: `${state.label}. ${state.bars}`,
    note: 'Wright & Short (1984) beach-state classification with the Masselink & Short (1993) '
      + 'tide-modified extension - the distilled result of years of daily visual observations of '
      + 'how waves break on sandbars. Driven here by an energy-weighted running mean of measured '
      + 'buoy conditions with a four-day half-life, because bars respond over weeks rather than '
      + 'hours. It is a statistical expectation, not a picture of this particular sandbar.',
  };
}

/** The tide range actually observed over the window, rather than an assumed one. */
export function observedTideRangeM(hours, { windowDays = 14 } = {}) {
  const cutoff = Date.now() - windowDays * 24 * 36e5;
  const vals = (hours || [])
    .filter((h) => Date.parse(h.time) >= cutoff && Number.isFinite(h.tideFt))
    .map((h) => h.tideFt);
  if (vals.length < 24) return null;
  return (Math.max(...vals) - Math.min(...vals)) * 0.3048;
}

const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
