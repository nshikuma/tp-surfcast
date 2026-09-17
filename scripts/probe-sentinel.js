/**
 * Can this forecast look at the beach from orbit?
 *
 * There is no public webcam of this beach that can be fetched on a schedule -
 * three rounds of probing settled that, and the one cam Scripps points at the
 * water is a Surfline embed. So the substitute for a camera is a satellite.
 *
 * Sentinel-2 carries 10 m visible and near-infrared bands and, with three
 * spacecraft flying, passes this coast every day or two; the Earth Search
 * catalogue already reported 1855 scenes over the north lot, newest yesterday.
 * Near-infrared is the useful part: water absorbs it almost completely and sand
 * reflects it strongly, so the waterline is a hard edge in NIR, and breaking
 * waves - white water, full of bubbles - are bright in every band. Where the
 * white water sits is where the bar is. That is the single thing this model has
 * never been able to measure.
 *
 * The scenes are cloud-optimised GeoTIFFs on public S3 with no credentials
 * needed, and the point of being cloud-optimised is that a reader can fetch the
 * header, work out which internal tile covers a 2 km stretch of beach, and
 * range-request just that tile - a few tens of kilobytes instead of a 100 MB
 * scene. Whether that is actually possible here depends on details the
 * catalogue does not state: whether the S3 objects accept a Range header
 * anonymously, how the tiles are laid out, and which compression is used.
 *
 * So this reads the TIFF header and reports the structure. It does not decode
 * imagery and it stores nothing. If the answers are the expected ones, a real
 * reader is maybe two hundred lines; if they are not, this is where that gets
 * found out, before any of it is written.
 */

const STAC = 'https://earth-search.aws.element84.com/v1/search';
const BBOX = [-117.2800, 32.8900, -117.2350, 32.9500];

const TAG = {
  256: 'ImageWidth', 257: 'ImageLength', 258: 'BitsPerSample', 259: 'Compression',
  262: 'PhotometricInterpretation', 277: 'SamplesPerPixel', 322: 'TileWidth',
  323: 'TileLength', 324: 'TileOffsets', 325: 'TileByteCounts', 339: 'SampleFormat',
  33550: 'ModelPixelScale', 33922: 'ModelTiepoint', 34735: 'GeoKeyDirectory',
  42113: 'GDAL_NODATA', 34736: 'GeoDoubleParams', 34737: 'GeoAsciiParams',
};
const COMPRESSION = { 1: 'none', 5: 'LZW', 7: 'JPEG', 8: 'Deflate/zip', 32773: 'PackBits', 50001: 'WebP', 34887: 'LERC', 50000: 'ZSTD' };
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

const log = (s) => console.log(s);

async function range(url, from, to) {
  const res = await fetch(url, { headers: { range: `bytes=${from}-${to}`, 'user-agent': 'tp-surfcast/1.0' } });
  return { status: res.status, acceptRanges: res.headers.get('accept-ranges'), length: res.headers.get('content-length'), buf: Buffer.from(await res.arrayBuffer()) };
}

