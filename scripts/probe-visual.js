/**
 * Reconnaissance for the remaining visual-observation sources, round two.
 *
 * WHAT ROUND ONE FOUND, so it is not repeated:
 *   - Surfline's spot APIs answer 403 to anything that is not their own app.
 *   - The Scripps pier cam page returns 70 kB of site chrome and not one frame
 *     of water: the cam is injected by script, so the still is not in the HTML.
 *   - The CDIP station page is the same - logos only.
 *   - The Ludka DOI 10.6076/D1C88T is not a Dryad dataset; Dryad answers
 *     not-found. It is a UC San Diego Library prefix, so it needs resolving
 *     through DataCite rather than guessing at a repository.
 *   - ScienceBase sits behind Cloudflare and answers 403 to a plain client.
 *
 * So round one killed the obvious cam sources. This round goes after the two
 * things that would actually work.
 *
 * 1. SATELLITE, instead of a cam. Sentinel-2 carries 10 m visible bands and
 *    revisits this coast every five days, and the surf zone is the brightest
 *    thing in the scene: breaking waves are white water, white water sits over
 *    the bar, and the shoreline is a hard line between wet and dry sand. It is
 *    a coarser instrument than an Argus timex and it only sees the beach when
 *    the sky is clear, but it is public, it is licence-clean, and it needs no
 *    account: AWS hosts the whole archive as cloud-optimised GeoTIFF and
 *    Element 84 runs an open STAC search over it. Nothing else on this list
 *    can be relied on for years without somebody's permission.
 *
 * 2. THE DOI, resolved properly. DataCite knows where every registered DOI
 *    actually lives, including which files it holds, so one lookup settles
 *    whether the sixteen-year survey series is downloadable or whether it
 *    needs an email to Scripps.
 *
 * The public cam candidates are still tested, because being wrong about that
 * would be worth knowing. Surfline's own still CDN is deliberately NOT probed:
 * their terms forbid it, and a forecast that beats them by scraping them is
 * not the thing being built.
 *
 * Prints status, content type and size for every candidate. Nothing is parsed
 * and nothing is stored: this is a list of what is reachable.
 */

/** Torrey Pines north lot, a box tight enough to hit one Sentinel-2 tile. */
const BBOX = [-117.2800, 32.8900, -117.2350, 32.9500];

const CANDIDATES = [
  // --- satellite: the real candidate ------------------------------------
  { group: 'sat', name: 'Element 84 Earth Search, Sentinel-2 L2A over the north lot', kind: 'json',
    url: `https://earth-search.aws.element84.com/v1/search?collections=sentinel-2-l2a`
      + `&bbox=${BBOX.join(',')}&limit=3&sortby=-properties.datetime` },
  { group: 'sat', name: 'Earth Search collections (is the archive open at all)', kind: 'json',
    url: 'https://earth-search.aws.element84.com/v1/collections' },
  { group: 'sat', name: 'Copernicus Data Space STAC search', kind: 'json',
    url: `https://catalogue.dataspace.copernicus.eu/stac/collections` },
  { group: 'sat', name: 'USGS Landsat STAC (coarser, but 40 years deep)', kind: 'json',
    url: `https://landsatlook.usgs.gov/stac-server/collections` },

  // --- the DOI, resolved through the registry ---------------------------
  { group: 'data', name: 'DataCite: the Ludka Torrey Pines survey DOI', kind: 'json',
    url: 'https://api.datacite.org/dois/10.6076/D1C88T' },
  { group: 'data', name: 'DataCite search: Torrey Pines bathymetry', kind: 'json',
    url: 'https://api.datacite.org/dois?query=%22Torrey+Pines%22+AND+(bathymetry+OR+survey)&page%5Bsize%5D=5' },
  { group: 'data', name: 'What that Dryad hit from round one actually is', kind: 'json',
    url: 'https://datadryad.org/api/v2/datasets/doi%3A10.5061%2Fdryad.n5qb383' },
  { group: 'data', name: 'Zenodo: Torrey Pines nearshore', kind: 'json',
    url: 'https://zenodo.org/api/records?q=%22Torrey+Pines%22+beach&size=5' },

  // --- cams, the long shots ---------------------------------------------
  { group: 'cam', name: 'HPWREN camera index (UCSD, openly published stills)', kind: 'html',
    url: 'https://hpwren.ucsd.edu/cameras/' },
  { group: 'cam', name: 'CORDC, the Scripps group that runs the coastal cameras', kind: 'html',
    url: 'https://cordc.ucsd.edu/' },
  { group: 'cam', name: 'Scripps pier cam page, scripts as well as images', kind: 'deep-html',
    url: 'https://scripps.ucsd.edu/piercam' },
];

const TIMEOUT_MS = 20000;

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
    if (type.includes('json')) return reportJson(c, buf);
    if (type.startsWith('image/')) {
      console.log(`   IMAGE OK - ${buf.length} bytes, first bytes ${buf.subarray(0, 4).toString('hex')}`);
      return;
    }
    return reportHtml(c, buf.toString('utf8'));
  } catch (e) {
    console.log(`\n[${c.group}] ${c.name}`);
    console.log(`   FAILED: ${e.name === 'AbortError' ? `timed out after ${TIMEOUT_MS} ms` : e.message}`);
    console.log(`   ${c.url}`);
  } finally {
    clearTimeout(timer);
  }
}

