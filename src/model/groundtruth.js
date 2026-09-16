/**
 * Grading the forecast against sessions the crew actually surfed.
 *
 * The skill panel already grades this model against the buoy, which is a fair
 * test of the swell and no test at all of the surf. The buoy cannot tell you
 * whether the wave had a shoulder on it or where the sand was. Only somebody
 * who paddled out can, and this is where those reports get turned into numbers.
 *
 * The distinction that matters here is TYPICAL versus SET. The model has always
 * been graded on the typical wave, which it is decent at; the set wave is the
 * one people actually decide on and the one it was worst at. On 2026-09-16 it
 * had the typical size within half a foot and the sets out by a factor of two.
 * Reporting one error where there are two hides that completely.
 */

/** Ratio of what happened to what was forecast, clamped so one wild session
 *  cannot dominate a small sample. */
const clampRatio = (r) => Math.max(0.3, Math.min(3.5, r));

/**
 * @param {Array} sessions   from src/data/observations.json
 * @param {Array} hourly     the hours this run produced
 * @param {Array} archives   previous runs, newest first
 */
export function gradeSessions(sessions, hourly, archives = []) {
  const graded = [];

  for (const s of sessions || []) {
    const forecast = forecastFor(s, hourly, archives);
    if (!forecast) {
      graded.push({ ...summarise(s), matched: false, note: 'No archived forecast covers this session yet.' });
      continue;
    }
    // Archives written before a field existed cannot supply it. Where the
    // session itself recorded what the page said at the time, that hand-written
    // note is the better evidence - it is a fact about what was on screen, not
    // a reconstruction - and it is labelled so nobody mistakes it for the
    // archive talking.
    const said = s.modelSaidAtTheTime || {};
    const fill = (fromArchive, fromNote) => (
      Number.isFinite(fromArchive) ? { v: fromArchive, recorded: false }
        : Number.isFinite(fromNote) ? { v: fromNote, recorded: true }
          : { v: null, recorded: false });
    const typ = fill(forecast.typicalFt, said.typicalFt);
    const set = fill(forecast.setFt, said.setFt);
    if (set.recorded) { forecast.setFt = set.v; forecast.setFromNote = true; }
    if (typ.recorded) { forecast.typicalFt = typ.v; forecast.typicalFromNote = true; }

    const typicalRatio = s.typicalFt > 0 && typ.v > 0
      ? clampRatio(s.typicalFt / typ.v) : null;
    const setRatio = s.setFt > 0 && set.v > 0
      ? clampRatio(s.setFt / set.v) : null;

    // Shape is graded as a yes/no: did we say it would be rideable, and was it?
    if (forecast.makeable == null && typeof said.makeable === 'boolean') {
      forecast.makeable = said.makeable;
      forecast.makeableFromNote = true;
    }
    const shapeSaid = forecast.makeable;
    const shapeWas = s.makeable;
    const shapeRight = shapeSaid == null || shapeWas == null ? null : shapeSaid === shapeWas;

    graded.push({
      ...summarise(s),
      matched: true,
      forecast,
      typicalErrFt: round1(s.typicalFt - forecast.typicalFt),
      setErrFt: round1(s.setFt - forecast.setFt),
      typicalRatio: round2(typicalRatio),
      setRatio: round2(setRatio),
      shapeRight,
      verdict: verdictFor(typicalRatio, setRatio, shapeRight),
    });
  }

  return { sessions: graded, summary: summaryOf(graded) };
}

function summarise(s) {
  return {
    date: s.date,
    spot: s.spot ?? null,
    window: `${s.fromLocalHour}:00-${s.toLocalHour}:00`,
    observedTypicalFt: s.typicalFt ?? null,
    observedSetFt: s.setFt ?? null,
    sizeWords: s.sizeWords ?? null,
    shape: s.shape ?? null,
    makeable: s.makeable ?? null,
    barNote: s.barNote ?? null,
    notes: s.notes ?? null,
  };
}

/**
 * The forecast that was live when the session happened. Prefer an archived run
 * from before the session - that is the honest test - and fall back to this
 * run's own hours, which is a hindcast and is labelled as one.
 */
