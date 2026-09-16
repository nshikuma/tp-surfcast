/**
 * What the swell is MADE OF, and what that mix will look like at the north lot.
 *
 * This is the part of Torrey Pines that a single wave height cannot describe.
 * "3 ft at 11 seconds" is three completely different mornings depending on
 * whether it is a clean 16s south, a 14s northwest wrapping in, or 3 ft of 8s
 * windswell - and most of the time it is two of those on top of each other.
 * A combined significant height averages that distinction away, which is
 * exactly the information you need to decide whether to bother.
 *
 * So: classify every swell train the model publishes, carry each one to
 * breaking separately, and report how much of the wave each is responsible for.
 * Shares are ENERGY shares (height squared), because that is what actually adds
 * when two swells overlap - two equal 2 ft trains make a 2.8 ft wave, not a 4 ft
 * one, and each is 50% of it.
 */

import { SITE } from '../config.js';
import { transformToBreak, faceHeights, angleDiff } from './waves.js';

/**
 * A groundswell has travelled far enough to sort itself into clean, evenly
 * spaced lines. A windswell is still being made by the wind that is on it.
 * Twelve seconds is the usual dividing line on this coast: a 14s WNW in
 * February and an 11s WNW in February are not the same swell.
 */
/**
 * The groundswell line is NOT a single period. Where a swell can have come from
 * decides how long it has had to sort itself out.
 *
 * Nothing local makes a long south swell. The fetch that generates south swell
 * here is thousands of miles away in the Southern Hemisphere or off a Baja
 * hurricane, so anything arriving from the south quadrant at ten seconds or
 * more has already done the travelling and turned up as clean forward-marching
 * lines. The western fetch is different: a wind blowing across the Bight can
 * raise an eleven-second WNW sea a hundred miles offshore and have it here the
 * same afternoon, still lumpy.
 *
 * A single twelve-second cutoff gets the west about right and the south badly
 * wrong - it files an 11.7s SSW groundswell as local windswell, which is the
 * opposite of what it is.
 */
export const GROUNDSWELL_PERIOD_S = { south: 10, west: 12 };

/**
 * Below this, it is surface chop rather than surf. A five-second wave has a
 * deep-water wavelength of about 40 m: it barely feels the bottom, carries no
 * push, and you cannot ride it. It still shows up in a model's wind-wave
 * partition carrying real energy, which is how a "3 ft" forecast turns out to
 * be a textured flat day. Chop is reported separately rather than counted as
 * part of the surf.
 */
export const CHOP_PERIOD_S = 6;

/**
 * South of this bearing is a southern-hemisphere / hurricane angle. Set at 240
 * rather than due-WSW: a swell arriving from 245 has come across the Pacific,
 * not up from the Southern Ocean, and behaves like a west swell here.
 */
const SOUTH_MAX_DEG = 240;

/**
 * Two partitions within this of each other are one swell that the model split
 * in two. Without this, a 12.1s SSW and an 11.9s SSW get reported as a
 * groundswell "crossing" a windswell, which is both wrong and alarming.
 */
const SAME_SWELL_PERIOD_S = 2.0;
const SAME_SWELL_DIR_DEG = 25;

export const CLASSES = {
  southGround: {
    id: 'southGround',
    label: 'South swell',
    short: 'South',
    phrase: 'south swell',
    blurb: 'Southern-hemisphere or Baja hurricane swell, arriving well sorted. Refracts hard around Point Loma, so it favours one end of the beach.',
  },
  westGround: {
    id: 'westGround',
    label: 'W/NW swell',
    short: 'W-NW',
    phrase: 'west-northwest swell',
    blurb: 'North Pacific groundswell. Straight into the beach, more push per foot, breaks further out.',
  },
  windswell: {
    id: 'windswell',
    label: 'Windswell',
    short: 'Windswell',
    phrase: 'short-period windswell',
    blurb: 'Raised by wind inside the Bight and still lumpy. Closes out on a low tide and needs water on the bar to stay rideable.',
  },
};

export const CLASS_ORDER = ['southGround', 'westGround', 'windswell'];

/**
 * The groundswell boundary is genuinely fuzzy, so treating it as a knife edge
 * produces a sawtooth: a second train wobbling between 9.4s and 10.6s flips
 * class every hour and the chart alternates between two stories. A train within
 * this many seconds of the boundary has its energy SPLIT across both classes in
 * proportion to how far over it sits.
 */
