/**
 * Just enough GeoTIFF to look at one beach.
 *
 * Sentinel-2 scenes are 10980 x 10980 pixels, about a hundred megabytes a band,
 * and this forecast cares about a two-kilometre stretch of sand. Fetching the
 * whole scene to look at 0.3% of it would be absurd, and that is exactly what
 * cloud-optimised GeoTIFF exists to avoid: the file is stored as a grid of
 * independently compressed tiles, with an index at the front saying where each
 * one starts. A reader can take the header, work out which tile covers the
 * beach, and ask the server for those bytes alone.
 *
 * The probe measured what has to be supported: classic little-endian TIFF, one
 * 16-bit sample per pixel, 1024 x 1024 tiles, deflate compression - which Node
 * has built in - and five levels of overview that this does not need. That is a
 * narrow enough target to write by hand, and writing it by hand keeps the whole
 * forecast free of dependencies, which has been the rule from the start.
 *
 * Deliberately NOT supported, with a clear error rather than a wrong answer:
 * BigTIFF, JPEG or LERC or WebP compression, striped (untiled) layouts, and
 * multi-sample pixels. If a scene ever shows up in one of those, this says so
 * instead of quietly returning noise.
 */

import zlib from 'node:zlib';

const TAGS = {
  IMAGE_WIDTH: 256, IMAGE_LENGTH: 257, BITS_PER_SAMPLE: 258, COMPRESSION: 259,
  PHOTOMETRIC: 262, SAMPLES_PER_PIXEL: 277, PLANAR_CONFIG: 284, PREDICTOR: 317,
  TILE_WIDTH: 322, TILE_LENGTH: 323, TILE_OFFSETS: 324, TILE_BYTE_COUNTS: 325,
  SAMPLE_FORMAT: 339, MODEL_PIXEL_SCALE: 33550, MODEL_TIEPOINT: 33922,
  GDAL_NODATA: 42113,
};

const COMPRESSION_NONE = 1;
const COMPRESSION_DEFLATE = 8;
const COMPRESSION_ADOBE_DEFLATE = 32946;
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** How many header bytes to pull before anything else. COGs put the index first. */
export const HEADER_BYTES = 128 * 1024;

/**
 * Parse the first image directory out of a buffer holding the start of a TIFF.
 *
 * @param {Buffer} buf - at least the first few tens of kilobytes of the file.
 * @returns {object} the fields this reader needs, plus the raw tag map.
 */