function reportJson(c, buf) {
  let j;
  try { j = JSON.parse(buf.toString('utf8')); } catch { console.log('   (not parseable JSON)'); return; }
  console.log(`   top-level keys: ${Object.keys(j).slice(0, 12).join(', ')}`);

  // A STAC search answers with features; what matters is whether any scene
  // covers this beach, how cloudy it was, and whether the pixels are fetchable
  // without a signature on the URL.
  if (Array.isArray(j.features)) {
    console.log(`   STAC features returned: ${j.features.length} (matched ${j.numberMatched ?? '?'})`);
    for (const f of j.features.slice(0, 3)) {
      const p = f.properties || {};
      const visual = f.assets?.visual || f.assets?.rendered_preview || f.assets?.thumbnail;
      console.log(`     ${p.datetime}  cloud ${p['eo:cloud_cover'] ?? '?'}%  ${f.id}`);
      if (visual) console.log(`       visual asset: ${String(visual.href).slice(0, 160)}`);
      const names = Object.keys(f.assets || {});
      if (names.length) console.log(`       assets: ${names.slice(0, 14).join(', ')}`);
    }
    return;
  }
  if (Array.isArray(j.collections)) {
    const ids = j.collections.map((x) => x.id);
    console.log(`   collections: ${ids.length} - ${ids.slice(0, 10).join(', ')}`);
    return;
  }

  // DataCite and Zenodo: title, and anything downloadable.
  const attrs = j.data?.attributes;
  if (attrs) {
    console.log(`   title: ${(attrs.titles?.[0]?.title || '').slice(0, 140)}`);
    console.log(`   publisher: ${attrs.publisher?.name || attrs.publisher || '?'}  year ${attrs.publicationYear || '?'}`);
    console.log(`   landing page: ${attrs.url || '?'}`);
    const media = (j.data.relationships?.media && attrs.contentUrl) || attrs.contentUrl;
    if (media) console.log(`   contentUrl: ${JSON.stringify(media).slice(0, 300)}`);
  }
  if (Array.isArray(j.data) && j.data.length && j.data[0].attributes?.titles) {
    for (const d of j.data.slice(0, 5)) {
      console.log(`     ${d.attributes.doi}  ${(d.attributes.titles[0]?.title || '').slice(0, 110)}`);
    }
  }
  if (Array.isArray(j.hits?.hits)) {
    for (const h of j.hits.hits.slice(0, 5)) {
      console.log(`     ${h.doi}  ${(h.metadata?.title || h.title || '').slice(0, 110)}`);
      for (const f of (h.files || []).slice(0, 3)) console.log(`       file: ${f.key} ${f.size} bytes ${f.links?.self || ''}`);
    }
  }

  const hits = [];
  const walk = (o, path = '') => {
    if (hits.length > 10 || o == null) return;
    if (typeof o === 'string') {
      if (/\.(jpe?g|png|mp4|m3u8|zip|nc|csv|tif)(\?|$)/i.test(o)) hits.push(`${path} = ${o.slice(0, 150)}`);
      return;
    }
    if (typeof o !== 'object') return;
    for (const k of Object.keys(o)) walk(o[k], path ? `${path}.${k}` : k);
  };
  walk(j);
  if (hits.length) {
    console.log('   candidate media / download URLs:');
    for (const h of hits) console.log(`     ${h}`);
  }
}

function reportHtml(c, html) {
  const urls = [...html.matchAll(/(?:src|href|data-src)=["']([^"']+\.(?:jpe?g|png|m3u8|mp4)[^"']*)["']/gi)].map((m) => m[1]);
  const streams = [...html.matchAll(/(https?:\/\/[^"'\s]*(?:m3u8|youtube\.com\/embed|youtu\.be)[^"'\s]*)/gi)].map((m) => m[1]);
  const uniq = [...new Set([...urls, ...streams])].filter((u) => !/favicon|logo|icon/i.test(u)).slice(0, 12);
  console.log(uniq.length ? `   media references:\n     ${uniq.join('\n     ')}` : '   no media references in the HTML');

  if (c.kind !== 'deep-html') return;
  // Round one proved the still is not in the markup. So look at what the page
  // loads and what it names: an iframe, a script bundle, or a bare mention of a
  // streaming host is enough to follow next time.
  const iframes = [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  if (iframes.length) console.log(`   iframes:\n     ${iframes.slice(0, 8).join('\n     ')}`);
  const named = [...new Set([...html.matchAll(/(https?:\/\/[^"'\s<>]{6,160})/gi)].map((m) => m[1])
    .filter((u) => /cam|stream|video|wowza|live|kaltura|vimeo|brightcove|ipcamlive|angelcam/i.test(u)))];
  console.log(named.length ? `   URLs that mention a camera or a stream:\n     ${named.slice(0, 12).join('\n     ')}`
    : '   nothing in the page names a camera host');
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  console.log(`   scripts loaded: ${scripts.length}${scripts.length ? ` e.g. ${scripts.slice(0, 5).join(' ')}` : ''}`);
}

async function main() {
  console.log('Round two. Round one killed the easy cam sources; this goes after');
  console.log('satellite imagery and the survey DOI, and gives the cams one more look.\n');
  for (const c of CANDIDATES) {
    await probe(c);
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('\nDone. Nothing was stored; this is a reachability list.');
}

main().catch((e) => { console.error('probe crashed:', e); process.exit(1); });
