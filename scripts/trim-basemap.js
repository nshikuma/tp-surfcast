#!/usr/bin/env node
/**
 * Trim the OSM basemap to what the surf map actually draws.
 *
 * The raw fetch covers a generous box and carries every residential street in
 * the neighbourhood - useful to have on hand, wasteful to send to a phone. This
 * clips to the render frame, drops the streets that are only context noise,
 * and simplifies the geometry to roughly a metre. Pure local work: no network.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** What the map shows: ocean out past the MOP lines, inland past the highway. */
export const FRAME = { s: 32.9302, w: -117.2690, n: 32.9388, e: -117.2540 };

const inFrame = ([lon, lat]) =>
  lon >= FRAME.w - 0.002 && lon <= FRAME.e + 0.002 && lat >= FRAME.s - 0.002 && lat <= FRAME.n + 0.002;

/** Perpendicular distance simplification, in degrees (~1e-5 deg is about 1 m). */
function simplify(points, tol) {
  if (points.length < 3) return points;
  let maxD = 0, idx = 0;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    let d;
    if (len2 === 0) d = Math.hypot(px - ax, py - ay);
    else {
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tol) return [points[0], points[points.length - 1]];
  return [
    ...simplify(points.slice(0, idx + 1), tol).slice(0, -1),
    ...simplify(points.slice(idx), tol),
  ];
}

// Roads worth drawing for orientation. Every cul-de-sac in the hills above is
// not; it makes the map busier without telling a surfer anything.
const KEEP_ROADS = new Set(['primary', 'secondary', 'tertiary', 'trunk', 'motorway',
  'residential', 'unclassified', 'service']);
const MAJOR = new Set(['primary', 'secondary', 'trunk', 'motorway', 'tertiary']);

async function main() {
  const src = path.join(__dirname, '..', 'src', 'data', 'north-lot-map.json');
  const raw = JSON.parse(await readFile(src, 'utf8'));

  const out = [];
  for (const f of raw.features) {
    if (f.point) {
      if (inFrame(f.point)) out.push(f);
      continue;
    }
    if (!f.line) continue;
    if (f.layer === 'road' && !KEEP_ROADS.has(f.kind)) continue;
    // Minor streets only if they are near the beach; majors always.
    if (f.layer === 'road' && !MAJOR.has(f.kind)) {
      const nearBeach = f.line.some(([lon]) => lon <= -117.2600);
      if (!nearBeach) continue;
    }
    if (f.layer === 'landuse') continue;                   // adds nothing here
    const clipped = f.line.filter(inFrame);
    if (clipped.length < 2) continue;
    const tol = f.layer === 'coastline' ? 0.000015 : 0.00003;
    const line = simplify(clipped, tol);
    out.push({ layer: f.layer, kind: f.kind, name: f.name, closed: f.closed, line });
  }

  const doc = {
    _attribution: raw._attribution,
    _fetchedOn: raw._fetchedOn,
    frame: FRAME,
    features: out,
  };
  const dest = path.join(__dirname, '..', 'docs', 'data', 'basemap.json');
  const text = JSON.stringify(doc);
  await writeFile(dest, text);

  const by = {};
  out.forEach((f) => { by[f.layer] = (by[f.layer] || 0) + 1; });
  console.log(`trimmed ${raw.features.length} -> ${out.length} features, ${(text.length / 1024).toFixed(0)} KB`);
  console.log('layers:', JSON.stringify(by));
  const pts = out.reduce((s, f) => s + (f.line ? f.line.length : 1), 0);
  console.log('total points:', pts);
  out.filter((f) => f.layer === 'parking' || (f.name && /torrey/i.test(f.name))).slice(0, 10)
    .forEach((f) => console.log(`  kept: ${f.layer}/${f.kind} ${f.name || '(unnamed)'} - ${f.line.length} pts`));
}

main().catch((e) => { console.error(e); process.exit(1); });