export function parseHeader(buf) {
  if (buf.length < 16) throw new Error('cog: header buffer too short');
  const order = buf.toString('ascii', 0, 2);
  if (order !== 'II') throw new Error(`cog: only little-endian TIFF is supported, got "${order}"`);
  const magic = buf.readUInt16LE(2);
  if (magic === 43) throw new Error('cog: BigTIFF is not supported');
  if (magic !== 42) throw new Error(`cog: not a TIFF (magic ${magic})`);

  const ifdStart = buf.readUInt32LE(4);
  if (ifdStart + 2 > buf.length) throw new Error('cog: first directory lies beyond the fetched header');
  const count = buf.readUInt16LE(ifdStart);
  const entries = {};
  for (let i = 0; i < count; i += 1) {
    const e = ifdStart + 2 + i * 12;
    if (e + 12 > buf.length) throw new Error('cog: directory is longer than the fetched header');
    const tag = buf.readUInt16LE(e);
    const type = buf.readUInt16LE(e + 2);
    const num = buf.readUInt32LE(e + 4);
    const size = (TYPE_SIZE[type] || 1) * num;
    const inline = size <= 4;
    const at = inline ? e + 8 : buf.readUInt32LE(e + 8);
    entries[tag] = { type, count: num, offset: at, inline };
  }

  const values = (tag) => {
    const t = entries[tag];
    if (!t) return null;
    const out = [];
    for (let i = 0; i < t.count; i += 1) {
      const o = t.offset + i * (TYPE_SIZE[t.type] || 1);
      if (o + (TYPE_SIZE[t.type] || 1) > buf.length) return null;   // index not in the fetched range
      if (t.type === 3) out.push(buf.readUInt16LE(o));
      else if (t.type === 4) out.push(buf.readUInt32LE(o));
      else if (t.type === 12) out.push(buf.readDoubleLE(o));
      else if (t.type === 11) out.push(buf.readFloatLE(o));
      else if (t.type === 1 || t.type === 2 || t.type === 6 || t.type === 7) out.push(buf.readUInt8(o));
      else return null;
    }
    return out;
  };
  const one = (tag, fallback = null) => (values(tag)?.[0] ?? fallback);

  const header = {
    width: one(TAGS.IMAGE_WIDTH),
    height: one(TAGS.IMAGE_LENGTH),
    tileWidth: one(TAGS.TILE_WIDTH),
    tileLength: one(TAGS.TILE_LENGTH),
    bitsPerSample: one(TAGS.BITS_PER_SAMPLE, 8),
    samplesPerPixel: one(TAGS.SAMPLES_PER_PIXEL, 1),
    sampleFormat: one(TAGS.SAMPLE_FORMAT, 1),
    compression: one(TAGS.COMPRESSION, 1),
    predictor: one(TAGS.PREDICTOR, 1),
    planarConfig: one(TAGS.PLANAR_CONFIG, 1),
    pixelScale: values(TAGS.MODEL_PIXEL_SCALE),
    tiepoint: values(TAGS.MODEL_TIEPOINT),
    tileOffsets: values(TAGS.TILE_OFFSETS),
    tileByteCounts: values(TAGS.TILE_BYTE_COUNTS),
    entries,
  };

  if (!header.width || !header.height) throw new Error('cog: image dimensions missing');
  if (!header.tileWidth || !header.tileLength) throw new Error('cog: striped TIFFs are not supported, only tiled');
  if (header.samplesPerPixel !== 1) throw new Error(`cog: only single-sample pixels are supported, got ${header.samplesPerPixel}`);
  if (![COMPRESSION_NONE, COMPRESSION_DEFLATE, COMPRESSION_ADOBE_DEFLATE].includes(header.compression)) {
    throw new Error(`cog: compression ${header.compression} is not supported (only none and deflate)`);
  }
  if (!header.tileOffsets || !header.tileByteCounts) {
    throw new Error('cog: the tile index is not inside the fetched header - fetch more bytes');
  }
  header.tilesAcross = Math.ceil(header.width / header.tileWidth);
  header.tilesDown = Math.ceil(header.height / header.tileLength);
  return header;
}

/** Undo horizontal differencing, which GDAL applies before deflating. */
function unpredict(samples, width, height) {
  for (let row = 0; row < height; row += 1) {
    const base = row * width;
    for (let x = 1; x < width; x += 1) samples[base + x] = (samples[base + x] + samples[base + x - 1]) & 0xffff;
  }
  return samples;
}

/** Decode one tile's bytes into a typed array of samples. */
export function decodeTile(bytes, header) {
  const raw = header.compression === COMPRESSION_NONE ? bytes : zlib.inflateSync(bytes);
  const n = header.tileWidth * header.tileLength;
  if (header.bitsPerSample === 16) {
    const out = new Uint16Array(n);
    for (let i = 0; i < n; i += 1) out[i] = raw.readUInt16LE(i * 2);
    return header.predictor === 2 ? unpredict(out, header.tileWidth, header.tileLength) : out;
  }
  if (header.bitsPerSample === 8) {
    const out = new Uint8Array(raw.subarray(0, n));
    if (header.predictor === 2) {
      for (let row = 0; row < header.tileLength; row += 1) {
        const base = row * header.tileWidth;
        for (let x = 1; x < header.tileWidth; x += 1) out[base + x] = (out[base + x] + out[base + x - 1]) & 0xff;
      }
    }
    return out;
  }
  throw new Error(`cog: ${header.bitsPerSample}-bit samples are not supported`);
}

