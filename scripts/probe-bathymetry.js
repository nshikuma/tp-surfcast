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

(async () => {
  log(`probe run ${new Date().toISOString()}`);
  for (const [name, fn] of [['dryad', probeDryad], ['mop', probeMop]]) {
    try { await fn(); } catch (e) { log(`\n!! ${name} probe failed: ${e.message}`); }
  }
  log('\nDone. Paste this output back into the session to have the parser written against it.');
})();
