/**
 * Looking at the beach from orbit, because there is no webcam to look at.
 *
 * Every other source in this forecast measures the WAVES. None of them can see
 * the SAND, and at this beach the sand is most of the story: the same swell
 * that peels over a bank with a corner on it closes out over a straight bar.
 * The crew's own logs say so - the one session that caught the model out was a
 * shallow bank at the rivermouth that no instrument in the model knew about.
 *
 * Sentinel-2 can see it. Three satellites now pass this coast every day or two
 * carrying 10 m visible and near-infrared bands, and two things stand out at
 * that resolution:
 *
 *   THE WATERLINE. Water absorbs near-infrared almost completely and wet or dry
 *   sand reflects it strongly, so in NIR the shoreline is not a gradient, it is
 *   a cliff. Where that edge sits - once the tide at the moment of the overpass
 *   is accounted for - is how wide the beach is and how much sand is on it.
 *
 *   THE WHITE WATER. Foam is bright in every band including NIR, and foam sits
 *   where waves break, and waves break over the bar. A band of bright pixels
 *   two hundred metres offshore is a bar two hundred metres offshore. Averaged
 *   over many passes this is the poor man's version of the time-exposure
 *   imaging coastal scientists use to map sandbars.
 *
 * WHAT THIS CANNOT DO, stated plainly because the temptation to over-read a
 * satellite picture is strong. One frame is one instant, not a ten-minute
 * average, so a set happening to break inshore of the bar can move the apparent
 * line. Cloud and the morning marine layer take out a good fraction of passes.
 * And 10 m pixels put roughly ten to twenty of them across the whole surf zone,
 * so this measures where the bar is to within a pixel or two, never the shape
 * of an individual bank. It is a weekly-scale instrument for a weekly-scale
 * question - has the sand moved - and it is read that way everywhere it is used.
 */

import { parseHeader, readWindow, pixelFor, httpRangeReader, HEADER_BYTES } from '../lib/cog.js';
import { toUtm } from '../lib/utm.js';
import { SITE } from '../config.js';

export const STAC_URL = 'https://earth-search.aws.element84.com/v1/search';
export const COLLECTION = 'sentinel-2-l2a';

/** The stretch of beach this forecast is about: the north lot and the rivermouth. */
export const TRANSECTS = {
  alongshoreFromM: -900,   // north of the lot, towards the rivermouth
  alongshoreToM: 700,      // south of the lot
  alongshoreStepM: 50,
  // Measured from the north lot, which sits back from the water: the first
  // satellite read put the waterline about 250 m seaward of it. So the grid
  // runs far enough out that its outer fifth is open water well beyond any
  // bar - that stretch is the reference the surf zone is measured against.
  landwardM: 100,          // how far up the beach to sample
  seawardM: 1000,          // past the bar, into water that is never breaking
  crossStepM: 10,          // one pixel
};

/**
 * Sentinel-2 processing baseline 04.00 shifted the digital numbers by -1000 so
 * that slightly negative reflectances would survive being stored unsigned.
 *
 * Getting this backwards is not a rounding error, it is a different picture.
 * The first read of this beach subtracted the shift from scenes that had
 * already had it removed, which pushed clean water from a reflectance of about
 * zero to about minus a tenth - and since the water index is a ratio, that
 * inverted its sign and the whole ocean came back classified as land. The
 * catalogue states which scenes have been corrected already, in
 * earthsearch:boa_offset_applied; true means the work is done and nothing more
 * should be subtracted.
 */
const BOA_OFFSET_FROM = Date.parse('2022-01-25T00:00:00Z');

const bearingVector = (deg) => ({ e: Math.sin((deg * Math.PI) / 180), n: Math.cos((deg * Math.PI) / 180) });

/**
 * Recent scenes over this beach, newest first.
 *
 * @returns {Promise<Array<object>>} STAC features
 */
export async function searchScenes({
  lat = SITE.lat, lon = SITE.lon, halfWidthDeg = 0.02,
  maxCloudPct = 40, limit = 6, sinceDays = 30, fetchImpl = fetch,
} = {}) {
  const bbox = [lon - halfWidthDeg, lat - halfWidthDeg, lon + halfWidthDeg, lat + halfWidthDeg];
  const since = new Date(Date.now() - sinceDays * 864e5).toISOString();
  const url = `${STAC_URL}?collections=${COLLECTION}&bbox=${bbox.join(',')}`
    + `&datetime=${encodeURIComponent(`${since}/..`)}`
    + `&limit=${limit}&sortby=-properties.datetime`
    + `&query=${encodeURIComponent(JSON.stringify({ 'eo:cloud_cover': { lt: maxCloudPct } }))}`;
  const res = await fetchImpl(url, { headers: { 'user-agent': 'tp-surfcast/1.0' } });
  if (!res.ok) throw new Error(`sentinel: catalogue search failed, ${res.status}`);
  const j = await res.json();
  return j.features || [];
}

