/**
 * NDBC mirror of the same Torrey Pines Outer buoy (station 46225).
 *
 * Used when CDIP's THREDDS server is down. The `.spec` product is genuinely
 * useful in its own right: NDBC already separates swell from wind sea, which
 * gives us a second opinion on the spectral partitioning.
 */

import { SOURCES } from '../config.js';
import { getText } from '../lib/http.js';

const NUM = (t) => (t === 'MM' || t == null ? null : Number(t));

function parseRows(text) {
  return text.split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.trim().split(/\s+/));
}

const rowTime = (c) =>
  new Date(Date.UTC(+c[0], +c[1] - 1, +c[2], +c[3], +c[4])).toISOString();

/** Standard meteorological product: Hs, dominant period, mean direction, water temp. */
export async function fetchStandard(station = SOURCES.ndbcStation) {
  const text = await getText(`https://www.ndbc.noaa.gov/data/realtime2/${station}.txt`, { label: 'ndbc:txt' });
  const records = [];
  let sstC = null;
  for (const c of parseRows(text)) {
    if (c.length < 15) continue;
    const hs = NUM(c[8]);
    if (!Number.isFinite(hs)) continue;
    const wtmp = NUM(c[14]);
    if (sstC == null && Number.isFinite(wtmp)) sstC = wtmp; // rows are newest-first
    records.push({
      time: rowTime(c),
      hsM: hs,
      tpS: NUM(c[9]),
      taS: NUM(c[10]),
      dirDeg: NUM(c[11]),
      windDirDeg: NUM(c[5]),
      windMs: NUM(c[6]),
    });
  }
  records.reverse(); // oldest-first, to match the CDIP shape
  if (!records.length) throw new Error('NDBC standard product had no usable rows');
  return { station, source: 'ndbc', records, latest: records[records.length - 1], sstC };
}

/** Spectral summary: swell and wind-sea split out separately. */
export async function fetchSpec(station = SOURCES.ndbcStation) {
  const text = await getText(`https://www.ndbc.noaa.gov/data/realtime2/${station}.spec`, { label: 'ndbc:spec' });
  const dirToDeg = {
    N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
    S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
  };
  const toDeg = (t) => (t in dirToDeg ? dirToDeg[t] : NUM(t));
  const rows = parseRows(text);
  const out = [];
  for (const c of rows) {
    if (c.length < 13) continue;
    const hs = NUM(c[5]);
    if (!Number.isFinite(hs)) continue;
    out.push({
      time: rowTime(c),
      hsM: hs,
      swell: { hsM: NUM(c[6]), periodS: NUM(c[7]), dirDeg: toDeg(c[10]) },
      windSea: { hsM: NUM(c[8]), periodS: NUM(c[9]), dirDeg: toDeg(c[11]) },
      steepness: c[12],
    });
  }
  out.reverse();
  if (!out.length) throw new Error('NDBC spectral product had no usable rows');
  return { station, records: out, latest: out[out.length - 1] };
}
