#!/usr/bin/env node
/**
 * Reconnaissance for real Torrey Pines bathymetry. Run from GitHub Actions,
 * which has open outbound network; the environment this was authored in does not.
 *
 * Two candidate sources, both from Scripps:
 *
 *  1. Ludka et al. (2019), "Sixteen years of bathymetry and waves at San Diego
 *     beaches", Scientific Data. 165 cross-shore transects at ~100 m alongshore
 *     spacing, quarterly from 2001, back beach to 8 m depth, binned to 5 m
 *     cross-shore on MOP lines. Torrey Pines is one of the surveyed beaches.
 *     This is the real seafloor, and enough surveys to build a SEASONAL
 *     climatology of the bar rather than guessing at one.
 *     Dryad: doi:10.5061/dryad.n5qb383
 *
 *  2. CDIP MOP (Monitoring and Prediction) - nearshore wave predictions every
 *     100 m alongshore, on the THREDDS server this project already reads
 *     successfully. Gives real alongshore-varying nearshore height instead of a
 *     single offshore number.
 *
 * This script only LOOKS. It prints what exists and in what shape, so the
 * parser can be written against reality instead of a guess.
 */

const OUT = [];
const log = (...a) => { const l = a.join(' '); OUT.push(l); console.log(l); };

async function get(url, { json = false, bytes = 0 } = {}) {
  try {
    return await getInner(url, { json, bytes });
  } catch (e) {
    const cause = e.cause ? ` (cause: ${e.cause.code || e.cause.message})` : '';
    return { ok: false, info: `FETCH FAILED: ${e.message}${cause}`, url };
  }
}

async function getInner(url, { json = false, bytes = 0 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'tp-surfcast probe (personal surf forecast)', Accept: json ? 'application/json' : '*/*' },
    redirect: 'follow',
  });
  const info = `HTTP ${res.status} ${res.headers.get('content-type') || ''} ${res.headers.get('content-length') || ''}`;
  if (!res.ok) return { ok: false, info };
  if (bytes) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, info, buf: buf.subarray(0, bytes) };
  }
  const text = await res.text();
  return { ok: true, info, text, json: json ? safeJson(text) : null };
}
const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

async function probeDryad() {
  log('\n=== 1. Dryad: Ludka et al. 2019 San Diego bathymetry ===');
  const doi = encodeURIComponent('doi:10.5061/dryad.n5qb383');
  const base = 'https://datadryad.org/api/v2';

  const ds = await get(`${base}/datasets/${doi}`, { json: true });
  log(`dataset metadata: ${ds.info}`);
  if (!ds.ok || !ds.json) { log('  could not read dataset metadata'); return; }
  log(`  title: ${ds.json.title || '(none)'}`);
  log(`  versions link: ${ds.json._links?.['stash:versions']?.href || '(none)'}`);

  const vHref = ds.json._links?.['stash:versions']?.href;
  if (!vHref) return;
  const versions = await get(`https://datadryad.org${vHref}`, { json: true });
  log(`versions: ${versions.info}`);
  const list = versions.json?._embedded?.['stash:versions'] || [];
  const latest = list[list.length - 1];
  if (!latest) { log('  no versions listed'); return; }
  log(`  latest version: ${latest.versionNumber} (${latest.lastModificationDate})`);

  const fHref = latest._links?.['stash:files']?.href;
  if (!fHref) { log('  no files link'); return; }
  let next = `https://datadryad.org${fHref}?per_page=100`;
  const files = [];
  while (next && files.length < 400) {
    const page = await get(next, { json: true });
    if (!page.ok || !page.json) break;
    (page.json._embedded?.['stash:files'] || []).forEach((f) => files.push(f));
    const n = page.json._links?.next?.href;
    next = n ? `https://datadryad.org${n}` : null;
  }
  log(`  ${files.length} files in the dataset:`);
  for (const f of files) {
    const mb = (f.size / 1e6).toFixed(1);
    const dl = f._links?.['stash:file-download']?.href || '';
    const flag = /torrey/i.test(f.path) ? '  <-- TORREY PINES' : '';
    log(`    ${String(mb).padStart(8)} MB  ${f.mimeType || ''}  ${f.path}${flag}`);
    if (dl) log(`                download: https://datadryad.org${dl}`);
  }

  // Confirm the format of the smallest Torrey file without pulling all of it.
  const torrey = files.filter((f) => /torrey/i.test(f.path)).sort((a, b) => a.size - b.size)[0];
  if (torrey) {
    const dl = torrey._links?.['stash:file-download']?.href;
    if (dl) {
      const head = await get(`https://datadryad.org${dl}`, { bytes: 8 });
      if (head.ok) {
        const magic = head.buf.toString('latin1', 0, 4);
        const kind = magic.startsWith('CDF') ? 'classic NetCDF-3 (parseable in plain JS)'
          : head.buf[0] === 0x89 && magic.slice(1) === 'HDF' ? 'NetCDF-4 / HDF5 (needs a library)'
          : `unknown (${[...head.buf].map((b) => b.toString(16)).join(' ')})`;
        log(`  format of ${torrey.path}: ${kind}`);
      }
    }
  }
}