const CLASS_FADE_S = 1.5;

/**
 * How a train's energy divides between classes. Returns weights summing to 1.
 * @param {{periodS:number, dirDeg:number}} train
 */
export function classWeights(train) {
  const T = train.periodS ?? 0;
  const dir = train.dirDeg ?? SITE.shoreNormalDeg;
  const fromSouth = dir < SOUTH_MAX_DEG;
  const threshold = fromSouth ? GROUNDSWELL_PERIOD_S.south : GROUNDSWELL_PERIOD_S.west;
  const ground = fromSouth ? 'southGround' : 'westGround';
  const f = Math.max(0, Math.min(1, (T - (threshold - CLASS_FADE_S)) / (2 * CLASS_FADE_S)));
  if (f >= 1) return { [ground]: 1 };
  if (f <= 0) return { windswell: 1 };
  return { [ground]: f, windswell: 1 - f };
}

/** The single label for a train, for naming it in prose. */
export function classifyTrain(train) {
  const T = train.periodS ?? 0;
  const dir = train.dirDeg ?? SITE.shoreNormalDeg;
  const fromSouth = dir < SOUTH_MAX_DEG;
  const threshold = fromSouth ? GROUNDSWELL_PERIOD_S.south : GROUNDSWELL_PERIOD_S.west;
  if (T < threshold) return 'windswell';
  return fromSouth ? 'southGround' : 'westGround';
}

/**
 * Carry each train to breaking on its own and split the hour's face height
 * between them by energy.
 *
 * The parts are normalised onto the hour's published face height rather than
 * replacing it. The ensemble that produces `faceFt` is better calibrated than
 * any single partitioned field, so the mix decides the SPLIT and the ensemble
 * keeps deciding the SIZE. If the two disagree the ensemble wins, which is the
 * conservative choice.
 *
 * @param {{trains?: Array, faceFt?: number}} hour
 * @returns {null|{parts: Array, dominant: string, dominantShare: number,
 *                 crossing: boolean, trainCount: number}}
 */
export function mixForHour(hour) {
  const all = (hour?.trains || []).filter((t) => t.hsM > 0 && t.periodS > 0);
  if (!all.length) return null;

  // Surface chop is not surf. Pull it out before anything else so it cannot
  // dominate the energy share of a day that has nothing rideable in it.
  const chop = all.filter((t) => t.periodS < CHOP_PERIOD_S);
  const trains = mergeSameSwell(all.filter((t) => t.periodS >= CHOP_PERIOD_S));
  const chopFt = chop.length
    ? Math.sqrt(chop.reduce((a, t) => a + (t.hsFt ?? 0) ** 2, 0)) : 0;
  if (!trains.length) {
    return {
      parts: [], dominant: null, dominantShare: 0, crossing: false,
      trainCount: 0, chopFt: round1(chopFt), allChop: true,
    };
  }

  const carried = trains.map((t) => {
    const br = transformToBreak(t.hsM, t.periodS, t.dirDeg, { origin: 'model' });
    const face = br.blocked ? 0 : faceHeights(br.Hb).typicalFt;
    return {
      weights: classWeights(t),
      periodS: t.periodS,
      dirDeg: t.dirDeg,
      dirCompass: t.dirCompass,
      deepFt: t.hsFt,
      faceFt: face,
      energy: face * face,
      // How square-on it hits. A swell arriving 40 degrees off the beach
      // refracts hard and loses most of what it looked like offshore.
      offAngleDeg: Math.abs(angleDiff(t.dirDeg, SITE.shoreNormalDeg)),
    };
  });

  const totalEnergy = carried.reduce((s, c) => s + c.energy, 0);
  if (!(totalEnergy > 0)) return null;

  // Rescale so the parts reconstruct the ensemble's face height in RSS.
  const targetFace = hour.faceFt ?? Math.sqrt(totalEnergy);
  const k = targetFace / Math.sqrt(totalEnergy);

  // Sum energy within each class; the class inherits the period and direction
  // of its single biggest train, because that is the one you will notice.
  const byClass = new Map();
  for (const c of carried) {
    const scaledEnergy = (c.faceFt * k) ** 2;
    for (const [cls, w] of Object.entries(c.weights)) {
      if (!(w > 0)) continue;
      let entry = byClass.get(cls);
      if (!entry) {
        entry = { cls, energy: 0, faceFt: 0, leadEnergy: -1 };
        byClass.set(cls, entry);
      }
      entry.energy += scaledEnergy * w;
      entry.faceFt = Math.sqrt(entry.energy);
      if (scaledEnergy * w > entry.leadEnergy) {
        entry.leadEnergy = scaledEnergy * w;
        entry.periodS = c.periodS;
        entry.dirDeg = c.dirDeg;
        entry.dirCompass = c.dirCompass;
        entry.offAngleDeg = c.offAngleDeg;
      }
    }
  }

  const scaledTotal = [...byClass.values()].reduce((s, e) => s + e.energy, 0);
  const parts = CLASS_ORDER
    .filter((id) => byClass.has(id))
    .map((id) => {
      const e = byClass.get(id);
      return {
        cls: id,
        faceFt: round1(e.faceFt),
        share: scaledTotal > 0 ? e.energy / scaledTotal : 0,
        periodS: round1(e.periodS),
        dirDeg: Math.round(e.dirDeg),
        dirCompass: e.dirCompass,
        offAngleDeg: Math.round(e.offAngleDeg),
      };
    })
    .sort((a, b) => b.share - a.share);

  const dominant = parts[0];
  // Two trains of comparable size from different angles: the crossed-up,
  // hard-to-read sea that makes this beach frustrating.
  const crossing = parts.length > 1 && parts[1].share >= 0.28
    && Math.abs(angleDiff(parts[0].dirDeg, parts[1].dirDeg)) >= 25;

  return {
    parts,
    dominant: dominant.cls,
    dominantShare: dominant.share,
    crossing,
    trainCount: trains.length,
    chopFt: round1(chopFt),
    allChop: false,
  };
}

