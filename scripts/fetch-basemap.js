#!/usr/bin/env node
/**
 * Fetch the real map of the Torrey Pines north lot from OpenStreetMap, once.
 *
 * The surf map needs to orient a person: where the car park is, where the ramp
 * down to the sand is, where the highway runs, and where the actual shoreline
 * sits. All of that is in OSM as vector geometry, openly licensed (ODbL), and
 * none of it changes week to week - so this runs by hand, commits a compact
 * file, and the site never talks to a tile server or a map API at runtime.
 *
 * One request. Overpass is a volunteer-run public service.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The stretch in the screenshot: the north lot, the lagoon mouth at the south
// end, and far enough north to cover the beach the crew actually walks to.
const BBOX = { s: 32.9235, w: -117.2720, n: 32.9455, e: -117.2490 };

const QUERY = `
[out:json][timeout:90];
(
  way["natural"="coastline"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  way["natural"="beach"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  way["natural"="water"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  way["waterway"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  way["amenity"="parking"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  way["highway"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  way["leisure"="nature_reserve"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  way["landuse"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  node["amenity"~"parking|toilets"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  node["emergency"="lifeguard_tower"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
);
out geom;
`;

/** Which OSM tags we care about, and what to call them on the map. */
function classify(tags = {}) {
  if (tags.natural === 'coastline') return { layer: 'coastline', kind: 'coastline' };
  if (tags.natural === 'beach') return { layer: 'beach', kind: 'beach' };
  if (tags.natural === 'water' || tags.waterway) {
    return { layer: 'water', kind: tags.waterway || 'water' };
  }
  if (tags.amenity === 'parking') return { layer: 'parking', kind: 'parking', name: tags.name };
  if (tags.amenity === 'toilets') return { layer: 'poi', kind: 'toilets', name: tags.name };
  if (tags.emergency === 'lifeguard_tower') return { layer: 'poi', kind: 'lifeguard', name: tags.name || tags.ref };
  if (tags.highway) {
    const foot = ['footway', 'path', 'steps', 'track', 'cycleway'].includes(tags.highway);
    return {
      layer: foot ? 'path' : 'road',
      kind: tags.highway,
      name: tags.name,
      // A path that crosses the beach is how you get to the water.
      access: foot ? true : undefined,
    };
  }
  if (tags.leisure === 'nature_reserve') return { layer: 'reserve', kind: 'reserve', name: tags.name };
  if (tags.landuse) return { layer: 'landuse', kind: tags.landuse, name: tags.name };
  return null;
}

const round = (n) => Math.round(n * 1e5) / 1e5;   // ~1 m, plenty for a surf map

async function main() {
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'tp-surfcast basemap fetch (personal surf forecast, one-off)',
    },
    body: `data=${encodeURIComponent(QUERY)}`,
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();

  const features = [];
  const counts = {};
  for (const el of json.elements || []) {
    const c = classify(el.tags);
    if (!c) continue;
    counts[c.layer] = (counts[c.layer] || 0) + 1;

    if (el.type === 'node' && Number.isFinite(el.lat)) {
      features.push({ ...c, point: [round(el.lon), round(el.lat)] });
      continue;
    }
    if (!el.geometry || el.geometry.length < 2) continue;
    const coords = el.geometry.map((g) => [round(g.lon), round(g.lat)]);
    // Drop consecutive duplicates left by rounding.
    const line = coords.filter((p, i) => i === 0 || p[0] !== coords[i - 1][0] || p[1] !== coords[i - 1][1]);
    if (line.length < 2) continue;
    const closed = line[0][0] === line[line.length - 1][0] && line[0][1] === line[line.length - 1][1];
    features.push({ ...c, closed, line });
  }

  const out = {
    _comment: 'Real map geometry for the Torrey Pines north lot, fetched once from '
      + 'OpenStreetMap so the site never needs a tile server or a map API at runtime.',
    _attribution: 'Map data (c) OpenStreetMap contributors, ODbL',
    _source: 'https://overpass-api.de/api/interpreter',
    _fetchedOn: new Date().toISOString().slice(0, 10),
    bbox: BBOX,
    features,
  };
  const dest = path.join(__dirname, '..', 'src', 'data', 'north-lot-map.json');
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, JSON.stringify(out));
  const kb = (JSON.stringify(out).length / 1024).toFixed(0);

  console.log(`wrote ${features.length} features, ${kb} KB`);
  console.log('by layer:', JSON.stringify(counts));
  console.log('named features:');
  features.filter((f) => f.name).slice(0, 40).forEach((f) => console.log(`  ${f.layer}/${f.kind}: ${f.name}`));
}

main().catch((e) => { console.error('basemap fetch failed:', e.message); process.exit(1); });
