/**
 * The satellite reader, checked without a satellite.
 *
 * Two things have to be right before any pixel of this beach means anything.
 * The projection has to put a latitude and longitude on the same grid the scene
 * is stored in, or the model reads the wrong kilometre of coast and never
 * notices. And the tile reader has to reassemble a window from the tiles that
 * overlap it, at the right offsets, with the compression and the predictor
 * undone in the right order - an off-by-one there produces a plausible-looking
 * image of nothing in particular.
 *
 * So this builds a small tiled, deflated, predictor-encoded TIFF by hand, with
 * known pixel values, and asks the reader to pull a window that straddles four
 * tiles. And it checks the projection against distances computed independently
 * on the WGS84 ellipsoid, which is the one check that cannot be passed by a
 * formula that merely agrees with itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { parseHeader, readWindow, pixelFor, decodeTile } from '../src/lib/cog.js';
import { toUtm, zoneFor, centralMeridian } from '../src/lib/utm.js';

/* ------------------------------------------------------------------ TIFF -- */

/** Build a little-endian, tiled, 16-bit, deflate+predictor TIFF in memory. */
function makeTiff({ width, height, tileWidth, tileLength, pixel, pixelScale = [10, 10, 0], tiepoint = [0, 0, 0, 399960, 3700020, 0] }) {
  const across = Math.ceil(width / tileWidth);
  const down = Math.ceil(height / tileLength);

  const tiles = [];
  for (let ty = 0; ty < down; ty += 1) {
    for (let tx = 0; tx < across; tx += 1) {
      const samples = new Uint16Array(tileWidth * tileLength);
      for (let y = 0; y < tileLength; y += 1) {
        for (let x = 0; x < tileWidth; x += 1) {
          const gx = tx * tileWidth + x;
          const gy = ty * tileLength + y;
          samples[y * tileWidth + x] = gx < width && gy < height ? pixel(gx, gy) : 0;
        }
      }
      // Horizontal differencing, the way GDAL writes it.
      const diffed = new Uint16Array(samples);
      for (let y = 0; y < tileLength; y += 1) {
        const base = y * tileWidth;
        for (let x = tileWidth - 1; x > 0; x -= 1) diffed[base + x] = (samples[base + x] - samples[base + x - 1]) & 0xffff;
      }
      const raw = Buffer.alloc(diffed.length * 2);
      diffed.forEach((v, i) => raw.writeUInt16LE(v, i * 2));
      tiles.push(zlib.deflateSync(raw));
    }
  }

  // Tags must be written in ascending order, values that do not fit in four
  // bytes live after the directory.
  const tags = [
    [256, 3, 1, width], [257, 3, 1, height], [258, 3, 1, 16], [259, 3, 1, 8],
    [262, 3, 1, 1], [277, 3, 1, 1], [317, 3, 1, 2],
    [322, 3, 1, tileWidth], [323, 3, 1, tileLength],
    [324, 4, tiles.length, null], [325, 4, tiles.length, null],
    [339, 3, 1, 1], [33550, 12, 3, null], [33922, 12, 6, null],
  ];

  const ifdOffset = 8;
  const ifdSize = 2 + tags.length * 12 + 4;
  let cursor = ifdOffset + ifdSize;
  // A four-byte value lives in the tag itself, which is what a single-tile
  // image produces - the reader has to handle both and so does this writer.
  const indexInline = tiles.length * 4 <= 4;
  const offsetsAt = indexInline ? ifdOffset + 2 + tags.findIndex(([t]) => t === 324) * 12 + 8 : (() => { const a = cursor; cursor += tiles.length * 4; return a; })();
  const countsAt = indexInline ? ifdOffset + 2 + tags.findIndex(([t]) => t === 325) * 12 + 8 : (() => { const a = cursor; cursor += tiles.length * 4; return a; })();
  const scaleAt = cursor; cursor += 3 * 8;
  const tieAt = cursor; cursor += 6 * 8;
  const tileOffsets = [];
  for (const t of tiles) { tileOffsets.push(cursor); cursor += t.length; }

  const buf = Buffer.alloc(cursor);
  buf.write('II', 0, 'ascii');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifdOffset, 4);
  buf.writeUInt16LE(tags.length, ifdOffset);
  tags.forEach(([tag, type, count, value], i) => {
    const e = ifdOffset + 2 + i * 12;
    buf.writeUInt16LE(tag, e);
    buf.writeUInt16LE(type, e + 2);
    buf.writeUInt32LE(count, e + 4);
    if (value !== null) {
      if (type === 3) buf.writeUInt16LE(value, e + 8);
      else buf.writeUInt32LE(value, e + 8);
    } else if (tag === 324) { if (!indexInline) buf.writeUInt32LE(offsetsAt, e + 8); }
    else if (tag === 325) { if (!indexInline) buf.writeUInt32LE(countsAt, e + 8); }
    else if (tag === 33550) buf.writeUInt32LE(scaleAt, e + 8);
    else if (tag === 33922) buf.writeUInt32LE(tieAt, e + 8);
  });
  buf.writeUInt32LE(0, ifdOffset + 2 + tags.length * 12);
  tiles.forEach((t, i) => {
    buf.writeUInt32LE(tileOffsets[i], offsetsAt + i * 4);
    buf.writeUInt32LE(t.length, countsAt + i * 4);
    t.copy(buf, tileOffsets[i]);
  });
  pixelScale.forEach((v, i) => buf.writeDoubleLE(v, scaleAt + i * 8));
  tiepoint.forEach((v, i) => buf.writeDoubleLE(v, tieAt + i * 8));
  return buf;
}