function forecastFor(s, hourly, archives) {
  const inWindow = (h) => h.localDate === s.date
    && h.localHour >= (s.fromLocalHour ?? 0) - 0.5
    && h.localHour <= (s.toLocalHour ?? 24) + 0.5;

  // Archived hours are trimmed down to save space and carry no local date or
  // local hour at all - only a UTC timestamp. Matching them on local fields
  // could never succeed, so every session silently fell through to a hindcast
  // and the archive was never actually consulted. Derive the session's UTC
  // window from THIS run's hours, which do carry both, and match on that.
  const own = (hourly || []).filter(inWindow).map((h) => Date.parse(h.time));
  const utcFrom = own.length ? Math.min(...own) : null;
  const utcTo = own.length ? Math.max(...own) : null;
  const inUtcWindow = (h) => utcFrom != null
    && Date.parse(h.time) >= utcFrom && Date.parse(h.time) <= utcTo;

  // The most recent run ISSUED BEFORE the session started. Comparing against a
  // run issued after the fact would not be a forecast at all - it would be the
  // model being marked on work it had already seen the answer to. The session's
  // real start time comes from the hours themselves rather than from arithmetic
  // on the date, so daylight saving cannot quietly shift it by an hour.
  let best = null;
  for (const a of archives) {
    if (!a?.issued || !a.hourly) continue;
    const hrs = a.hourly.filter((h) => (h.localDate ? inWindow(h) : inUtcWindow(h)));
    if (!hrs.length) continue;
    const sessionStart = Math.min(...hrs.map((h) => Date.parse(h.time)));
    if (Date.parse(a.issued) > sessionStart) continue;
    if (!best || Date.parse(a.issued) > Date.parse(best.issued)) {
      best = { issued: a.issued, hrs };
    }
  }
  if (best) return pick(best.hrs, { issued: best.issued, hindcast: false });

  // Nothing was archived in time. Fall back to this run, which has already seen
  // the day happen - a hindcast, and labelled as one so nobody reads it as a
  // forecast that came true.
  const hrs = (hourly || []).filter(inWindow);
  if (hrs.length) return pick(hrs, { issued: null, hindcast: true });
  return null;
}

function pick(hrs, meta) {
  const mean = (f) => {
    const v = hrs.map(f).filter(Number.isFinite);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  // A live hour carries the whole peel object; a trimmed archive hour carries
  // just the makeable flag. Read either.
  const calls = hrs.map((h) => (h.peel ? h.peel.makeable : h.makeable))
    .filter((x) => x === true || x === false);
  const peels = hrs.map((h) => h.peel).filter(Boolean);
  return {
    ...meta,
    typicalFt: round1(mean((h) => h.faceFt)),
    setFt: round1(mean((h) => h.faceSetFt)),
    score: Math.round(mean((h) => h.score) ?? 0),
    periodS: round1(mean((h) => h.periodS)),
    makeable: calls.length ? calls.some(Boolean) : null,
    peelSpeedMs: peels.length ? Math.round(mean((h) => h.peel?.speedMs) ?? 0) : null,
  };
}

function verdictFor(typicalRatio, setRatio, shapeRight) {
  const bits = [];
  const sizeWord = (r, what) => {
    if (r == null) return null;
    if (r >= 1.5) return `${what} were ${r.toFixed(1)}x what we said`;
    if (r <= 0.67) return `${what} were ${(1 / r).toFixed(1)}x smaller than we said`;
    return `${what} were about right`;
  };
  const a = sizeWord(typicalRatio, 'the ordinary waves');
  const b = sizeWord(setRatio, 'the sets');
  if (a) bits.push(a);
  if (b) bits.push(b);
  if (shapeRight === false) bits.push('and the shape call was wrong');
  else if (shapeRight === true) bits.push('and the shape call was right');
  return bits.join(', ') + '.';
}

function summaryOf(graded) {
  const matched = graded.filter((g) => g.matched);
  if (!matched.length) return { n: 0, note: 'No sessions logged against a forecast yet.' };
  const mean = (f) => {
    const v = matched.map(f).filter(Number.isFinite);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const shapeCalls = matched.filter((g) => g.shapeRight != null);
  return {
    n: matched.length,
    typicalBiasRatio: round2(mean((g) => g.typicalRatio)),
    setBiasRatio: round2(mean((g) => g.setRatio)),
    shapeRightPct: shapeCalls.length
      ? Math.round((shapeCalls.filter((g) => g.shapeRight).length / shapeCalls.length) * 100) : null,
    note: matched.length < 5
      ? `Only ${matched.length} logged session${matched.length === 1 ? '' : 's'} so far - enough to spot a bad miss, nowhere near enough to retune anything.`
      : 'Enough sessions to start moving the calibration constants.',
  };
}

const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
