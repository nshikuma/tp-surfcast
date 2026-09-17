/**
 * The Torrey Pines survey archive, found at last.
 *
 * The DOI written on the papers (10.6076/D1C88T) is not a Dryad DOI and does
 * not resolve through DataCite either, which is why two earlier attempts came
 * back 404 and the whole source was nearly written off. A DataCite search for
 * the title found it living somewhere else entirely:
 *
 *   10.5061/dryad.n5qb383  - with component DOIs for
 *     /22  Torrey Pines Beach Raw Sand Elevations
 *     /23  Torrey Pines Beach Binned Sand Elevations
 *     /24  Torrey Pines Beach Mapped Sand Elevations
 *     /25  Torrey Pines Beach Sand Level Survey Information
 *     /26  Torrey Pines Beach Characteristics
 *
 * This is the thing the forecast has been blind to, measured quarterly for
 * sixteen years by the people who invented the equilibrium shoreline model: the
 * actual shape of the sand at this beach, including how far out the bar sits,
 * how deep it is, and how all of that moves between summer and winter.
 *
 * Nothing is committed from here. This prints the file list with sizes and
 * types, and the first lines of anything small and textual, so the distilling
 * step is written against the real columns instead of against a guess about
 * them. The archive is a few hundred megabytes at most and the repository is
 * never going to hold it - what gets committed later is a summary: bar depth
 * and position by season and by preceding wave energy, which is all the model
 * needs and is a few kilobytes.
 */

const DOI = 'doi:10.5061/dryad.n5qb383';
const API = 'https://datadryad.org/api/v2';
const enc = encodeURIComponent(DOI);
const HEAD_BYTES = 4000;
const log = (s) => console.log(s);

async function json(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'tp-surfcast/1.0 (personal surf forecast; reconnaissance)' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function main() {
  const ds = await json(`${API}/datasets/${enc}`);
  log(`title:      ${ds.title}`);
  log(`authors:    ${(ds.authors || []).map((a) => `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim()).join('; ')}`);
  log(`storage:    ${(ds.storageSize / 1e6).toFixed(1)} MB`);
  log(`publication ISSN: ${ds.relatedPublicationISSN || '-'}`);
  log(`\nabstract:\n${(ds.abstract || '').replace(/<[^>]+>/g, '').slice(0, 1500)}`);
  if (ds.usageNotes) log(`\nusage notes:\n${ds.usageNotes.replace(/<[^>]+>/g, '').slice(0, 2500)}`);
  if (ds.locations?.length) log(`\nlocations: ${JSON.stringify(ds.locations).slice(0, 400)}`);
  if (ds.keywords?.length) log(`keywords: ${ds.keywords.join(', ')}`);

  // Versions, then the files of the newest one.
  const vers = await json(`${API}/datasets/${enc}/versions`);
  const list = vers._embedded?.['stash:versions'] || [];
  log(`\nversions: ${list.length}`);
  const latest = list[list.length - 1];
  if (!latest) { log('no versions - stopping'); return; }
  log(`latest version ${latest.versionNumber}, ${latest.lastModificationDate}`);

  const filesHref = latest._links?.['stash:files']?.href;

  // The file list is paginated and the Torrey Pines files sort after Cardiff
  // and Imperial, so the first page is all other people's beaches.
  const items = [];
  let next = `https://datadryad.org${filesHref}?per_page=100`;
  while (next && items.length < 400) {
    const page = await json(next);
    items.push(...(page._embedded?.['stash:files'] || []));
    const n = page._links?.next?.href;
    next = n ? `https://datadryad.org${n}` : null;
  }
  log(`\nfiles: ${items.length}`);
  for (const f of items) {
    log(`  ${String((f.size / 1e6).toFixed(2)).padStart(9)} MB  ${(f.mimeType || '').padEnd(28)} ${f.path}`);
  }
  if (items[0]) log(`\nlink keys on a file entry: ${Object.keys(items[0]._links || {}).join(', ')}`);

  // The API's own download route answers 401 "must have current bearer token"
  // even for a published, open dataset, so the route the website itself uses is
  // tried alongside it. Each candidate gets the same small range request and
  // the first one that returns bytes is the one a fetcher will use.
  const fileId = (f) => {
    const self = f._links?.self?.href || '';
    const m = self.match(/files\/(\d+)/);
    return m ? m[1] : null;
  };
  const routes = (f) => {
    const id = fileId(f);
    const api = f._links?.['stash:download']?.href;
    return [
      api ? ['stash:download', api.startsWith('http') ? api : `https://datadryad.org${api}`] : null,
      id ? ['file_stream', `https://datadryad.org/downloads/file_stream/${id}`] : null,
      id ? ['api file download', `https://datadryad.org/api/v2/files/${id}/download`] : null,
    ].filter(Boolean);
  };

  // One small text file and one small zip: enough to find a route that works
  // and to see the columns, the units, and whether elevations are MSL or
  // NAVD88, which decides whether any of this can sit next to the tides.
  const wanted = items.filter((f) => /README_for_torrey_binned|README_for_torrey_survey|README\.txt$|torrey_beach_characteristics\.zip|torrey_survey_info\.nc/.test(f.path));
  log(`\n--- trying download routes on ${wanted.length} small files ---`);
  for (const f of wanted) {
    log(`\n${f.path}  (${(f.size / 1e6).toFixed(2)} MB)`);
    for (const [name, url] of routes(f)) {
      try {
        const res = await fetch(url, { headers: { 'user-agent': 'tp-surfcast/1.0', range: `bytes=0-${HEAD_BYTES}` } });
        const buf = Buffer.from(await res.arrayBuffer());
        const looksText = /text|plain/.test(res.headers.get('content-type') || '') || /\.txt$/.test(f.path);
        log(`  ${name.padEnd(18)} ${res.status} ${res.headers.get('content-type') || ''} ${buf.length} bytes`);
        if (res.status === 200 || res.status === 206) {
          if (looksText) {
            log(buf.toString('utf8').split('\n').slice(0, 30).map((l) => `      ${l.slice(0, 200)}`).join('\n'));
          } else {
            log(`      first bytes ${buf.subarray(0, 8).toString('hex')} (PK 504b = zip, 8943 = netCDF-4/HDF5, 4344 = netCDF-3)`);
          }
          break;
        }
        log(`      ${buf.toString('utf8').slice(0, 160).replace(/\s+/g, ' ')}`);
      } catch (e) {
        log(`  ${name.padEnd(18)} failed: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  log('\nDone. Nothing stored.');
}

main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