/** The sample grid, in metres alongshore and cross-shore, and on the UTM grid. */
export function sampleGrid(opts = {}) {
  const t = { ...TRANSECTS, ...opts };
  const origin = toUtm(opts.lat ?? SITE.lat, opts.lon ?? SITE.lon);
  // Seaward is the shore normal; alongshore is ninety degrees from it, which
  // for this beach points roughly south.
  const seaward = bearingVector(opts.shoreNormalDeg ?? SITE.shoreNormalDeg);
  const along = bearingVector((opts.shoreNormalDeg ?? SITE.shoreNormalDeg) - 90);

  const alongshore = [];
  for (let s = t.alongshoreFromM; s <= t.alongshoreToM; s += t.alongshoreStepM) alongshore.push(s);
  const cross = [];
  for (let x = -t.landwardM; x <= t.seawardM; x += t.crossStepM) cross.push(x);

  const point = (s, x) => ({
    eastingM: origin.eastingM + s * along.e + x * seaward.e,
    northingM: origin.northingM + s * along.n + x * seaward.n,
  });
  return { alongshore, cross, point, origin, seaward, along, opts: t };
}

/** Open one band of a scene and read the rectangle that holds the whole grid. */
export async function readBand(scene, band, grid, { fetchImpl = fetch } = {}) {
  const asset = scene.assets?.[band];
  if (!asset?.href) throw new Error(`sentinel: scene ${scene.id} has no ${band} band`);
  const read = httpRangeReader(asset.href, { fetchImpl, label: `sentinel:${band}` });

  const header = parseHeader(await read(0, HEADER_BYTES - 1));
  if (header.pixelScale?.[0] !== 10) {
    throw new Error(`sentinel: ${band} is ${header.pixelScale?.[0]} m per pixel, expected 10`);
  }

  // The bounding box of every sample point, with a pixel of slack.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of grid.alongshore) {
    for (const x of [grid.cross[0], grid.cross[grid.cross.length - 1]]) {
      const p = grid.point(s, x);
      const px = pixelFor(header, p.eastingM, p.northingM);
      minX = Math.min(minX, px.x); maxX = Math.max(maxX, px.x);
      minY = Math.min(minY, px.y); maxY = Math.max(maxY, px.y);
    }
  }
  const win = await readWindow(header, read, {
    x: minX - 1, y: minY - 1, width: maxX - minX + 3, height: maxY - minY + 3,
  });
  return { header, win, asset };
}

/** Reflectance from a raw digital number, honouring the baseline 04.00 shift. */
export function toReflectance(dn, scene) {
  if (!(dn > 0)) return null;                        // 0 is nodata in these scenes
  const applied = scene.properties?.['earthsearch:boa_offset_applied'];
  const stillShifted = applied === false
    || (applied == null && Date.parse(scene.properties?.datetime || 0) >= BOA_OFFSET_FROM);
  return (dn - (stillShifted ? 1000 : 0)) / 10000;
}

/** Nearest-neighbour lookup of a ground point in a window that was already read. */
export function sampleAt({ header, win }, eastingM, northingM) {
  const px = pixelFor(header, eastingM, northingM);
  const ix = px.x - win.x;
  const iy = px.y - win.y;
  if (ix < 0 || iy < 0 || ix >= win.width || iy >= win.height) return null;
  return win.data[iy * win.width + ix];
}

/**
 * Turn one scene into cross-shore profiles: for each alongshore position, the
 * water index and the brightness at every ten metres from the back of the beach
 * to well outside the surf.
 */
export function profiles(scene, green, nir, grid) {
  const rows = [];
  for (const s of grid.alongshore) {
    const ndwi = [];
    const foam = [];
    for (const x of grid.cross) {
      const p = grid.point(s, x);
      const g = toReflectance(sampleAt(green, p.eastingM, p.northingM), scene);
      const n = toReflectance(sampleAt(nir, p.eastingM, p.northingM), scene);
      if (g == null || n == null || g + n === 0) { ndwi.push(null); foam.push(null); continue; }
      ndwi.push((g - n) / (g + n));
      foam.push(n);                                  // NIR over water is foam, near enough
    }
    rows.push({ alongshoreM: s, ndwi, foam });
  }
  return { cross: grid.cross, rows, sceneId: scene.id, time: scene.properties?.datetime };
}

