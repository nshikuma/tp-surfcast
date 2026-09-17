/**
 * Where the sand is, kept across passes.
 *
 * One satellite frame is one instant: a set breaking inshore of the bar, a
 * patch of cloud shadow, a rivermouth channel, and a single transect can say
 * something silly. The signal that matters is not in any one frame, it is in
 * what stays the same between them - the bar sits where it sits for weeks at a
 * time, and it is the WEEKS that this forecast has never been able to see.
 *
 * So each usable scene is reduced to a few numbers and appended to a record
 * that lives in the repository, and the readings people see are medians across
 * the beach rather than any single transect.
 *
 * THREE THINGS COME OUT OF IT, in the order the crew asked for.
 *
 *   SHAPE. A bar that runs dead straight breaks all at once, which is exactly
 *   the closeout the 16 September session ran into. A bar with rhythm in it -
 *   bulges and gaps every few hundred metres - has corners on it. That rhythm
 *   is visible from orbit as scatter in where the white water sits along the
 *   beach, once the overall trend of the coastline is taken out.
 *
 *   WHERE THE SAND IS. The distance from the shoreline out to the breaking is
 *   the surf-zone width, and how far out the bar sits says whether it is a
 *   summer bar close in or a winter bar pushed offshore.
 *
 *   HOW MUCH SAND. The shoreline position, which moves tens of metres between
 *   a summer berm and a winter scour. It has to be read against the tide at the
 *   moment of the overpass, because a low tide alone moves the waterline
 *   further than a season does.
 *
 * Nothing here is fed into the forecast yet, deliberately. The shelf
 * calibration set the precedent: measure first, accumulate enough to know the
 * spread, and only then let it argue with the model.
 */

/** Keep this many scene summaries, and this many with full transects. */
export const MAX_SCENES = 60;
export const MAX_DETAILED = 6;

/** Below this much scatter in the bar line, the bar is effectively straight. */
export const RHYTHMIC_SPREAD_M = 25;

const median = (xs) => {
  const v = xs.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** Median absolute deviation, which a couple of wild transects cannot move. */
const mad = (xs, centre) => {
  const m = centre ?? median(xs);
  if (m == null) return null;
  return median(xs.filter(Number.isFinite).map((x) => Math.abs(x - m)));
};

/** Least-squares line through (x, y), used to take the coastline's own trend out. */
function detrend(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([, y]) => Number.isFinite(y));
  if (pts.length < 4) return null;
  const n = pts.length;
  const sx = pts.reduce((a, [x]) => a + x, 0);
  const sy = pts.reduce((a, [, y]) => a + y, 0);
  const sxx = pts.reduce((a, [x]) => a + x * x, 0);
  const sxy = pts.reduce((a, [x, y]) => a + x * y, 0);
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept, residuals: pts.map(([x, y]) => y - (slope * x + intercept)) };
}

/**
 * Reduce one analysed scene to the numbers worth keeping.
 *
 * Transects are thrown out if their waterline is far from the rest: at ten
 * metres a pixel, a rivermouth channel or a lump of cloud shadow produces a
 * reading that is not wrong so much as about something else.
 */
export function summariseScene(analysis, { tideFt = null } = {}) {
  const all = analysis?.transects || [];
  if (!analysis?.looksLikeWater || all.length < 8) {
    return {
      sceneId: analysis?.sceneId ?? null,
      time: analysis?.time ?? null,
      usable: false,
      reason: !analysis?.looksLikeWater
        ? 'the outer transects are not dark in near-infrared, so this is not open water - cloud, haze, or a bad scene'
        : `only ${all.length} transects produced a waterline`,
    };
  }

  const wl = all.map((t) => t.waterlineM);
  const centre = median(wl);
  const spread = mad(wl, centre) || 10;
  const keep = all.filter((t) => Math.abs(t.waterlineM - centre) <= Math.max(30, 4 * spread));

  const alongshore = keep.map((t) => t.alongshoreM);
  const bars = keep.map((t) => t.foamPeakM);
  const fit = detrend(alongshore, bars);
  // The scatter left after the coastline's own trend is removed: this is the
  // rhythm in the bar, and it is the number that says corners or closeouts.
  const barSpreadM = fit ? mad(fit.residuals, 0) : null;

  return {
    sceneId: analysis.sceneId,
    time: analysis.time,
    usable: true,
    cloudPct: analysis.cloudPct,
    tideFt,
    transectsUsed: keep.length,
    transectsDropped: all.length - keep.length,
    waterlineM: round1(median(keep.map((t) => t.waterlineM))),
    barM: round1(median(bars)),
    // How far out it is breaking FROM THE WATER'S EDGE, taken transect by
    // transect and then medianed. Differencing two medians is not the same
    // number and is wrong wherever the beach is not uniform, which is the only
    // interesting case.
    barOffsetM: round1(median(keep.map((t) => (Number.isFinite(t.foamPeakM) ? t.foamPeakM - t.waterlineM : null)))),
    surfWidthM: round1(median(keep.map((t) => t.surfWidthM))),
    barSpreadM: round1(barSpreadM),
    rhythmic: barSpreadM != null ? barSpreadM >= RHYTHMIC_SPREAD_M : null,
    outerWaterNir: analysis.outerWaterNir,
    transects: keep.map((t) => ({
      alongshoreM: t.alongshoreM,
      waterlineM: t.waterlineM,
      barM: t.foamPeakM,
      surfWidthM: t.surfWidthM,
    })),
  };
}