const PIXEL = (x, y) => (y * 100 + x) & 0xffff;

test('cog: reads back the header a real scene would carry', () => {
  const buf = makeTiff({ width: 20, height: 12, tileWidth: 8, tileLength: 8, pixel: PIXEL });
  const h = parseHeader(buf);
  assert.equal(h.width, 20);
  assert.equal(h.height, 12);
  assert.equal(h.tileWidth, 8);
  assert.equal(h.tilesAcross, 3);
  assert.equal(h.tilesDown, 2);
  assert.equal(h.compression, 8);
  assert.equal(h.predictor, 2);
  assert.deepEqual(h.pixelScale, [10, 10, 0]);
  assert.equal(h.tileOffsets.length, 6);
});

test('cog: a window straddling four tiles comes back with the right pixels', async () => {
  const buf = makeTiff({ width: 20, height: 12, tileWidth: 8, tileLength: 8, pixel: PIXEL });
  const h = parseHeader(buf);
  const reader = async (from, to) => buf.subarray(from, to + 1);

  const win = await readWindow(h, reader, { x: 6, y: 5, width: 6, height: 5 });
  assert.equal(win.width, 6);
  assert.equal(win.height, 5);
  assert.equal(win.tilesRead, 4, 'the window spans two tiles across and two down');
  for (let y = 0; y < win.height; y += 1) {
    for (let x = 0; x < win.width; x += 1) {
      assert.equal(win.data[y * win.width + x], PIXEL(6 + x, 5 + y), `pixel ${6 + x},${5 + y}`);
    }
  }
});

test('cog: a window is clipped to the scene rather than running off the edge', async () => {
  const buf = makeTiff({ width: 20, height: 12, tileWidth: 8, tileLength: 8, pixel: PIXEL });
  const h = parseHeader(buf);
  const reader = async (from, to) => buf.subarray(from, to + 1);
  const win = await readWindow(h, reader, { x: 16, y: 9, width: 10, height: 10 });
  assert.equal(win.width, 4);
  assert.equal(win.height, 3);
  assert.equal(win.data[0], PIXEL(16, 9));
});

test('cog: the predictor is undone, not merely inflated', () => {
  // Without the predictor step the first column survives and the rest is
  // nonsense, which is exactly the failure that looks plausible in a picture.
  const buf = makeTiff({ width: 8, height: 8, tileWidth: 8, tileLength: 8, pixel: PIXEL });
  const h = parseHeader(buf);
  const tile = decodeTile(buf.subarray(h.tileOffsets[0], h.tileOffsets[0] + h.tileByteCounts[0]), h);
  assert.equal(tile[0], PIXEL(0, 0));
  assert.equal(tile[7], PIXEL(7, 0));
  assert.equal(tile[8 * 3 + 5], PIXEL(5, 3));
});

