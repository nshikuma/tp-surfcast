/**
 * CDIP station 100p1 - "Torrey Pines Outer".
 *
 * This is the buoy the whole forecast is anchored on. It sits roughly 8 miles
 * straight out from the lineup in ~550 m of water, which makes it about as
 * close to a ground-truth measurement of what is arriving as you can get.
 * Its readings already include Channel Islands shadowing, which is exactly why
 * the wave model treats buoy-origin data differently from global-model data.
 *
 * Primary access is the THREDDS OPeNDAP ASCII endpoint (no netCDF library
 * needed). If that is unavailable we fall back to CDIP's plain-text "justdar"
 * product, and beyond that to the NDBC mirror of the same buoy.
 */

import { SOURCES } from '../config.js';
import { getText } from '../lib/http.js';

const RT = (station) => `${SOURCES.cdipThredds}/${station}_rt.nc`;

/**
 * Parse an OPeNDAP ASCII response. The server emits a DDS header, a dashed
 * separator, then one block per variable. Blocks are named either `var[n]` or
 * `parent.var[n]`, and 2-D rows are prefixed with `[i],`. We stay deliberately
 * tolerant of all of those shapes.
 */
export function parseOpendapAscii(text) {
  const sepIdx = text.indexOf('---');
  const body = sepIdx >= 0 ? text.slice(text.indexOf('\n', sepIdx) + 1) : text;
  const vars = {};
  let current = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { current = null; continue; }
    const header = line.match(/^([A-Za-z0-9_.]+)\[[^\]]*\](\[[^\]]*\])*\s*$/);
    if (header) {
      const name = header[1].split('.').pop();
      current = name;
      vars[current] = vars[current] || [];
      continue;
    }
    if (!current) continue;
    // Drop a leading row index like "[3], " on 2-D output.
    const cleaned = line.replace(/^\[\d+\](\[\d+\])*\s*,?\s*/, '');
    const nums = cleaned.split(',').map((t) => Number(t.trim())).filter((n) => Number.isFinite(n));
    if (nums.length) vars[current].push(nums);
  }
  // Flatten single-row variables to a plain array.
  const out = {};
  for (const [k, rows] of Object.entries(vars)) {
    out[k] = rows.length === 1 ? rows[0] : rows;
  }
  return out;
}

/** Ask the DDS for array lengths so we can slice just the tail we need. */
export async function getDimensions(station = SOURCES.cdipStation) {
  const dds = await getText(`${RT(station)}.dds`, { label: 'cdip:dds' });
  const dims = {};
  for (const m of dds.matchAll(/\[\s*([A-Za-z0-9_]+)\s*=\s*(\d+)\s*\]/g)) {
    dims[m[1]] = Math.max(dims[m[1]] || 0, Number(m[2]));
  }
  return dims;
}

/**
 * Bulk wave parameters for the last `hours` of record, plus sea surface temp.
 * CDIP realtime files are half-hourly.
 */
export async function fetchBuoy(station = SOURCES.cdipStation, hours = 72) {
  const dims = await getDimensions(station);
  const nTime = dims.waveTime;
  if (!nTime) throw new Error('CDIP DDS did not report a waveTime dimension');
  const want = Math.min(nTime, Math.max(4, Math.ceil(hours * 2)));
  const a = nTime - want, b = nTime - 1;
  const slice = `[${a}:1:${b}]`;

  const query = ['waveTime', 'waveHs', 'waveTp', 'waveDp', 'waveTa', 'waveFlagPrimary']
    .map((v) => `${v}${slice}`).join(',');
  const text = await getText(`${RT(station)}.ascii?${query}`, { label: 'cdip:params' });
  const v = parseOpendapAscii(text);

  const records = [];
  const times = v.waveTime || [];
  for (let i = 0; i < times.length; i++) {
    // waveFlagPrimary: 1 = good, 2 = not evaluated. Anything else is suspect.
    const flag = v.waveFlagPrimary ? v.waveFlagPrimary[i] : 1;
    if (flag > 2) continue;
    const hs = v.waveHs?.[i], tp = v.waveTp?.[i], dp = v.waveDp?.[i];
    if (!Number.isFinite(hs) || hs < 0 || hs > 20) continue;
    records.push({
      time: new Date(times[i] * 1000).toISOString(),
      hsM: hs,
      tpS: Number.isFinite(tp) && tp > 0 && tp < 30 ? tp : null,
      dirDeg: Number.isFinite(dp) && dp >= 0 && dp <= 360 ? dp : null,
      taS: Number.isFinite(v.waveTa?.[i]) ? v.waveTa[i] : null,
    });
  }
  if (!records.length) throw new Error('CDIP returned no usable records');

  let sstC = null;
  try {
    const sn = dims.sstTime;
    if (sn) {
      const st = await getText(`${RT(station)}.ascii?sstSeaSurfaceTemperature[${sn - 1}:1:${sn - 1}]`, { label: 'cdip:sst' });
      const sv = parseOpendapAscii(st);
      const t = sv.sstSeaSurfaceTemperature;
      const val = Array.isArray(t) ? (Array.isArray(t[0]) ? t[0][0] : t[0]) : t;
      if (Number.isFinite(val) && val > 5 && val < 35) sstC = val;
    }
  } catch { /* SST is a nicety, not a dependency */ }

  return { station, source: 'cdip-thredds', records, latest: records[records.length - 1], sstC };
}

