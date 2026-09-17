/**
 * Reconnaissance for the remaining visual-observation sources.
 *
 * Two quite different things are being looked for.
 *
 * 1. A PUBLIC STILL IMAGE of this beach, on a predictable URL. Coastal
 *    scientists locate sandbars by time-averaging camera frames: waves break
 *    over the bar and nowhere else, so in a ten-minute average the persistent
 *    white band marks the bar crest. That is an Argus timex, and it would
 *    measure the one thing this forecast is blind to - where the sand is.
 *    It only works if there is a still endpoint that can be fetched repeatedly
 *    without a login, so this checks rather than assumes.
 *
 * 2. PUBLISHED FIELD DATA from this exact beach. Torrey Pines is one of the
 *    most heavily instrumented beaches in the world - Scripps has run
 *    experiments here for decades - and the Ludka et al. survey series is
 *    sixteen years of quarterly bathymetry. An earlier attempt at the Dryad
 *    archive failed with a bare "fetch failed" and was never retried.
 *
 * Prints status, content type and size for every candidate. Nothing is parsed
 * and nothing is stored: this is a list of what is reachable.
 */

const CANDIDATES = [
  // --- cam stills -------------------------------------------------------
  { group: 'cam', name: 'Surfline spot report API (Torrey Pines)', kind: 'json',
    url: 'https://services.surfline.com/kbyg/spots/reports?spotId=584204204e65fad6a7709994' },
  { group: 'cam', name: 'Surfline cam list for the spot', kind: 'json',
    url: 'https://services.surfline.com/kbyg/spots/details?spotId=584204204e65fad6a7709994' },
  { group: 'cam', name: 'Scripps pier cam page', kind: 'html',
    url: 'https://scripps.ucsd.edu/piercam' },
  { group: 'cam', name: 'CDIP station page for 153p1', kind: 'html',
    url: 'https://cdip.ucsd.edu/m/products/?stn=153p1' },
  { group: 'cam', name: 'SIO coastal observing imagery index', kind: 'html',
    url: 'https://cdip.ucsd.edu/themes/media/docs/' },

  // --- field data -------------------------------------------------------
  { group: 'data', name: 'Dryad: Ludka et al. Torrey Pines surveys (metadata)', kind: 'json',
    url: 'https://datadryad.org/api/v2/datasets/doi%3A10.6076%2FD1C88T' },
  { group: 'data', name: 'Dryad search for Torrey Pines', kind: 'json',
    url: 'https://datadryad.org/api/v2/search?q=Torrey+Pines+beach+survey' },
  { group: 'data', name: 'CDIP MOP alongshore docs', kind: 'html',
    url: 'https://cdip.ucsd.edu/m/models/mop_alongshore/' },
  { group: 'data', name: 'USGS coastal change portal (search)', kind: 'json',
    url: 'https://www.sciencebase.gov/catalog/items?q=Torrey+Pines+beach&format=json&max=5' },
];

const TIMEOUT_MS = 15000;

async function probe(c) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(c.url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'tp-surfcast/1.0 (personal surf forecast; reconnaissance)' },
    });
    const type = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = Date.now() - started;
    console.log(`\n[${c.group}] ${c.name}`);
    console.log(`   ${res.status} ${res.statusText}  ${type}  ${buf.length} bytes  ${ms} ms`);
    console.log(`   ${c.url}`);

    if (!res.ok) {
      console.log(`   body: ${buf.toString('utf8').slice(0, 200).replace(/\s+/g, ' ')}`);
      return;
    }
    if (type.includes('json')) {
      let j;
      try { j = JSON.parse(buf.toString('utf8')); } catch { console.log('   (not parseable JSON)'); return; }
      // Hunt for anything that smells like an image or download URL.
      const hits = [];
      const walk = (o, path = '') => {
        if (hits.length > 12 || o == null) return;
        if (typeof o === 'string') {
          if (/\.(jpe?g|png|mp4|m3u8|zip|nc|csv)(\?|$)/i.test(o) || /still|cam|thumb|download/i.test(path)) {
            hits.push(`${path} = ${o.slice(0, 150)}`);
          }
          return;
        }
        if (typeof o !== 'object') return;
        for (const k of Object.keys(o)) walk(o[k], path ? `${path}.${k}` : k);
      };
      walk(j);
      console.log(`   top-level keys: ${Object.keys(j).slice(0, 12).join(', ')}`);
      if (hits.length) {
        console.log('   candidate media / download URLs:');
        for (const h of hits) console.log(`     ${h}`);
      } else {
        console.log('   no media-looking URLs found');
      }
      return;
    }
    if (type.startsWith('image/')) {
      console.log(`   IMAGE OK - ${buf.length} bytes, first bytes ${buf.subarray(0, 4).toString('hex')}`);
      return;
    }
    // HTML: pull out image and stream references.
    const html = buf.toString('utf8');
    const urls = [...html.matchAll(/(?:src|href|data-src)=["']([^"']+\.(?:jpe?g|png|m3u8|mp4)[^"']*)["']/gi)]
      .map((m) => m[1]);
    const streams = [...html.matchAll(/(https?:\/\/[^"'\s]*(?:m3u8|youtube\.com\/embed|youtu\.be)[^"'\s]*)/gi)]
      .map((m) => m[1]);
    const uniq = [...new Set([...urls, ...streams])].slice(0, 10);
    console.log(uniq.length ? `   media references:\n     ${uniq.join('\n     ')}` : '   no media references in the HTML');
  } catch (e) {
    console.log(`\n[${c.group}] ${c.name}`);
    console.log(`   FAILED: ${e.name === 'AbortError' ? `timed out after ${TIMEOUT_MS} ms` : e.message}`);
    console.log(`   ${c.url}`);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log('Looking for: (1) a public still image of this beach on a predictable URL,');
  console.log('             (2) published field data from Torrey Pines.\n');
  for (const c of CANDIDATES) {
    await probe(c);
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('\nDone. Nothing was stored; this is a reachability list.');
}

main().catch((e) => { console.error('probe crashed:', e); process.exit(1); });