async function probeMop() {
  log('\n=== 2. CDIP MOP alongshore nearshore predictions ===');
  const catalogs = [
    'https://thredds.cdip.ucsd.edu/thredds/catalog/cdip/model/MOP_alongshore/catalog.xml',
    'https://thredds.cdip.ucsd.edu/thredds/catalog/cdip/model/MOP_validation/catalog.xml',
  ];
  for (const url of catalogs) {
    const r = await get(url);
    log(`${url.split('/').slice(-2)[0]}: ${r.info}`);
    if (!r.ok) continue;
    const names = [...r.text.matchAll(/urlPath="([^"]+)"/g)].map((m) => m[1]);
    log(`  ${names.length} datasets`);
    // San Diego county MOP lines are the D0### series; Torrey Pines sits in the
    // upper D05xx-D06xx range. Print the neighbourhood so the right line can be
    // picked by its published latitude rather than by guessing.
    const sd = names.filter((n) => /D0[56]\d\d/.test(n));
    log(`  San Diego D05xx/D06xx lines found: ${sd.length}`);
    log(`  sample: ${sd.slice(0, 12).join(', ') || '(none)'}`);
  }
}


/* -------------------------------------------------------- NetCDF-3 header -- */

/**
 * Minimal classic-NetCDF header reader. Enough to print dimensions, variables
 * and attributes so the real parser can be written against the actual layout
 * instead of a guess. Does not read data, and does not handle NetCDF-4/HDF5.
 */
function readNetcdfHeader(buf) {
  let o = 0;
  const u32 = () => { const v = buf.readUInt32BE(o); o += 4; return v; };
  const i32 = () => { const v = buf.readInt32BE(o); o += 4; return v; };
  const pad = () => { while (o % 4) o++; };
  const str = () => { const n = u32(); const s = buf.toString('utf8', o, o + n); o += n; pad(); return s; };
  const TYPES = { 1: 'byte', 2: 'char', 3: 'short', 4: 'int', 5: 'float', 6: 'double' };

  const magic = buf.toString('latin1', 0, 3);
  if (magic !== 'CDF') return { error: `not classic NetCDF (magic ${magic})` };
  const version = buf[3];
  o = 4;
  i32(); // numrecs

  const listOf = (tag, read) => {
    const t = u32(); const n = u32();
    if (t === 0 && n === 0) return [];
    if (t !== tag) return [];
    const out = [];
    for (let i = 0; i < n; i++) out.push(read());
    return out;
  };

  const dims = listOf(0x0A, () => ({ name: str(), size: u32() }));
  const attrs = () => listOf(0x0C, () => {
    const name = str(); const type = u32(); const n = u32();
    const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 }[type] || 1;
    let value = null;
    if (type === 2) value = buf.toString('utf8', o, o + n).replace(/\0+$/, '');
    o += n * size; pad();
    return { name, type: TYPES[type], value };
  });
  const gatts = attrs();
  const vars = listOf(0x0B, () => {
    const name = str();
    const nd = u32(); const d = [];
    for (let i = 0; i < nd; i++) d.push(i32());
    const va = attrs();
    const type = u32(); u32(); version === 2 ? (o += 8) : u32();
    return { name, dims: d.map((i) => dims[i] && dims[i].name), type: TYPES[type], attrs: va };
  });
  return { version, dims, gatts, vars };
}