/**
 * The full 1-D energy spectrum for the most recent record.
 *
 * This is the real edge over a height-and-period forecast. With energy density
 * per frequency band we can compute true total energy, split the sea into its
 * actual swell trains, and see a new long-period forerunner arriving hours
 * before it shows up in the bulk significant height.
 */
export async function fetchSpectrum(station = SOURCES.cdipStation) {
  const dims = await getDimensions(station);
  const n = dims.waveTime;
  const nf = dims.waveFrequency;
  if (!n || !nf) throw new Error('CDIP DDS missing spectral dimensions');
  const last = `[${n - 1}:1:${n - 1}]`;
  const fslice = `[0:1:${nf - 1}]`;
  const query = [
    `waveTime${last}`,
    `waveFrequency${fslice}`,
    `waveBandwidth${fslice}`,
    `waveEnergyDensity${last}${fslice}`,
    `waveMeanDirection${last}${fslice}`,
  ].join(',');
  const text = await getText(`${RT(station)}.ascii?${query}`, { label: 'cdip:spectrum' });
  const v = parseOpendapAscii(text);

  const row = (x) => (Array.isArray(x) && Array.isArray(x[0]) ? x[0] : x);
  const freq = row(v.waveFrequency) || [];
  const bw = row(v.waveBandwidth) || [];
  const ed = row(v.waveEnergyDensity) || [];
  const dir = row(v.waveMeanDirection) || [];
  const timeArr = row(v.waveTime) || [];
  if (!freq.length || !ed.length) throw new Error('CDIP spectrum was empty');

  const bands = freq.map((f, i) => ({
    freqHz: f,
    periodS: f > 0 ? 1 / f : null,
    energy: ed[i] ?? 0,             // m^2/Hz
    bandwidth: bw[i] ?? 0,
    dirDeg: Number.isFinite(dir[i]) ? dir[i] : null,
  })).filter((b) => b.periodS && b.periodS > 1.5 && b.periodS < 30);

  return {
    time: timeArr[0] ? new Date(timeArr[0] * 1000).toISOString() : null,
    bands,
  };
}

/**
 * Split a 1-D spectrum into swell trains. Peaks in energy density separated by
 * a real trough are distinct swells; this is what lets the page say "there are
 * two swells in the water and they peak at different times" instead of
 * collapsing everything into one misleading number.
 */
export function partitionSpectrum(bands, { maxTrains = 3, minFraction = 0.06 } = {}) {
  if (!bands || bands.length < 5) return [];
  const m0Total = bands.reduce((s, b) => s + b.energy * b.bandwidth, 0);
  if (!(m0Total > 0)) return [];

  // Local maxima in energy density.
  const peaks = [];
  for (let i = 1; i < bands.length - 1; i++) {
    if (bands[i].energy > bands[i - 1].energy && bands[i].energy >= bands[i + 1].energy) {
      peaks.push(i);
    }
  }
  peaks.sort((a, b) => bands[b].energy - bands[a].energy);

  const claimed = new Array(bands.length).fill(false);
  const trains = [];
  for (const p of peaks) {
    if (trains.length >= maxTrains) break;
    if (claimed[p]) continue;
    // Walk outward from the peak until energy stops falling - that valley is
    // the boundary with the neighbouring swell train.
    let lo = p, hi = p;
    while (lo > 0 && !claimed[lo - 1] && bands[lo - 1].energy <= bands[lo].energy) lo--;
    while (hi < bands.length - 1 && !claimed[hi + 1] && bands[hi + 1].energy <= bands[hi].energy) hi++;

    let m0 = 0, wDir = 0, wSum = 0;
    for (let i = lo; i <= hi; i++) {
      claimed[i] = true;
      const e = bands[i].energy * bands[i].bandwidth;
      m0 += e;
      if (bands[i].dirDeg != null) {
        // Circular mean, weighted by energy.
        wDir += e * Math.cos((bands[i].dirDeg * Math.PI) / 180);
        wSum += e * Math.sin((bands[i].dirDeg * Math.PI) / 180);
      }
    }
    if (m0 / m0Total < minFraction) continue;
    let dirDeg = null;
    if (wDir !== 0 || wSum !== 0) {
      dirDeg = ((Math.atan2(wSum, wDir) * 180) / Math.PI + 360) % 360;
    }
    trains.push({
      hsM: 4 * Math.sqrt(m0),
      periodS: bands[p].periodS,
      dirDeg,
      energyFraction: m0 / m0Total,
    });
  }
  return trains.sort((a, b) => b.hsM - a.hsM);
}

/** Last-resort plain-text product if THREDDS is unreachable. */
export async function fetchBuoyJustdar(station = '100') {
  const text = await getText(`${SOURCES.cdipJustdar}?${station}+pm`, { label: 'cdip:justdar' });
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    // Expected shape: YYYY MM DD HH mm  Hs(m)  Tp(s)  Dp(deg) ...
    const m = line.trim().match(/^(\d{4})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+([\d.]+)\s+([\d.]+)\s+(\d+)/);
    if (!m) continue;
    const [, Y, Mo, D, H, Mi, hs, tp, dp] = m;
    records.push({
      time: new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi)).toISOString(),
      hsM: +hs, tpS: +tp, dirDeg: +dp, taS: null,
    });
  }
  if (!records.length) throw new Error('justdar returned no parseable rows');
  return { station, source: 'cdip-justdar', records, latest: records[records.length - 1], sstC: null };
}
