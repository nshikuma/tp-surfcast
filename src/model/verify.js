/**
 * Forecast skill scoring.
 *
 * Claiming to beat anyone is meaningless without a scoreboard, so every run
 * archives what it predicted, and every later run grades those predictions
 * against what CDIP 100p1 actually measured. Error is reported by lead time,
 * because a forecast that nails tomorrow and flails at day 10 is a different
 * animal from one that is mediocre throughout.
 */

const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/** Nearest buoy observation to `iso`, within `toleranceMin`. */
function nearestObs(obs, iso, toleranceMin = 45) {
  const t = Date.parse(iso);
  let best = null, bestDt = Infinity;
  for (const o of obs) {
    const dt = Math.abs(Date.parse(o.time) - t);
    if (dt < bestDt) { bestDt = dt; best = o; }
  }
  return bestDt <= toleranceMin * 60000 ? best : null;
}

/**
 * @param {Array<{issued:string, hourly:Array}>} archives  past runs
 * @param {Array<{time:string, hsM:number, tpS:number, dirDeg:number}>} obs
 */
export function scoreSkill(archives, obs) {
  if (!archives?.length || !obs?.length) {
    return { buckets: [], overall: null, n: 0, note: 'Not enough archived runs yet - skill scores appear once a few days of history build up.' };
  }
  // Lead-time buckets, in hours.
  const edges = [0, 12, 24, 48, 72, 120, 168, 336];
  const buckets = edges.slice(0, -1).map((lo, i) => ({
    label: `${lo}-${edges[i + 1]} h`, lo, hi: edges[i + 1],
    hsErr: [], hsBias: [], tpErr: [], dirErr: [],
  }));

  for (const run of archives) {
    const issued = Date.parse(run.issued);
    for (const h of run.hourly || []) {
      const t = Date.parse(h.time);
      if (t <= issued) continue;              // only genuine forecasts, not hindcast
      const lead = (t - issued) / 36e5;
      const b = buckets.find((x) => lead >= x.lo && lead < x.hi);
      if (!b) continue;
      const o = nearestObs(obs, h.time);
      if (!o || !(o.hsM > 0)) continue;

      if (Number.isFinite(h.deepHsM)) {
        b.hsErr.push(Math.abs(h.deepHsM - o.hsM));
        b.hsBias.push(h.deepHsM - o.hsM);
      }
      if (Number.isFinite(h.periodS) && o.tpS > 0) b.tpErr.push(Math.abs(h.periodS - o.tpS));
      if (Number.isFinite(h.dirDeg) && Number.isFinite(o.dirDeg)) {
        let d = Math.abs(((h.dirDeg - o.dirDeg + 540) % 360) - 180);
        b.dirErr.push(d);
      }
    }
  }

  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const summary = buckets.map((b) => ({
    label: b.label,
    n: b.hsErr.length,
    hsMaeM: round2(mean(b.hsErr)),
    hsMaeFt: round2(mean(b.hsErr) * 3.28084),
    hsBiasM: round2(mean(b.hsBias)),
    tpMaeS: round2(mean(b.tpErr)),
    dirMaeDeg: round2(mean(b.dirErr)),
  })).filter((b) => b.n > 0);

  const allErr = buckets.flatMap((b) => b.hsErr);
  const allBias = buckets.flatMap((b) => b.hsBias);
  return {
    buckets: summary,
    overall: allErr.length ? {
      n: allErr.length,
      hsMaeFt: round2(mean(allErr) * 3.28084),
      hsBiasFt: round2(mean(allBias) * 3.28084),
    } : null,
    n: allErr.length,
    note: allErr.length
      ? 'Error is this forecast\'s deep-water significant height against CDIP 100p1 observations, by lead time.'
      : 'Archived runs exist but none have been verified against buoy data yet.',
  };
}

/**
 * Nowcast check: how close was the most recent run to what the buoy reads right
 * now? This is the number to glance at before trusting today's call.
 */
export function nowcastCheck(hourly, obs) {
  if (!hourly?.length || !obs?.length) return null;
  const latest = obs[obs.length - 1];
  const h = hourly.find((x) => Math.abs(Date.parse(x.time) - Date.parse(latest.time)) < 45 * 60000);
  if (!h) return null;
  return {
    time: latest.time,
    buoyHsFt: round2(latest.hsM * 3.28084),
    forecastHsFt: round2(h.deepHsM * 3.28084),
    errorFt: round2((h.deepHsM - latest.hsM) * 3.28084),
    buoyTpS: latest.tpS,
    forecastTpS: round2(h.periodS),
  };
}