async function probeTorreyStructure() {
  log('\n=== 3. Torrey Pines file structure ===');
  const doi = encodeURIComponent('doi:10.5061/dryad.n5qb383');
  const base = 'https://datadryad.org/api/v2';
  const ds = await get(`${base}/datasets/${doi}`, { json: true });
  const vHref = ds.json?._links?.['stash:versions']?.href;
  const versions = await get(`https://datadryad.org${vHref}`, { json: true });
  const list = versions.json?._embedded?.['stash:versions'] || [];
  const latest = list[list.length - 1];
  const fHref = latest?._links?.['stash:files']?.href;
  let next = `https://datadryad.org${fHref}?per_page=100`;
  const files = [];
  while (next && files.length < 400) {
    const page = await get(next, { json: true });
    if (!page.ok || !page.json) break;
    (page.json._embedded?.['stash:files'] || []).forEach((f) => files.push(f));
    const n = page.json._links?.next?.href;
    next = n ? `https://datadryad.org${n}` : null;
  }
  const byName = {};
  files.forEach((f) => { byName[f.path] = f; });

  // The READMEs are a few KB and describe the layout exactly.
  for (const name of [
    'README.txt',
    'README_for_torrey_binned_sand_elevations.txt',
    'README_for_torrey_beach_characteristics.txt',
    'README_for_torrey_survey_info.txt',
  ]) {
    const f = byName[name];
    if (!f) { log(`\n--- ${name}: not found`); continue; }
    // Dryad exposes two shapes for the same bytes; try both before giving up.
    const candidates = [];
    const dl = f._links?.['stash:file-download']?.href;
    if (dl) candidates.push(`https://datadryad.org${dl}`);
    const self = f._links?.self?.href;
    if (self) candidates.push(`https://datadryad.org${self}/download`);
    let got = null;
    for (const u of candidates) {
      const r = await get(u);
      log(`\n--- ${name} via ${u}`);
      log(`    ${r.info}`);
      if (r.ok && r.text) { got = r; break; }
    }
    if (got) log(got.text.slice(0, 4500));
    else log('  (could not read this file)');
  }

  // Header of the small survey-info file: names the surveys and coverage.
  const info = byName['torrey_survey_info.nc'];
  if (info) {
    const dl = info._links?.['stash:file-download']?.href;
    const r = await get(`https://datadryad.org${dl}`, { bytes: 200000 });
    if (r.ok) {
      const h = readNetcdfHeader(r.buf);
      log('\n--- torrey_survey_info.nc header ---');
      if (h.error) log('  ' + h.error);
      else {
        log(`  netcdf version ${h.version}`);
        log('  dimensions: ' + h.dims.map((d) => `${d.name}=${d.size}`).join(', '));
        h.gatts.slice(0, 12).forEach((a) => log(`  :${a.name} = ${String(a.value).slice(0, 160)}`));
        h.vars.forEach((v) => {
          const units = (v.attrs.find((a) => a.name === 'units') || {}).value || '';
          log(`  ${v.type} ${v.name}(${v.dims.join(', ')})  ${units}`);
        });
      }
    }
  }
}

async function probeMopLines() {
  log('\n=== 4. Which MOP line is the north lot? ===');
  // The north lot is at 32.9340 N, -117.2585 E.
  const TARGET = 32.9340;
  const base = 'https://thredds.cdip.ucsd.edu/thredds/dodsC/cdip/model/MOP_alongshore';
  const found = [];
  for (let n = 500; n <= 700; n += 10) {
    const id = 'D0' + String(n).padStart(3, '0');
    const r = await get(`${base}/${id}_nowcast.nc.ascii?metaLatitude,metaLongitude`);
    if (!r.ok) continue;
    const nums = (r.text.match(/-?\d+\.\d+/g) || []).map(Number);
    if (nums.length >= 2) found.push({ id, lat: nums[0], lon: nums[1] });
  }
  found.sort((a, b) => Math.abs(a.lat - TARGET) - Math.abs(b.lat - TARGET));
  log(`  sampled ${found.length} lines; closest to the north lot:`);
  found.slice(0, 6).forEach((f) => log(`    ${f.id}  ${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}  (${((f.lat - TARGET) * 111000).toFixed(0)} m away)`));
  if (found.length) {
    log('  MOP lines are ~100 m apart, so the exact line is within a few of the closest sample.');
  }
}