/**
 * Combine partitions that are really the same swell. Models routinely split one
 * swell system across "primary" and "secondary" when its spectrum is broad, and
 * a naive reading turns that into two swells fighting each other.
 */
function mergeSameSwell(trains) {
  const out = [];
  for (const t of [...trains].sort((a, b) => b.hsM - a.hsM)) {
    const twin = out.find((o) => Math.abs(o.periodS - t.periodS) <= SAME_SWELL_PERIOD_S
      && Math.abs(angleDiff(o.dirDeg, t.dirDeg)) <= SAME_SWELL_DIR_DEG);
    if (twin) {
      // Energies add; the bigger partition keeps the period and direction.
      const hsM = Math.hypot(twin.hsM, t.hsM);
      twin.hsFt = (twin.hsFt ?? 0) * (hsM / twin.hsM);
      twin.hsM = hsM;
    } else {
      out.push({ ...t });
    }
  }
  return out;
}

/**
 * The tide that this particular mix wants.
 *
 * Long-period swell stands up on the outer bar and can handle - often prefers -
 * less water. Short-period windswell has no reach: it runs straight over the bar
 * and dumps on the inside unless there is water on it. Treating every day's
 * ideal tide as the same band is one of the reasons a generic forecast is wrong
 * here so often.
 *
 * Returns a shift in feet to apply to the tide sweet spot, and the reason.
 */
export function tideShiftFor(periodS, dominantClass) {
  if (!(periodS > 0)) return { shiftFt: 0, note: null };
  if (dominantClass === 'windswell' || periodS < 10) {
    return {
      shiftFt: 0.7,
      note: 'Short-period swell needs water on the bar - this wants the higher end of the tide.',
    };
  }
  if (periodS >= 15) {
    return {
      shiftFt: -0.6,
      note: 'Long-period swell will stand up on the outer bar - it can take a lower tide than usual.',
    };
  }
  return { shiftFt: 0, note: null };
}

/**
 * Roll the hourly mixes up to a day, and say in one line what that mix will
 * look like from the sand. This is the sentence the crew actually reads.
 */