/**
 * Which pixel holds a given point on the ground.
 *
 * The tiepoint says which map coordinate pixel (0,0) sits at and the pixel
 * scale says how many metres wide a pixel is; northing runs the opposite way to
 * the row index, because rows go down the image and northing goes up the map.
 */
export function pixelFor(header, eastingM, northingM) {
  const [sx, sy] = header.pixelScale || [];
  const tp = header.tiepoint || [];
  if (!(sx > 0) || !(sy > 0) || tp.length < 6) throw new Error('cog: the scene is missing its georeferencing tags');
  const originE = tp[3];
  const originN = tp[4];
  return {
    x: Math.floor((eastingM - originE) / sx),
    y: Math.floor((originN - northingM) / sy),
  };
}

/**
 * Read a rectangle of pixels, fetching only the tiles it touches.
 *
 * @param {object} header - from parseHeader
 * @param {(from:number,to:number)=>Promise<Buffer>} readRange - byte fetcher
 * @param {{x:number,y:number,width:number,height:number}} win
 * @returns {Promise<{data:Uint16Array|Uint8Array, width:number, height:number, x:number, y:number, tilesRead:number, bytesRead:number}>}
 */
export async function readWindow(header, readRange, win) {
  const x0 = Math.max(0, win.x);
  const y0 = Math.max(0, win.y);
  const x1 = Math.min(header.width, win.x + win.width);
  const y1 = Math.min(header.height, win.y + win.height);
  if (!(x1 > x0) || !(y1 > y0)) throw new Error('cog: the requested window is outside the scene');

  const w = x1 - x0;
  const h = y1 - y0;
  const out = header.bitsPerSample === 8 ? new Uint8Array(w * h) : new Uint16Array(w * h);

  const tx0 = Math.floor(x0 / header.tileWidth);
  const tx1 = Math.floor((x1 - 1) / header.tileWidth);
  const ty0 = Math.floor(y0 / header.tileLength);
  const ty1 = Math.floor((y1 - 1) / header.tileLength);

  let tilesRead = 0;
  let bytesRead = 0;
  for (let ty = ty0; ty <= ty1; ty += 1) {
    for (let tx = tx0; tx <= tx1; tx += 1) {
      const idx = ty * header.tilesAcross + tx;
      const offset = header.tileOffsets[idx];
      const length = header.tileByteCounts[idx];
      if (!length) continue;                       // an empty tile is all nodata
      const bytes = await readRange(offset, offset + length - 1);
      const tile = decodeTile(bytes, header);
      tilesRead += 1;
      bytesRead += length;

      const px0 = tx * header.tileWidth;
      const py0 = ty * header.tileLength;
      const cx0 = Math.max(x0, px0);
      const cx1 = Math.min(x1, px0 + header.tileWidth);
      const cy0 = Math.max(y0, py0);
      const cy1 = Math.min(y1, py0 + header.tileLength);
      for (let y = cy0; y < cy1; y += 1) {
        const src = (y - py0) * header.tileWidth;
        const dst = (y - y0) * w;
        for (let x = cx0; x < cx1; x += 1) out[dst + (x - x0)] = tile[src + (x - px0)];
      }
    }
  }
  return { data: out, width: w, height: h, x: x0, y: y0, tilesRead, bytesRead };
}

/** An HTTP byte-range reader for a URL, in the shape readWindow wants. */
export function httpRangeReader(url, { fetchImpl = fetch, label = 'cog' } = {}) {
  return async (from, to) => {
    const res = await fetchImpl(url, { headers: { range: `bytes=${from}-${to}`, 'user-agent': 'tp-surfcast/1.0' } });
    if (res.status !== 206 && res.status !== 200) throw new Error(`${label}: range request failed, ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
}
