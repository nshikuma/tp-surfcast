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

  const downloadHref = (f) => {
    const l = f._links || {};
    const h = l['stash:file-download']?.href || l['stash:download']?.href || l.download?.href || l.self?.href;
    return h ? (h.startsWith('http') ? h : `https://datadryad.org${h}`) : null;
  };

  // The first few kilobytes of each README and small text file: enough to see
  // the columns, the units, and whether elevations are MSL or NAVD88, which
  // decides whether any of this can be put next to the tide predictions.
  log('\n--- heads of the small text files ---');
  for (const f of items) {
    const textish = /text|csv|plain/i.test(f.mimeType || '') || /\.(csv|txt|md)$/i.test(f.path);
    if (!textish || f.size > 40e6) continue;
    const href = downloadHref(f);
    if (!href) { log(`\n${f.path}: no download link (${Object.keys(f._links || {}).join(', ')})`); continue; }
    try {
      const res = await fetch(href, { headers: { 'user-agent': 'tp-surfcast/1.0', range: `bytes=0-${HEAD_BYTES}` } });
      const txt = (await res.text()).slice(0, HEAD_BYTES);
      log(`\n${f.path}  (${res.status}, showing first lines)`);
      log(txt.split('\n').slice(0, 30).map((l) => `    ${l.slice(0, 220)}`).join('\n'));
    } catch (e) {
      log(`\n${f.path}: fetch failed - ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  log('\nDone. Nothing stored.');
}

main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
