/**
 * Reconnaissance for CDIP 153p1 (Del Mar Nearshore), before writing anything
 * against it.
 *
 * The point of the second buoy is not more data for its own sake. 100p1 sits in
 * 550 m of water well offshore; a nearshore station sits inside the zone where
 * refraction and shoaling actually happen. The ratio between them, binned by
 * direction, is a MEASURED version of the directional exposure table in
 * config.js - which is currently a set of engineering estimates with a comment
 * on it admitting as much.
 *
 * This script only looks. It prints what the station is, where it is, how deep,
 * what fields it publishes, and how much its record overlaps 100p1's, so the
 * comparison is written against reality rather than against my assumptions
 * about it. Run by hand from the Actions tab.
 */

import { getText } from '../src/lib/http.js';
import { parseOpendapAscii, getDimensions, fetchBuoy } from '../src/sources/cdip.js';
import { SOURCES } from '../src/config.js';

const STATIONS = ['100p1', '153p1'];
const RT = (s) => `${SOURCES.cdipThredds}/${s}_rt.nc`;
const line = (s) => console.log(s);

async function describe(station) {
  line(`\n${'='.repeat(70)}\n${station}\n${'='.repeat(70)}`);

  // 1. What variables does it publish, and how big is each dimension?
  try {
    const dds = await getText(`${RT(station)}.dds`, { label: `probe:${station}:dds` });
    line('--- DDS (first 60 lines) ---');
    line(dds.split('\n').slice(0, 60).join('\n'));
  } catch (e) {
    line(`DDS failed: ${e.message}`);
    return null;
  }

  // 2. The metadata block: name, position, depth. These are scalars, which is
  //    the shape the ASCII parser previously got wrong, so print it raw too.
  try {
    const das = await getText(`${RT(station)}.das`, { label: `probe:${station}:das` });
    const interesting = das.split('\n').filter((l) => /metaStationName|metaDeployLat|metaDeployLon|metaWaterDepth|geospatial|title|summary/i.test(l));
    line('--- DAS, the lines that matter ---');
    line(interesting.slice(0, 40).join('\n') || '(nothing matched)');
  } catch (e) {
    line(`DAS failed: ${e.message}`);
  }

  // 3. The scalar metadata through the real parser, so I can see whether it
  //    comes back usable this time or still needs to be hard-coded.
  for (const v of ['metaStationName', 'metaDeployLatitude', 'metaDeployLongitude', 'metaWaterDepth']) {
    try {
      const txt = await getText(`${RT(station)}.ascii?${v}`, { label: `probe:${station}:${v}` });
      line(`--- ${v} raw ---`);
      line(txt.slice(0, 300));
      line(`--- ${v} parsed --- ${JSON.stringify(parseOpendapAscii(txt))}`);
    } catch (e) {
      line(`${v}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 700));   // CDIP has rate-limited us before
  }

  try {
    const dims = await getDimensions(station);
    line(`--- dimensions --- ${JSON.stringify(dims)}`);
  } catch (e) {
    line(`dimensions: ${e.message}`);
  }

  // 4. Does the existing fetchBuoy work on it unchanged?
  try {
    const b = await fetchBuoy(station, 48);
    line(`--- fetchBuoy OK --- ${b.records.length} records, latest ${JSON.stringify(b.latest)}`);
    return b;
  } catch (e) {
    line(`fetchBuoy failed: ${e.message}`);
    return null;
  }
}

async function main() {
  const got = {};
  for (const s of STATIONS) {
    got[s] = await describe(s);
    await new Promise((r) => setTimeout(r, 1200));
  }

  const outer = got['100p1'], near = got['153p1'];
  if (!outer || !near) {
    line('\nCannot compare: one of the stations did not return records.');
    return;
  }

  // 5. The actual question: how much do they overlap in time, and what does the
  //    height ratio look like against the direction the swell is coming from?
  line(`\n${'='.repeat(70)}\nOVERLAP AND RATIO\n${'='.repeat(70)}`);
  const byTime = new Map(near.records.map((r) => [r.time, r]));
  const pairs = [];
  for (const o of outer.records) {
    const n = byTime.get(o.time);
    if (!n || !(o.hsM > 0) || !(n.hsM > 0)) continue;
    pairs.push({ time: o.time, outer: o, near: n, ratio: n.hsM / o.hsM });
  }
  line(`matched hours: ${pairs.length} of ${outer.records.length} outer / ${near.records.length} nearshore`);
  if (!pairs.length) {
    line('No shared timestamps - the two stations report on different clocks.');
    line(`outer sample times:  ${outer.records.slice(-3).map((r) => r.time).join(', ')}`);
    line(`nearshore sample:    ${near.records.slice(-3).map((r) => r.time).join(', ')}`);
    return;
  }

  line('\ntime                  outer Hs/Tp/Dp      nearshore Hs/Tp/Dp    ratio  turn');
  for (const p of pairs.slice(-24)) {
    const turn = Math.round(((p.near.dirDeg - p.outer.dirDeg + 540) % 360) - 180);
    line(`${p.time}  ${p.outer.hsM.toFixed(2)}m ${String(p.outer.tpS).padStart(5)}s ${String(Math.round(p.outer.dirDeg)).padStart(3)}   `
      + `${p.near.hsM.toFixed(2)}m ${String(p.near.tpS).padStart(5)}s ${String(Math.round(p.near.dirDeg)).padStart(3)}   `
      + `${p.ratio.toFixed(2)}  ${turn > 0 ? '+' : ''}${turn}`);
  }

  // Binned by the OUTER direction, which is the one the exposure table keys on.
  line('\nratio by outer direction band:');
  const bands = [[160, 200], [200, 225], [225, 250], [250, 275], [275, 300], [300, 340]];
  for (const [lo, hi] of bands) {
    const inBand = pairs.filter((p) => p.outer.dirDeg >= lo && p.outer.dirDeg < hi);
    if (!inBand.length) { line(`  ${lo}-${hi}: no data in this window`); continue; }
    const rs = inBand.map((p) => p.ratio).sort((a, b) => a - b);
    const med = rs[Math.floor(rs.length / 2)];
    const turns = inBand.map((p) => ((p.near.dirDeg - p.outer.dirDeg + 540) % 360) - 180).sort((a, b) => a - b);
    const medTurn = turns[Math.floor(turns.length / 2)];
    const tp = inBand.map((p) => p.outer.tpS).filter(Number.isFinite).sort((a, b) => a - b);
    line(`  ${lo}-${hi}: n=${String(inBand.length).padStart(3)}  median ratio ${med.toFixed(2)}`
      + `  median turn ${medTurn > 0 ? '+' : ''}${medTurn.toFixed(0)}deg`
      + `  median Tp ${tp.length ? tp[Math.floor(tp.length / 2)].toFixed(1) : '--'}s`);
  }
}

main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