test('cog: refuses what it cannot read instead of guessing', () => {
  const buf = makeTiff({ width: 8, height: 8, tileWidth: 8, tileLength: 8, pixel: PIXEL });
  const big = Buffer.from(buf);
  big.writeUInt16LE(43, 2);                       // pretend BigTIFF
  assert.throws(() => parseHeader(big), /BigTIFF/);

  const be = Buffer.from(buf);
  be.write('MM', 0, 'ascii');
  assert.throws(() => parseHeader(be), /little-endian/);

  const jpeg = Buffer.from(buf);
  const h = parseHeader(buf);
  const compEntry = h.entries[259].offset;
  jpeg.writeUInt16LE(7, compEntry);               // JPEG compression
  assert.throws(() => parseHeader(jpeg), /compression 7/);
});

test('cog: ground coordinates land on the right pixel', () => {
  const buf = makeTiff({ width: 20, height: 12, tileWidth: 8, tileLength: 8, pixel: PIXEL });
  const h = parseHeader(buf);
  // The tiepoint is the top-left corner: north-east of it is off the image,
  // and northing decreases as the row index grows.
  assert.deepEqual(pixelFor(h, 399960, 3700020), { x: 0, y: 0 });
  assert.deepEqual(pixelFor(h, 399960 + 35, 3700020 - 25), { x: 3, y: 2 });
});

/* ------------------------------------------------------------------- UTM -- */

test('utm: this coast is zone 11, whose central meridian is 117 west', () => {
  assert.equal(zoneFor(-117.26), 11);
  assert.equal(centralMeridian(11), -117);
});

test('utm: the central meridian sits exactly on the false easting', () => {
  const p = toUtm(32.92, -117);
  assert.ok(Math.abs(p.eastingM - 500000) < 1e-6, `easting ${p.eastingM}`);
});

test('utm: distances agree with the same distances measured on the ellipsoid', () => {
  // The independent check, and it has to be done on the ellipsoid: a sphere
  // disagrees with WGS84 by about three parts in a thousand at this latitude,
  // which would swamp what is being tested. Vincenty's inverse formula is
  // exact to millimetres and shares no code with the projection.
  const a = 6378137.0, f = 1 / 298.257223563, b = (1 - f) * a;
  const vincenty = (p1, p2) => {
    const L = (p2.lon - p1.lon) * Math.PI / 180;
    const U1 = Math.atan((1 - f) * Math.tan(p1.lat * Math.PI / 180));
    const U2 = Math.atan((1 - f) * Math.tan(p2.lat * Math.PI / 180));
    const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2);
    let lam = L, lamP, it = 0, sS, cS, sigma, sA, c2sm, C;
    do {
      const sL = Math.sin(lam), cL = Math.cos(lam);
      sS = Math.sqrt((cU2 * sL) ** 2 + (cU1 * sU2 - sU1 * cU2 * cL) ** 2);
      if (sS === 0) return 0;
      cS = sU1 * sU2 + cU1 * cU2 * cL;
      sigma = Math.atan2(sS, cS);
      sA = (cU1 * cU2 * sL) / sS;
      const c2A = 1 - sA * sA;
      c2sm = c2A === 0 ? 0 : cS - (2 * sU1 * sU2) / c2A;
      C = (f / 16) * c2A * (4 + f * (4 - 3 * c2A));
      lamP = lam;
      lam = L + (1 - C) * f * sA * (sigma + C * sS * (c2sm + C * cS * (-1 + 2 * c2sm * c2sm)));
      it += 1;
    } while (Math.abs(lam - lamP) > 1e-12 && it < 100);
    const u2 = (1 - sA * sA) * ((a * a - b * b) / (b * b));
    const A2 = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
    const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
    const dS = B * sS * (c2sm + (B / 4) * (cS * (-1 + 2 * c2sm * c2sm)
      - (B / 6) * c2sm * (-3 + 4 * sS * sS) * (-3 + 4 * c2sm * c2sm)));
    return b * A2 * (sigma - dS);
  };

  const pairs = [
    [{ lat: 32.90, lon: -117.26 }, { lat: 32.95, lon: -117.26 }],   // north-south
    [{ lat: 32.92, lon: -117.28 }, { lat: 32.92, lon: -117.24 }],   // east-west
    [{ lat: 32.90, lon: -117.28 }, { lat: 32.95, lon: -117.24 }],   // diagonal
  ];
  for (const [p1, p2] of pairs) {
    const q1 = toUtm(p1.lat, p1.lon);
    const q2 = toUtm(p2.lat, p2.lon);
    const grid = Math.hypot(q2.eastingM - q1.eastingM, q2.northingM - q1.northingM);
    const truth = vincenty(p1, p2);
    const ratio = grid / truth;
    // Not 1.0: the grid is deliberately shrunk by the UTM scale factor, which
    // is 0.9996 on the central meridian and grows back towards 1 going east or
    // west. Twenty-four kilometres off the meridian, this coast sits just
    // above 0.9996. Anything outside this band is a projection error.
    assert.ok(ratio > 0.9995 && ratio < 1.0000, `grid/true = ${ratio.toFixed(6)} for ${JSON.stringify(p1)}`);
  }
});