async function probeMopStructure() {
  log('\n=== 5. MOP file structure and the north lot line span ===');
  const base = 'https://thredds.cdip.ucsd.edu/thredds/dodsC/cdip/model/MOP_alongshore';

  // What variables does a MOP forecast carry?
  for (const kind of ['forecast', 'nowcast']) {
    const r = await get(`${base}/D0590_${kind}.nc.dds`);
    log(`\n--- D0590_${kind}.nc.dds (${r.info}) ---`);
    if (r.ok) log(r.text.slice(0, 2500));
  }

  // Attributes tell us units, datums and any per-line shore normal.
  const das = await get(`${base}/D0590_forecast.nc.das`);
  log(`\n--- D0590_forecast.nc.das (${das.info}) ---`);
  if (das.ok) {
    // Keep it to the metadata block and the wave variables we care about.
    const keep = das.text.split(/\n/).filter((l) => /meta|wave(Hs|Tp|Dp|Time|Ta)|shore|depth|units|datum/i.test(l));
    log(keep.slice(0, 90).join('\n'));
  }

  // The real geometry of the beach: every line across the north lot stretch.
  log('\n--- alongshore line geometry around the north lot ---');
  const rows = [];
  for (let n = 583; n <= 601; n++) {
    const id = 'D0' + String(n).padStart(3, '0');
    const r = await get(`${base}/${id}_forecast.nc.ascii?metaLatitude,metaLongitude`);
    if (!r.ok) { log(`  ${id}: ${r.info}`); continue; }
    const nums = (r.text.match(/-?\d+\.\d+/g) || []).map(Number);
    if (nums.length >= 2) rows.push({ id, lat: nums[0], lon: nums[1] });
  }
  rows.forEach((p, i) => {
    let bearing = '';
    if (i > 0) {
      const prev = rows[i - 1];
      const dy = (p.lat - prev.lat) * 111320;
      const dx = (p.lon - prev.lon) * 111320 * Math.cos(p.lat * Math.PI / 180);
      bearing = `  step ${Math.hypot(dx, dy).toFixed(0)} m, bearing ${((Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360).toFixed(0)}deg`;
    }
    log(`  ${p.id}  ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}${bearing}`);
  });

  // One small slice of real forecast values, to confirm shape and units.
  const slice = await get(`${base}/D0590_forecast.nc.ascii?waveTime[0:1:5],waveHs[0:1:5],waveTp[0:1:5],waveDp[0:1:5]`);
  log(`\n--- D0590 first forecast hours (${slice.info}) ---`);
  if (slice.ok) log(slice.text.slice(0, 1800));
}


async function probeMopAsciiRaw() {
  log('\n=== 6. RAW OPeNDAP ascii for a MOP scalar + array query ===');
  const base = 'https://thredds.cdip.ucsd.edu/thredds/dodsC/cdip/model/MOP_alongshore';
  const url = `${base}/D0590_forecast.nc.ascii?metaLatitude,metaLongitude,metaWaterDepth,metaShoreNormal,waveTime[0:1:2],waveHs[0:1:2]`;
  const r = await get(url);
  log(`  ${r.info}`);
  if (!r.ok) return;
  log('  ---- raw response, line by line, with escapes visible ----');
  r.text.split(/\r?\n/).forEach((line, i) => log(`  ${String(i).padStart(3)}| ${JSON.stringify(line)}`));
}

(async () => {
  log(`probe run ${new Date().toISOString()}`);
  for (const [name, fn] of [['dryad', probeDryad], ['mop', probeMop], ['structure', probeTorreyStructure], ['mop-lines', probeMopLines], ['mop-structure', probeMopStructure], ['mop-raw', probeMopAsciiRaw]]) {
    try { await fn(); } catch (e) { log(`\n!! ${name} probe failed: ${e.message}`); }
  }
  log('\nDone. Paste this output back into the session to have the parser written against it.');
})();
