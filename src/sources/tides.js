/**
 * NOAA CO-OPS station 9410230 - La Jolla (Scripps Pier).
 *
 * The nearest tide and water-temperature station, about 5 miles south. Tide
 * timing at Torrey Pines is within a couple of minutes of Scripps, so this is
 * effectively a local measurement rather than an approximation.
 *
 * Everything is requested in GMT and stored as UTC ISO strings; the page
 * renders in Pacific time. Doing the timezone conversion in exactly one place
 * avoids the daylight-saving bugs that plague this kind of tool.
 */

import { SOURCES } from '../config.js';
import { getJson } from '../lib/http.js';

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

function coopsUrl(params) {
  const q = new URLSearchParams({
    station: SOURCES.tideStation,
    time_zone: 'gmt',
    units: 'english',
    format: 'json',
    application: 'tp-surfcast2',
    ...params,
  });
  return `${SOURCES.coops}?${q}`;
}

/** CO-OPS returns "YYYY-MM-DD HH:mm" in GMT. */
const toIso = (t) => `${t.replace(' ', 'T')}:00Z`;

/**
 * Hourly predicted tide curve plus the exact high/low turning points, from
 * `pastDays` ago through `days` ahead.
 */
export async function fetchTides({ days = 15, pastDays = 3 } = {}) {
  const begin = new Date(Date.now() - pastDays * 864e5);
  const end = new Date(Date.now() + days * 864e5);

  const [curve, extremes] = await Promise.all([
    getJson(coopsUrl({
      product: 'predictions', datum: 'MLLW', interval: 'h',
      begin_date: ymd(begin), end_date: ymd(end),
    }), { label: 'coops:curve' }),
    getJson(coopsUrl({
      product: 'predictions', datum: 'MLLW', interval: 'hilo',
      begin_date: ymd(begin), end_date: ymd(end),
    }), { label: 'coops:hilo' }),
  ]);

  if (curve.error) throw new Error(`CO-OPS: ${curve.error.message}`);
  const series = (curve.predictions || []).map((p) => ({ time: toIso(p.t), ft: Number(p.v) }));
  const hilo = (extremes.predictions || []).map((p) => ({
    time: toIso(p.t), ft: Number(p.v), type: p.type === 'H' ? 'high' : 'low',
  }));
  if (!series.length) throw new Error('CO-OPS returned no tide predictions');
  return { station: SOURCES.tideStation, datum: 'MLLW', series, hilo };
}

/** Latest observed water temperature, degrees F. */
export async function fetchWaterTempF() {
  const j = await getJson(coopsUrl({ product: 'water_temperature', date: 'latest' }), { label: 'coops:wtemp' });
  const v = Number(j?.data?.[0]?.v);
  if (!Number.isFinite(v)) throw new Error('CO-OPS returned no water temperature');
  return { f: v, time: toIso(j.data[0].t), station: SOURCES.tideStation };
}

/**
 * Linear interpolation of the hourly curve, then a correction toward the exact
 * hi/lo extremes. Straight-line interpolation between hourly points clips the
 * peaks of a sinusoid by up to a couple of tenths of a foot, which matters when
 * a tide threshold is what decides whether the bar works.
 */
export function tideAt(tides, iso) {
  const t = Date.parse(iso);
  const s = tides.series;
  if (!s.length) return null;
  if (t <= Date.parse(s[0].time)) return s[0].ft;
  if (t >= Date.parse(s[s.length - 1].time)) return s[s.length - 1].ft;
  let lo = 0, hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (Date.parse(s[mid].time) <= t) lo = mid; else hi = mid;
  }
  const t0 = Date.parse(s[lo].time), t1 = Date.parse(s[hi].time);
  const f = (t - t0) / (t1 - t0);
  let ft = s[lo].ft + (s[hi].ft - s[lo].ft) * f;

  // If a turning point falls inside this hour, blend toward it.
  for (const e of tides.hilo) {
    const te = Date.parse(e.time);
    if (te > t0 && te < t1) {
      const w = 1 - Math.abs(t - te) / ((t1 - t0) / 2);
      if (w > 0) ft = ft * (1 - w) + e.ft * w;
    }
  }
  return ft;
}

/** Rate of change in ft/hr at `iso`; positive means the tide is filling. */
export function tideRateAt(tides, iso) {
  const t = Date.parse(iso);
  const a = tideAt(tides, new Date(t - 18e5).toISOString());
  const b = tideAt(tides, new Date(t + 18e5).toISOString());
  if (a == null || b == null) return 0;
  return b - a; // over one hour
}