export function mixForDay(hours) {
  // Reuse the hour's already-smoothed mix when the caller has attached one, so
  // the daily read and the hourly chart can never tell different stories.
  const mixes = hours.map((h) => ({ h, m: h.mix || mixForHour(h) })).filter((r) => r.m);
  if (!mixes.length) return null;

  // Energy-weight the shares by each hour's face height, so the mix reflects
  // the part of the day that has waves in it.
  const acc = new Map(CLASS_ORDER.map((id) => [id, 0]));
  const meta = new Map();
  let weightSum = 0;
  let chopFt = 0;
  for (const { h, m } of mixes) {
    chopFt = Math.max(chopFt, m.chopFt || 0);
    if (!m.parts.length) continue;
    const w = Math.max(0.05, (h.faceFt ?? 0) ** 2);
    weightSum += w;
    for (const p of m.parts) {
      acc.set(p.cls, acc.get(p.cls) + p.share * w);
      const prev = meta.get(p.cls);
      if (!prev || p.faceFt > prev.faceFt) meta.set(p.cls, p);
    }
  }
  if (!weightSum) {
    return {
      parts: [], dominant: null, dominantShare: 0, crossing: false,
      chopFt: round1(chopFt), tideShiftFt: 0, tideNote: null,
      read: `Nothing but ${round1(chopFt)} ft of short-period surface chop - no organised swell in the water.`,
      look: 'Textured flat. The only thing moving is the wind on the surface.',
    };
  }

  let parts = CLASS_ORDER
    .filter((id) => acc.get(id) > 0)
    .map((id) => ({
      cls: id,
      share: acc.get(id) / weightSum,
      peakFaceFt: meta.get(id).faceFt,
      periodS: meta.get(id).periodS,
      dirCompass: meta.get(id).dirCompass,
      dirDeg: meta.get(id).dirDeg,
      offAngleDeg: meta.get(id).offAngleDeg,
    }))
    .filter((p) => p.share >= 0.04)
    .sort((a, b) => b.share - a.share);

  if (!parts.length) return null;

  // One more pass at the same-swell problem, this time across the day. The
  // groundswell/windswell line sits at twelve seconds, and a swell sitting on
  // that line wobbles over it hour to hour: the same SSW pulse reads 11.9s at
  // dawn and 12.1s at noon, and the rollup reports it as two swells fighting
  // each other. If two classes share a period and a direction, they are one
  // swell, and it belongs to whichever class held most of the energy.
  parts = mergeDayParts(parts);

  const crossingHours = mixes.filter((r) => r.m.crossing).length;
  const crossing = crossingHours >= mixes.length / 2;
  const dom = parts[0];
  const tide = tideShiftFor(dom.periodS, dom.cls);

  return {
    parts,
    dominant: dom.cls,
    dominantShare: dom.share,
    crossing,
    chopFt: round1(chopFt),
    tideShiftFt: tide.shiftFt,
    tideNote: tide.note,
    read: readFor(parts, crossing, chopFt),
    look: lookFor(parts, crossing, chopFt),
  };
}

/** One line: what this mix IS. */
function readFor(parts, crossing, chopFt = 0) {
  const dom = parts[0];
  const pct = Math.round(dom.share * 100);
  const name = CLASSES[dom.cls].phrase;
  const chop = chopFt >= 0.8 ? ` Plus ${chopFt} ft of sub-6s chop on the surface, which is texture, not surf.` : '';

  if (dom.share >= 0.8) {
    return `Almost all ${name} - ${pct}% of the energy, ${dom.periodS}s from the ${dom.dirCompass}.${chop}`;
  }
  if (crossing && parts.length > 1) {
    const b = parts[1];
    return `Two swells crossing: ${pct}% ${name} (${dom.periodS}s ${dom.dirCompass}) `
      + `against ${Math.round(b.share * 100)}% ${CLASSES[b.cls].phrase} `
      + `(${b.periodS}s ${b.dirCompass}).${chop}`;
  }
  const rest = parts.slice(1)
    .map((p) => `${Math.round(p.share * 100)}% ${CLASSES[p.cls].phrase}`)
    .join(', ');
  return `Mostly ${name} at ${pct}% (${dom.periodS}s ${dom.dirCompass})${rest ? `, with ${rest}` : ''}.${chop}`;
}

/** One line: what that will LOOK like from the sand. The part you can't get
 *  from a number, and the reason a webcam beats a forecast for today. */