/** Fold a scene summary into the stored record, newest last, without duplicates. */
export function accumulate(prev, summary) {
  const state = {
    version: 1,
    scenes: [...(prev?.scenes || [])],
    skipped: [...(prev?.skipped || [])],
    updatedAt: new Date().toISOString(),
  };
  // A rejected pass is worth recording. The first live run threw one away and
  // left a record that said only "no usable pass yet", which is indistinguishable
  // from the satellite never having come over - and the two call for completely
  // different responses.
  if (!summary?.usable) {
    if (summary?.sceneId && !state.skipped.some((x) => x.sceneId === summary.sceneId)) {
      state.skipped.push({ sceneId: summary.sceneId, time: summary.time, reason: summary.reason });
      state.skipped = state.skipped.slice(-12);
    }
    return state;
  }
  if (state.scenes.some((s) => s.sceneId === summary.sceneId)) return state;
  state.skipped = state.skipped.filter((x) => x.sceneId !== summary.sceneId);

  state.scenes.push(summary);
  state.scenes.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  if (state.scenes.length > MAX_SCENES) state.scenes = state.scenes.slice(-MAX_SCENES);
  // Full transects only for the newest few: a year of them would be megabytes
  // and nobody reads a transect from March.
  state.scenes = state.scenes.map((s, i) => (
    i < state.scenes.length - MAX_DETAILED ? { ...s, transects: undefined } : s
  ));
  return state;
}

/**
 * What to put in front of a person.
 *
 * The latest scene carries the picture; the record carries whether anything has
 * moved. A bar that has shifted thirty metres offshore since the last look is a
 * different beach, and it is the sort of thing that until now was only ever
 * discovered by paddling out.
 */
export function summarise(state) {
  const scenes = (state?.scenes || []).filter((s) => s.usable);
  const skipped = state?.skipped || [];
  const lastSkipped = skipped.length ? skipped[skipped.length - 1] : null;
  if (!scenes.length) {
    return {
      scenes: 0,
      skipped: skipped.length,
      lastSkipped,
      note: skipped.length
        ? `Nothing readable yet. ${skipped.length} pass${skipped.length === 1 ? ' has' : 'es have'} been looked at and thrown out - `
          + `the most recent because ${lastSkipped.reason}. Cloud and the morning marine layer take out a fair share of them.`
        : 'No satellite pass to read yet. Sentinel-2 comes over every day or two.',
    };
  }
  const latest = scenes[scenes.length - 1];
  const previous = scenes.length > 1 ? scenes[scenes.length - 2] : null;

  const recent = scenes.slice(-6);
  const barTrend = median(recent.map((s) => s.barM));
  const spreadTrend = median(recent.map((s) => s.barSpreadM));

  const shape = spreadTrend == null ? null
    : spreadTrend >= RHYTHMIC_SPREAD_M
      ? 'The breaking line has rhythm in it - bulges and gaps rather than one straight wall. That is the state that puts corners on it.'
      : 'The breaking line is running straight along the beach. A straight bar trips the whole wave at once, which is how closeouts happen here.';

  return {
    scenes: scenes.length,
    skipped: skipped.length,
    lastSkipped,
    latest,
    previous: previous ? { time: previous.time, barM: previous.barM, waterlineM: previous.waterlineM } : null,
    barMovedM: previous ? round1(latest.barM - previous.barM) : null,
    waterlineMovedM: previous ? round1(latest.waterlineM - previous.waterlineM) : null,
    barTrendM: round1(barTrend),
    barSpreadTrendM: round1(spreadTrend),
    shape,
    // Deliberately not feeding the forecast yet, and saying so.
    note: `Measured from ${scenes.length} satellite pass${scenes.length === 1 ? '' : 'es'}. `
      + 'This is shown, not used: nothing on this page is computed from it yet. '
      + 'It gets a vote once there are enough passes to know how much a reading jumps around.',
    history: scenes.map((s) => ({
      time: s.time, barM: s.barM, waterlineM: s.waterlineM,
      surfWidthM: s.surfWidthM, barSpreadM: s.barSpreadM, tideFt: s.tideFt,
    })),
  };
}

const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