test('utm: the beach falls inside the scene that claims to cover it', () => {
  // Tile 11SMS starts at easting 399960, northing 3700020 and is 10980 pixels
  // of 10 m, so it spans 109.8 km each way. The north lot has to be inside it
  // or the whole source is pointed at the wrong place.
  const p = toUtm(32.9270, -117.2610);
  assert.equal(p.zone, 11);
  assert.ok(p.eastingM > 399960 && p.eastingM < 399960 + 109800, `easting ${p.eastingM.toFixed(0)}`);
  assert.ok(p.northingM < 3700020 && p.northingM > 3700020 - 109800, `northing ${p.northingM.toFixed(0)}`);
});

/* -------------------------------------------------------------- sentinel -- */

test('sentinel: the baseline shift is removed once, not twice', async () => {
  const { toReflectance } = await import('../src/sources/sentinel.js');
  // Clean deep water reads as a digital number of about 1 in near-infrared.
  // When the catalogue says the shift has already been taken out, subtracting
  // it again turns that into minus a tenth, which inverts the water index and
  // reports the entire Pacific as dry land. It has done exactly that once.
  const corrected = { properties: { datetime: '2026-09-13T18:35:00Z', 'earthsearch:boa_offset_applied': true } };
  assert.ok(Math.abs(toReflectance(1, corrected) - 0.0001) < 1e-9);
  assert.ok(Math.abs(toReflectance(2000, corrected) - 0.2) < 1e-9);

  // A scene that still carries the shift has to have it taken out.
  const raw = { properties: { datetime: '2026-09-13T18:35:00Z', 'earthsearch:boa_offset_applied': false } };
  assert.ok(Math.abs(toReflectance(1001, raw) - 0.0001) < 1e-9);

  // Before the baseline changed there was no shift at all.
  const old = { properties: { datetime: '2019-06-01T18:35:00Z' } };
  assert.ok(Math.abs(toReflectance(1, old) - 0.0001) < 1e-9);

  // Nodata is not a reflectance of zero, it is an absence.
  assert.equal(toReflectance(0, corrected), null);
});

test('sentinel: water and sand come out on the right sides of the index', async () => {
  const { toReflectance } = await import('../src/sources/sentinel.js');
  const scene = { properties: { datetime: '2026-09-13T18:35:00Z', 'earthsearch:boa_offset_applied': true } };
  const ndwi = (greenDn, nirDn) => {
    const g = toReflectance(greenDn, scene);
    const n = toReflectance(nirDn, scene);
    return (g - n) / (g + n);
  };
  assert.ok(ndwi(400, 1) > 0.5, 'clear water: green reflects a little, near-infrared almost nothing');
  assert.ok(ndwi(2000, 2600) < 0, 'dry sand: near-infrared brighter than green');
  assert.ok(ndwi(3000, 2800) > 0, 'foam is bright in both, and this is the case the surf test has to handle separately');
});