/** Minimal TIFF/BigTIFF IFD walk. Only enough to describe the layout. */
function readIfds(buf) {
  const le = buf.toString('ascii', 0, 2) === 'II';
  const magic = le ? buf.readUInt16LE(2) : buf.readUInt16BE(2);
  const big = magic === 43;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u64 = (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  log(`byte order: ${le ? 'little' : 'big'}-endian, magic ${magic} (${big ? 'BigTIFF' : 'classic TIFF'})`);

  let next = big ? u64(8) : u32(4);
  const ifds = [];
  for (let n = 0; n < 8 && next && next + 8 < buf.length; n += 1) {
    const count = big ? u64(next) : u16(next);
    const entrySize = big ? 20 : 12;
    const base = next + (big ? 8 : 2);
    if (base + count * entrySize > buf.length) { log(`IFD ${n}: header extends past the ${buf.length} bytes fetched`); break; }
    const tags = {};
    for (let i = 0; i < count; i += 1) {
      const e = base + i * entrySize;
      const tag = u16(e);
      const type = u16(e + 2);
      const num = big ? u64(e + 4) : u32(e + 4);
      const valOff = e + (big ? 12 : 8);
      const inline = (TYPE_SIZE[type] || 1) * num <= (big ? 8 : 4);
      let value = null;
      if (inline) {
        if (type === 3) value = u16(valOff);
        else if (type === 4) value = u32(valOff);
        else if (type === 16) value = u64(valOff);
      } else {
        const off = big ? u64(valOff) : u32(valOff);
        value = `@${off}`;
        if (type === 12 && off + 8 * Math.min(num, 6) < buf.length) {
          const ds = [];
          for (let k = 0; k < Math.min(num, 6); k += 1) ds.push(le ? buf.readDoubleLE(off + k * 8) : buf.readDoubleBE(off + k * 8));
          value = ds.map((d) => Number(d.toFixed(4)));
        }
      }
      tags[TAG[tag] || tag] = { type, count: num, value };
    }
    ifds.push(tags);
    next = big ? u64(base + count * entrySize) : u32(base + count * entrySize);
  }
  return ifds;
}

function describe(ifds) {
  ifds.forEach((t, i) => {
    const w = t.ImageWidth?.value, h = t.ImageLength?.value;
    const tw = t.TileWidth?.value, th = t.TileLength?.value;
    const comp = t.Compression?.value;
    log(`  IFD ${i}${i ? ' (overview)' : ' (full res)'}: ${w} x ${h} px`
      + `, tiles ${tw} x ${th}`
      + `, compression ${comp} (${COMPRESSION[comp] || '?'})`
      + `, bits ${t.BitsPerSample?.value ?? '?'}`
      + `, samples ${t.SamplesPerPixel?.value ?? 1}`
      + `, tile offsets count ${t.TileOffsets?.count ?? '-'}`);
    if (i === 0) {
      log(`     pixel scale: ${JSON.stringify(t.ModelPixelScale?.value)}`);
      log(`     tiepoint:    ${JSON.stringify(t.ModelTiepoint?.value)}`);
    }
  });
}

async function main() {
  const url = `${STAC}?collections=sentinel-2-l2a&bbox=${BBOX.join(',')}`
    + '&limit=8&sortby=-properties.datetime&query=%7B%22eo%3Acloud_cover%22%3A%7B%22lt%22%3A20%7D%7D';
  const res = await fetch(url, { headers: { 'user-agent': 'tp-surfcast/1.0' } });
  const j = await res.json();
  log(`STAC search: ${res.status}, ${j.features?.length ?? 0} clear-ish scenes of ${j.numberMatched ?? '?'} matched\n`);
  for (const f of (j.features || []).slice(0, 8)) {
    log(`  ${f.properties.datetime}  cloud ${Number(f.properties['eo:cloud_cover']).toFixed(1)}%  ${f.id}`);
  }
  const feat = (j.features || [])[0];
  if (!feat) { log('no scenes - stopping'); return; }

  log(`\nasset names on the newest scene:\n  ${Object.keys(feat.assets).join(', ')}`);
  for (const name of ['nir', 'green', 'red', 'visual', 'swir16', 'scl']) {
    const a = feat.assets[name];
    if (a) log(`  ${name.padEnd(8)} ${a.type || ''}  ${a.href}`);
  }

  // The question that decides everything: does the object serve a byte range
  // to an anonymous client, and is the header enough to locate a tile?
  const target = feat.assets.nir || feat.assets.visual;
  log(`\nrange-reading the first 64 kB of ${target.href}`);
  const head = await range(target.href, 0, 65535);
  log(`  status ${head.status} (206 means ranges work), accept-ranges: ${head.acceptRanges}, got ${head.buf.length} bytes`);
  if (head.status !== 206) {
    log('  Ranges are not being served anonymously. A reader would have to pull whole scenes,');
    log('  which is 100 MB a time and not something to run every three hours.');
    return;
  }

  log('\nTIFF structure:');
  const ifds = readIfds(head.buf);
  describe(ifds);

  log('\nWhat this means for a reader:');
  const t0 = ifds[0];
  const tiles = t0?.TileWidth?.value && t0?.ImageWidth?.value
    ? Math.ceil(t0.ImageWidth.value / t0.TileWidth.value) * Math.ceil(t0.ImageLength.value / t0.TileLength.value)
    : null;
  if (tiles) {
    log(`  the full-resolution band is ${tiles} tiles; the beach fits inside one or two of them,`);
    log('  so one scene costs a header read plus a couple of tile reads.');
  }
  log('  Nothing was decoded and nothing was stored.');
}

main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
