/**
 * CDIP MOP - Monitoring and Prediction, alongshore transect.
 *
 * This is Scripps' own nearshore model: a full spectral refraction run over
 * SURVEYED bathymetry, output every ~100 m along the coast. It is strictly
 * better than what this project was doing for the nearshore step - taking a
 * 0.25-degree global model and refracting it with one assumed shore normal.
 *
 * Line D0590 sits 65 m from the north lot. The span either side of it covers
 * the stretch of beach you can see from the car park, and because every line
 * publishes its own latitude, longitude, water depth and SHORE NORMAL, the
 * transect also gives the real shape of this piece of coast rather than an
 * assumed straight one.
 *
 * Variables confirmed against the live DDS/DAS:
 *   waveTime  Int32   seconds since 1970
 *   waveHs    Float32 metres          significant height at the line
 *   waveTp    Float32 seconds         peak period
 *   waveDp    Float32 degrees true    peak direction, already refracted
 *   metaLatitude / metaLongitude      degrees
 *   metaWaterDepth                    metres
 *   metaShoreNormal                   degrees true
 */

import { getText } from '../lib/http.js';
import { parseOpendapAscii } from './cdip.js';

const BASE = 'https://thredds.cdip.ucsd.edu/thredds/dodsC/cdip/model/MOP_alongshore';

/** The line at the north lot, and the span of beach around it. */
export const NORTH_LOT_LINE = 'D0590';
export const SPAN = { from: 583, to: 601 };

const lineId = (n) => `D0${String(n).padStart(3, '0')}`;

/** How many forecast hours the current MOP run carries. */
async function forecastLength(id, kind) {
  const dds = await getText(`${BASE}/${id}_${kind}.nc.dds`, { label: `mop:dds:${id}` });
  const m = dds.match(/waveTime\s*=\s*(\d+)/);
  if (!m) throw new Error(`MOP ${id}: no waveTime dimension in DDS`);
  return Number(m[1]);
}

/**
 * One MOP line: its position on the coast and its wave forecast.
 * Metadata and wave data come back in a single request.
 */
export async function fetchLine(id, { kind = 'forecast', hours = 240 } = {}) {
  const n = await forecastLength(id, kind);
  const last = Math.min(n, hours) - 1;
  const slice = `[0:1:${last}]`;
  const query = [
    'metaLatitude', 'metaLongitude', 'metaWaterDepth', 'metaShoreNormal',
    `waveTime${slice}`, `waveHs${slice}`, `waveTp${slice}`, `waveDp${slice}`,
  ].join(',');
  const text = await getText(`${BASE}/${id}_${kind}.nc.ascii?${query}`, { label: `mop:${id}` });
  const v = parseOpendapAscii(text);

  const first = (x) => (Array.isArray(x) ? (Array.isArray(x[0]) ? x[0][0] : x[0]) : x);
  const arr = (x) => (Array.isArray(x) && Array.isArray(x[0]) ? x[0] : x) || [];

  const times = arr(v.waveTime);
  const hs = arr(v.waveHs);
  const tp = arr(v.waveTp);
  const dp = arr(v.waveDp);
  if (!times.length || !hs.length) throw new Error(`MOP ${id}: empty forecast`);

  const records = [];
  for (let i = 0; i < times.length; i++) {
    const h = hs[i];
    if (!Number.isFinite(h) || h < 0 || h > 15) continue;
    records.push({
      time: new Date(times[i] * 1000).toISOString(),
      hsM: h,
      periodS: Number.isFinite(tp[i]) && tp[i] > 0 && tp[i] < 30 ? tp[i] : null,
      dirDeg: Number.isFinite(dp[i]) && dp[i] >= 0 && dp[i] <= 360 ? dp[i] : null,
    });
  }
  if (!records.length) throw new Error(`MOP ${id}: no usable records`);

  return {
    id,
    lat: first(v.metaLatitude),
    lon: first(v.metaLongitude),
    depthM: first(v.metaWaterDepth),
    shoreNormalDeg: first(v.metaShoreNormal),
    records,
  };
}

/**
 * The whole stretch of beach. Lines are fetched in small batches so a slow
 * THREDDS response does not stall the build, and one bad line never sinks the
 * transect - it just leaves a gap.
 */
export async function fetchTransect({ kind = 'forecast', hours = 240, from = SPAN.from, to = SPAN.to } = {}) {
  const ids = [];
  for (let n = from; n <= to; n++) ids.push(lineId(n));

  const lines = [];
  const errors = {};
  const BATCH = 5;
  for (let i = 0; i < ids.length; i += BATCH) {
    const group = ids.slice(i, i + BATCH);
    const settled = await Promise.allSettled(group.map((id) => fetchLine(id, { kind, hours })));
    settled.forEach((r, j) => {
      if (r.status === 'fulfilled') lines.push(r.value);
      else errors[group[j]] = String(r.reason && r.reason.message || r.reason);
    });
  }
  if (!lines.length) throw new Error(`MOP transect empty: ${JSON.stringify(errors)}`);

  lines.sort((a, b) => a.lat - b.lat);
  const home = lines.find((l) => l.id === NORTH_LOT_LINE) || lines[Math.floor(lines.length / 2)];

  return {
    kind,
    lines,
    home,
    errors,
    // Real coastline orientation, averaged over the span, for anything that
    // still needs a single number.
    meanShoreNormalDeg: circMeanDeg(lines.map((l) => l.shoreNormalDeg)),
  };
}

function circMeanDeg(ds) {
  const live = ds.filter(Number.isFinite);
  if (!live.length) return null;
  let x = 0, y = 0;
  for (const d of live) { x += Math.cos(d * Math.PI / 180); y += Math.sin(d * Math.PI / 180); }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