/**
 * Read one profile: where the water starts, how far out it is still breaking,
 * and where the brightest band of white water sits.
 *
 * The waterline is the most landward place where the water index crosses from
 * land to water and STAYS there - a single wet pixel on the upper beach is
 * swash, not shoreline. The surf zone is the run of pixels seaward of that
 * whose near-infrared is well above the flat water further out, since flat
 * water is essentially black in NIR and only foam lifts it.
 */
export function readProfile(cross, ndwi, foam, { waterThreshold = 0.0, foamMargin = 0.02 } = {}) {
  const n = cross.length;
  const isWater = ndwi.map((v) => (v == null ? null : v > waterThreshold));

  // Deep water reference: the outer fifth of the transect, which is beyond any
  // bar this beach makes.
  const outer = foam.slice(Math.floor(n * 0.8)).filter((v) => v != null);
  if (outer.length < 3) return null;
  const outerMean = outer.reduce((a, b) => a + b, 0) / outer.length;

  let shoreIdx = null;
  for (let i = 0; i < n - 3; i += 1) {
    if (isWater[i] && isWater[i + 1] && isWater[i + 2]) { shoreIdx = i; break; }
  }
  if (shoreIdx == null) return null;

  // Foam: bright NIR over water, seaward of the waterline.
  const lit = [];
  for (let i = shoreIdx; i < n; i += 1) {
    if (foam[i] == null) continue;
    if (foam[i] > outerMean + foamMargin) lit.push({ i, v: foam[i] });
  }
  const outerLit = lit.length ? lit[lit.length - 1].i : shoreIdx;
  const peak = lit.reduce((best, c) => (best && best.v >= c.v ? best : c), null);

  return {
    waterlineM: cross[shoreIdx],
    surfOuterM: cross[outerLit],
    surfWidthM: cross[outerLit] - cross[shoreIdx],
    foamPeakM: peak ? cross[peak.i] : null,
    foamPeakValue: peak ? Number(peak.v.toFixed(4)) : null,
    outerWaterNir: Number(outerMean.toFixed(4)),
    litPixels: lit.length,
  };
}

/**
 * Everything above, for one scene: search, read two bands, cut the transects,
 * and report where the sand and the breaking were.
 */
export async function analyseScene(scene, { fetchImpl = fetch, gridOpts = {} } = {}) {
  const grid = sampleGrid(gridOpts);
  const green = await readBand(scene, 'green', grid, { fetchImpl });
  const nir = await readBand(scene, 'nir', grid, { fetchImpl });
  const prof = profiles(scene, green, nir, grid);

  const lines = prof.rows.map((r) => ({
    alongshoreM: r.alongshoreM,
    ...(readProfile(prof.cross, r.ndwi, r.foam) || {}),
  })).filter((r) => r.waterlineM != null);

  const median = (xs) => {
    const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };

  // Clean deep water is nearly black in near-infrared - that is the whole basis
  // of reading this picture. If the outer end of the transects is not dark, the
  // scene is cloud, or surf all the way out, or the numbers have been scaled
  // wrongly, and every reading below is meaningless. Say so rather than publish
  // a confident waterline taken from a picture of a cloud.
  const outerNir = lines.map((l) => l.outerWaterNir).filter(Number.isFinite);
  const outerMedian = median(outerNir);
  const looksLikeWater = outerMedian != null && outerMedian < 0.05;

  return {
    sceneId: scene.id,
    time: scene.properties?.datetime,
    cloudPct: scene.properties?.['eo:cloud_cover'] ?? null,
    looksLikeWater,
    outerWaterNir: outerMedian,
    bytesRead: green.win.bytesRead + nir.win.bytesRead,
    tilesRead: green.win.tilesRead + nir.win.tilesRead,
    transects: lines,
    summary: {
      n: lines.length,
      medianWaterlineM: median(lines.map((l) => l.waterlineM)),
      medianSurfWidthM: median(lines.map((l) => l.surfWidthM)),
      medianFoamPeakM: median(lines.map((l) => l.foamPeakM)),
    },
    profiles: prof,
    grid,
  };
}
