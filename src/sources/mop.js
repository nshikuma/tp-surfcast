/**
 * CDIP MOP - Monitoring and Prediction, alongshore transect.
 *
 * Scripps' own nearshore model: a spectral refraction run over SURVEYED
 * bathymetry, published every ~100 m along the coast. Line D0590 sits 65 m from
 * the north lot. Strictly better than refracting a 0.25-degree global model
 * with one assumed shore normal, which is what this project did before.
 *
 * BEING A GOOD CITIZEN. This is a public research server, not an API with a
 * quota we have paid for, and an earlier version of this file got the whole
 * project a 403 by firing 38 parallel requests at it every run. So:
 *   - line POSITIONS are cached in src/data/mop-lines.json (they never move),
 *   - requests go out one at a time with a pause between them,
 *   - the span is sampled, not exhaustive,
 *   - a refusal backs off for the rest of the run rather than retrying,
 *   - and if MOP is unavailable the forecast carries on without it.
 *
 * Variables confirmed against the live DDS/DAS:
 *   waveTime Int32 s since 1970 | waveHs m | waveTp s | waveDp degT
 *   metaLatitude / metaLongitude / metaWaterDepth / metaShoreNormal
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getText } from '../lib/http.js';
import { parseOpendapAscii } from './cdip.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://thredds.cdip.ucsd.edu/thredds/dodsC/cdip/model/MOP_alongshore';

export const NORTH_LOT_LINE = 'D0590';

/** Pause between requests to the same public server. */
const POLITE_GAP_MS = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * MOP alongshore output depth, metres. Used only when metaWaterDepth cannot be
 * read for a line; the fetched value always wins. Flagged in the payload so a
 * fallback is never mistaken for a measurement.
 */
const ASSUMED_DEPTH_M = 10;

export async function loadLinePositions() {
  const raw = await readFile(path.join(__dirname, '..', 'data', 'mop-lines.json'), 'utf8');
  const lines = JSON.parse(raw).lines;
  // Shore normal from the real geometry: the coast runs line-to-line, and the
  // normal faces seaward (west here). A fetched metaShoreNormal overrides this.
  return lines.map((l, i) => {
    const a = lines[Math.max(0, i - 1)];
    const b = lines[Math.min(lines.length - 1, i + 1)];
    const dy = (b.lat - a.lat) * 111320;
    const dx = (b.lon - a.lon) * 111320 * Math.cos(l.lat * Math.PI / 180);
    const coastBearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
    return { ...l, shoreNormalDeg: (coastBearing + 270) % 360, shoreNormalFrom: 'geometry' };
  });
}

function firstNum(x) {
  const v = Array.isArray(x) ? (Array.isArray(x[0]) ? x[0][0] : x[0]) : x;
  return Number.isFinite(v) ? v : null;
}
const asArray = (x) => ((Array.isArray(x) && Array.isArray(x[0])) ? x[0] : x) || [];

/** One line's wave forecast, plus its depth and shore normal if they come back. */
export async function fetchLine(id, { kind = 'forecast', hours = 180 } = {}) {
  const dds = await getText(`${BASE}/${id}_${kind}.nc.dds`, { label: `mop:dds:${id}`, retries: 0 });
  const m = dds.match(/waveTime\s*=\s*(\d+)/);
  if (!m) throw new Error(`MOP ${id}: no waveTime dimension`);
  const last = Math.min(Number(m[1]), hours) - 1;
  const slice = `[0:1:${last}]`;

  await sleep(POLITE_GAP_MS);
  const query = [
    'metaWaterDepth', 'metaShoreNormal',
    `waveTime${slice}`, `waveHs${slice}`, `waveTp${slice}`, `waveDp${slice}`,
  ].join(',');
  const text = await getText(`${BASE}/${id}_${kind}.nc.ascii?${query}`, { label: `mop:${id}`, retries: 0 });
  const v = parseOpendapAscii(text);

  const times = asArray(v.waveTime);
  const hs = asArray(v.waveHs);
  const tp = asArray(v.waveTp);
  const dp = asArray(v.waveDp);
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
    depthM: firstNum(v.metaWaterDepth),
    shoreNormalDeg: firstNum(v.metaShoreNormal),
    records,
  };
}

/**
 * The stretch of beach. Sampled every `step` lines and fetched one at a time;
 * a refusal (403/429) stops the run's remaining requests rather than pounding
 * a server that has already said no.
 */
export async function fetchTransect({ kind = 'forecast', hours = 180, step = 2 } = {}) {
  const positions = await loadLinePositions();
  const wanted = positions.filter((p, i) => i % step === 0 || p.id === NORTH_LOT_LINE);

  const lines = [];
  const errors = {};
  let refused = false;
  for (const p of wanted) {
    if (refused) { errors[p.id] = 'skipped after a refusal earlier in this run'; continue; }
    try {
      const got = await fetchLine(p.id, { kind, hours });
      lines.push({
        id: p.id, lat: p.lat, lon: p.lon,
        depthM: got.depthM ?? ASSUMED_DEPTH_M,
        depthFrom: got.depthM != null ? 'published' : 'assumed',
        shoreNormalDeg: got.shoreNormalDeg ?? p.shoreNormalDeg,
        shoreNormalFrom: got.shoreNormalDeg != null ? 'published' : 'geometry',
        records: got.records,
      });
    } catch (e) {
      errors[p.id] = String(e.message);
      if (e.status === 403 || e.status === 429) {
        refused = true;
        errors._refused = `CDIP refused with ${e.status}; backing off for this run.`;
      }
    }
    await sleep(POLITE_GAP_MS);
  }

  if (!lines.length) throw new Error(`MOP transect empty: ${JSON.stringify(errors)}`);
  lines.sort((a, b) => a.lat - b.lat);
  const home = lines.find((l) => l.id === NORTH_LOT_LINE) || lines[Math.floor(lines.length / 2)];

  return { kind, lines, home, errors, meanShoreNormalDeg: circMeanDeg(lines.map((l) => l.shoreNormalDeg)) };
}

function circMeanDeg(ds) {
  const live = ds.filter(Number.isFinite);
  if (!live.length) return null;
  let x = 0, y = 0;
  for (const d of live) { x += Math.cos(d * Math.PI / 180); y += Math.sin(d * Math.PI / 180); }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
