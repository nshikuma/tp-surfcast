/**
 * Prove the satellite reader is looking at this beach, by drawing it.
 *
 * Every part of this can be individually right and the whole thing still point
 * at the wrong kilometre of coast: a sign error in the projection, a row/column
 * transposition in the tile reader, a shore normal pointing inland. None of
 * those announce themselves in a number - a wrong window still returns pixels,
 * and a profile cut through the wrong place still produces a plausible-looking
 * waterline.
 *
 * What they cannot survive is a picture. The Pacific is on the west side of
 * this beach and the land is on the east, the shoreline runs roughly north to
 * south, and the surf zone is a narrow band just offshore. If the ASCII map
 * below shows land on the left, water on the right, and a ragged bright edge
 * between them, the whole chain from latitude to pixel is right. If it shows
 * anything else, it is wrong, and no amount of plausible numbers would have
 * said so.
 *
 * Prints nothing to disk.
 */

import { searchScenes, sampleGrid, readBand, profiles, readProfile, toReflectance, sampleAt } from '../src/sources/sentinel.js';
import { SITE } from '../src/config.js';

const log = (s) => console.log(s);

function drawMap(prof) {
  // Land on the left, sea on the right, north at the top. One character per
  // ten-metre pixel, so the map is 80 columns for 800 m of cross-shore.
  log('\n  north lot, one character per 10 m. "." dry, ":" damp, "~" water, "#" white water');
  log(`  columns: ${prof.cross[0]} m (landward) to ${prof.cross[prof.cross.length - 1]} m (seaward), the beach should be a vertical edge`);
  const outerRef = [];
  for (const r of prof.rows) {
    const outer = r.foam.slice(Math.floor(r.foam.length * 0.8)).filter((v) => v != null);
    if (outer.length) outerRef.push(outer.reduce((a, b) => a + b, 0) / outer.length);
  }
  const flatWater = outerRef.length ? outerRef.reduce((a, b) => a + b, 0) / outerRef.length : 0.02;

  for (const r of prof.rows) {
    let line = '';
    for (let i = 0; i < r.ndwi.length; i += 1) {
      const w = r.ndwi[i];
      const f = r.foam[i];
      if (w == null) { line += ' '; continue; }
      if (w <= -0.1) line += '.';
      else if (w <= 0) line += ':';
      else if (f != null && f > flatWater + 0.04) line += '#';
      else line += '~';
    }
    log(`  ${String(r.alongshoreM).padStart(5)}m ${line}`);
  }
  log(`  flat-water NIR reflectance reference: ${flatWater.toFixed(4)} (clean water is near zero, foam lifts it)`);
}

async function main() {
  log(`Torrey Pines north lot: ${SITE.lat}, ${SITE.lon}, shore normal ${SITE.shoreNormalDeg} deg\n`);
  const scenes = await searchScenes({ maxCloudPct: 30, sinceDays: 45, limit: 8 });
  log(`clear-ish scenes in the last 45 days: ${scenes.length}`);
  for (const s of scenes) log(`  ${s.properties.datetime}  cloud ${Number(s.properties['eo:cloud_cover']).toFixed(1)}%  ${s.id}`);
  if (!scenes.length) { log('nothing to look at'); return; }

  const scene = scenes[0];
  log(`\nreading ${scene.id}`);
  const grid = sampleGrid();
  const started = Date.now();
  const green = await readBand(scene, 'green', grid);
  const nir = await readBand(scene, 'nir', grid);
  log(`  green: ${green.win.tilesRead} tiles, ${(green.win.bytesRead / 1e6).toFixed(2)} MB, window ${green.win.width}x${green.win.height} px`);
  log(`  nir:   ${nir.win.tilesRead} tiles, ${(nir.win.bytesRead / 1e6).toFixed(2)} MB, window ${nir.win.width}x${nir.win.height} px`);
  log(`  ${((Date.now() - started) / 1000).toFixed(1)} s for the whole read`);

  // Raw values first: if the offset handling is wrong, reflectances come out
  // negative or absurd and everything downstream is quietly nonsense.
  const raws = [];
  for (const s of grid.alongshore.slice(0, 6)) {
    for (const x of grid.cross) {
      const p = grid.point(s, x);
      const g = toReflectance(sampleAt(green, p.eastingM, p.northingM), scene);
      const n = toReflectance(sampleAt(nir, p.eastingM, p.northingM), scene);
      if (g != null && n != null) raws.push([g, n]);
    }
  }
  const stat = (xs) => `${Math.min(...xs).toFixed(3)} to ${Math.max(...xs).toFixed(3)}`;
  log(`\n  green reflectance across the sample: ${stat(raws.map((r) => r[0]))}`);
  log(`  nir   reflectance across the sample: ${stat(raws.map((r) => r[1]))}`);
  log(`  boa offset applied per the catalogue: ${scene.properties['earthsearch:boa_offset_applied']}`);

  const prof = profiles(scene, green, nir, grid);
  drawMap(prof);

  log('\n  alongshore   waterline   surf outer   surf width   brightest foam');
  for (const r of prof.rows) {
    const p = readProfile(prof.cross, r.ndwi, r.foam);
    if (!p) { log(`  ${String(r.alongshoreM).padStart(6)} m   (no waterline found)`); continue; }
    log(`  ${String(r.alongshoreM).padStart(6)} m ${String(p.waterlineM).padStart(9)} m ${String(p.surfOuterM).padStart(11)} m`
      + ` ${String(p.surfWidthM).padStart(11)} m ${String(p.foamPeakM ?? '-').padStart(14)} m`);
  }
  log('\nNothing was stored.');
}

main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