function lookFor(parts, crossing, chopFt = 0) {
  const dom = parts[0];
  const wind = parts.find((p) => p.cls === 'windswell');
  const windShare = wind ? wind.share : 0;

  if (windShare >= 0.75) {
    return 'Expect it to look busy and disorganised - waves every few seconds, '
      + 'short walls, plenty of closeouts. Take the volume.';
  }
  if (crossing) {
    return 'Crossed-up and hard to read: wedging peaks where the two swells meet, '
      + 'then flat spots. Good for a wave-count session, bad for picking off set waves.';
  }
  // "Real gaps between sets" is a promise a twelve-second swell cannot keep.
  const rhythm = dom.periodS >= 15 ? `long ${dom.periodS}s lines with proper gaps between sets`
    : dom.periodS >= 12 ? `organised ${dom.periodS}s lines in recognisable sets`
      : `${dom.periodS}s lines - organised, but rolling through steadily rather than in distinct sets`;

  if (dom.cls === 'southGround' && windShare < 0.3) {
    return `Clean ${rhythm}. `
      + (dom.offAngleDeg > 30
        ? `It arrives ${dom.offAngleDeg}° off the beach, so it refracts down hard on the way in and will favour one end of the sand.`
        : 'Angled nicely into the bars - the peaks should hold a shoulder.');
  }
  if (dom.cls === 'westGround' && windShare < 0.3) {
    return `Straight-in west swell: ${rhythm}, more push per foot than the number looks, breaking further out.`;
  }
  if (windShare >= 0.2) {
    return `${dom.periodS}s ${CLASSES[dom.cls].phrase} with ${Math.round(windShare * 100)}% windswell `
      + 'sitting on top of it - the sets will be organised, the waves between them will not be.';
  }
  return 'A mixed sea without one train in charge - inconsistent, and worth a look at the cam before you commit.';
}

/**
 * Smooth the class shares along the hourly series.
 *
 * The partitioned swell fields are published every three hours and interpolated
 * onto an hourly grid, so a single hour can come back carrying one train where
 * its neighbours carry two. That reads as the south swell vanishing for sixty
 * minutes and the windswell taking the whole sea, which is not something an
 * ocean does. The SIZE is left alone - that comes from the ensemble and is
 * properly hourly - and only the split between classes is averaged, over a
 * three-hour centred window.
 *
 * @param {Array<{time:string, mix:object}>} hours  mutated in place
 */
export function smoothShares(hours, halfWindow = 1) {
  const src = hours.map((h) => {
    const out = new Map(CLASS_ORDER.map((id) => [id, 0]));
    for (const p of h.mix?.parts || []) out.set(p.cls, p.share);
    return out;
  });
  hours.forEach((h, i) => {
    if (!h.mix?.parts?.length) return;
    const acc = new Map(CLASS_ORDER.map((id) => [id, 0]));
    let n = 0;
    for (let j = i - halfWindow; j <= i + halfWindow; j++) {
      if (j < 0 || j >= hours.length || !hours[j].mix?.parts?.length) continue;
      for (const id of CLASS_ORDER) acc.set(id, acc.get(id) + src[j].get(id));
      n++;
    }
    if (!n) return;
    const total = CLASS_ORDER.reduce((a, id) => a + acc.get(id), 0) || 1;
    h.mix.parts = CLASS_ORDER
      .map((id) => {
        const share = acc.get(id) / total;
        const was = h.mix.parts.find((q) => q.cls === id);
        // A class the neighbours have but this hour does not still needs a
        // period and direction to label itself with; borrow the nearest.
        const near = was || nearestPart(hours, i, id);
        return share > 0.01 && near ? { ...near, share } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.share - a.share);
    h.mix.dominant = h.mix.parts[0]?.cls ?? null;
    h.mix.dominantShare = h.mix.parts[0]?.share ?? 0;
  });
  return hours;
}

function nearestPart(hours, i, cls) {
  for (let d = 1; d < 6; d++) {
    for (const j of [i - d, i + d]) {
      if (j < 0 || j >= hours.length) continue;
      const p = (hours[j].mix?.parts || []).find((q) => q.cls === cls);
      if (p) return p;
    }
  }
  return null;
}

function mergeDayParts(parts) {
  const out = [];
  for (const p of parts) {
    const twin = out.find((o) => Math.abs(o.periodS - p.periodS) <= SAME_SWELL_PERIOD_S
      && Math.abs(angleDiff(o.dirDeg, p.dirDeg)) <= SAME_SWELL_DIR_DEG);
    if (twin) {
      twin.share += p.share;
      twin.peakFaceFt = Math.round(Math.hypot(twin.peakFaceFt, p.peakFaceFt) * 10) / 10;
      // The merged swell is classified on its own period and direction, not on
      // whichever half happened to carry more energy.
      twin.cls = classifyTrain(twin);
    } else {
      out.push({ ...p });
    }
  }
  return out.sort((a, b) => b.share - a.share);
}

function round1(x) { return x == null ? null : Math.round(x * 10) / 10; }
