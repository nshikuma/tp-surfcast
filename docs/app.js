/* tp-surfcast2 - page logic.
 *
 * Charts are hand-built inline SVG: no CDN, no build step, and they re-render
 * at true pixel size on resize so axis text stays legible on a phone instead of
 * being scaled down by a viewBox.
 *
 * Colour is assigned by physical domain, not by panel: swell is blue, wind is
 * orange, tide is aqua. Each panel carries exactly one measure on one axis.
 */

const TZ = 'America/Los_Angeles';
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, kids = []) => {
  const n = tag === 'svg' || SVG_TAGS.has(tag)
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'class') n.setAttribute('class', v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) if (kid) n.appendChild(kid);
  return n;
};
const SVG_TAGS = new Set(['g', 'path', 'line', 'rect', 'circle', 'text', 'polyline', 'polygon', 'defs', 'linearGradient', 'stop', 'title']);

/* ------------------------------------------------------------ formatting -- */

const fmtTime = (iso, opts = {}) =>
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', ...opts }).format(new Date(iso));
const fmtHour = (iso) =>
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric' }).format(new Date(iso)).toLowerCase().replace(' ', '');
const fmtDate = (dateStr, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(new Date(`${dateStr}T12:00:00Z`));
const n1 = (x) => (Number.isFinite(x) ? (Math.round(x * 10) / 10).toFixed(1) : '--');
const n0 = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '--');
/** Collapse a range to one number when the two ends round to the same value. */
const range1 = (a, b) => (Math.abs((b ?? 0) - (a ?? 0)) < 0.35 ? n1(b) : `${n1(a)}–${n1(b)}`);
/** "Mon 14" - Intl puts weekday after the day number for this combination. */
const dayTick = (dateStr) => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(d);
  return `${wd} ${d.getUTCDate()}`;
};

/** Face height is the default. The toggle halves it for the Hawaiian scale. */
let unitMode = localStorage.getItem('tp-units') || 'face';
const sizeVal = (faceFt) => (unitMode === 'face' ? faceFt : faceFt / 2);
const sizeUnit = () => (unitMode === 'face' ? 'ft face' : 'ft Haw');

const GRADE_COLORS = [
  { min: 88, key: 'good', color: 'var(--good)', icon: '●' },
  { min: 72, key: 'good', color: 'var(--good)', icon: '●' },
  { min: 56, key: 'warning', color: 'var(--warning)', icon: '◐' },
  { min: 40, key: 'serious', color: 'var(--serious)', icon: '◑' },
  { min: 0, key: 'critical', color: 'var(--critical)', icon: '○' },
];
const gradeStyle = (score) => GRADE_COLORS.find((g) => score >= g.min) || GRADE_COLORS[GRADE_COLORS.length - 1];

/** Grade chip: colour never carries the meaning alone - the word is always there. */
function gradeChip(score, grade, big = false) {
  const g = gradeStyle(score);
  return el('span', { class: `chip${big ? ' lg' : ''}` }, [
    el('span', { class: 'dot', style: `background:${g.color}` }),
    document.createTextNode(`${grade} · ${score}`),
  ]);
}

/* --------------------------------------------------------------- tooltip -- */

const tip = $('#tooltip');
function showTip(x, y, title, rows) {
  tip.innerHTML = '';
  tip.appendChild(el('div', { class: 'tt-title', text: title }));
  for (const [k, v] of rows) {
    tip.appendChild(el('div', { class: 'tt-row' }, [
      el('span', { text: k }), el('b', { text: v }),
    ]));
  }
  tip.style.opacity = '1';
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(Math.max(8, x + 14), window.innerWidth - r.width - 8)}px`;
  tip.style.top = `${Math.max(8, y - r.height - 12)}px`;
}
const hideTip = () => { tip.style.opacity = '0'; };

/* ---------------------------------------------------------------- charts -- */

const PAD = { l: 42, r: 14, t: 10, b: 22 };

function niceTicks(min, max, count = 4) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/**
 * One measure, one axis, over time. Optional shaded bands mark the session
 * window so you can see at a glance what the 7:30-10:00 slot actually looks
 * like rather than reading the day's peak.
 */
function timeChart(host, opts) {
  const {
    points, color, softColor, height = 116, unit = '', decimals = 1,
    bands = [], area = true, labelExtremes = false, tooltipRows, zeroBase = true,
  } = opts;
  host.innerHTML = '';
  if (!points.length) { host.appendChild(el('p', { class: 'cap', text: 'No data' })); return; }

  const W = Math.max(280, host.clientWidth || 320);
  const H = height;
  const xs = points.map((p) => p.t);
  const vs = points.map((p) => p.v).filter(Number.isFinite);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = zeroBase ? Math.min(0, Math.min(...vs)) : Math.min(...vs);
  let y1 = Math.max(...vs);
  if (y1 - y0 < 1e-6) y1 = y0 + 1;
  const pad = (y1 - y0) * 0.12;
  y1 += pad; if (!zeroBase) y0 -= pad;

  const X = (t) => PAD.l + ((t - x0) / (x1 - x0 || 1)) * (W - PAD.l - PAD.r);
  const Y = (v) => H - PAD.b - ((v - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);

  const svg = el('svg', { class: 'chart', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });

  for (const b of bands) {
    const bx0 = X(Math.max(b.from, x0)), bx1 = X(Math.min(b.to, x1));
    if (bx1 > bx0) svg.appendChild(el('rect', { class: b.cls || 'band-window', x: bx0, y: PAD.t, width: bx1 - bx0, height: H - PAD.t - PAD.b }));
  }
  for (const tv of niceTicks(y0, y1, 3)) {
    svg.appendChild(el('line', { class: 'grid-line', x1: PAD.l, x2: W - PAD.r, y1: Y(tv), y2: Y(tv) }));
    svg.appendChild(el('text', { class: 'axis-label', x: PAD.l - 6, y: Y(tv) + 3.5, 'text-anchor': 'end', text: `${decimals ? tv.toFixed(decimals) : Math.round(tv)}` }));
  }
  svg.appendChild(el('text', { class: 'axis-label', x: PAD.l - 6, y: PAD.t - 1, 'text-anchor': 'end', text: unit }));

  // Day boundaries and midday labels along the x axis.
  let cursor = new Date(x0);
  cursor.setUTCMinutes(0, 0, 0);
  const seen = new Set();
  for (const p of points) {
    const lbl = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric' }).format(new Date(p.t));
    const key = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'numeric', day: 'numeric' }).format(new Date(p.t));
    const span = x1 - x0;
    const wantTick = span <= 36 * 36e5 ? ['6 AM', '9 AM', '12 PM', '3 PM', '6 PM'].includes(lbl) : lbl === '12 PM';
    if (wantTick && !seen.has(key + lbl)) {
      seen.add(key + lbl);
      svg.appendChild(el('text', {
        class: 'axis-label', x: X(p.t), y: H - 7, 'text-anchor': 'middle',
        text: span <= 36 * 36e5 ? lbl.replace(' AM', 'a').replace(' PM', 'p') : fmtDate(new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(p.t)), { weekday: 'short' }),
      }));
    }
  }
  svg.appendChild(el('line', { class: 'axis-line', x1: PAD.l, x2: W - PAD.r, y1: H - PAD.b, y2: H - PAD.b }));

  const live = points.filter((p) => Number.isFinite(p.v));
  const d = live.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
  if (area) {
    svg.appendChild(el('path', {
      d: `${d} L${X(live[live.length - 1].t).toFixed(1)},${Y(Math.max(y0, 0)).toFixed(1)} L${X(live[0].t).toFixed(1)},${Y(Math.max(y0, 0)).toFixed(1)} Z`,
      fill: softColor, stroke: 'none',
    }));
  }
  svg.appendChild(el('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  // Selective direct labels: the extremes only, never a number on every point.
  if (labelExtremes && live.length > 2) {
    const hi = live.reduce((a, b) => (b.v > a.v ? b : a));
    const lo = live.reduce((a, b) => (b.v < a.v ? b : a));
    for (const [p, anchor] of [[hi, -8], [lo, 13]]) {
      svg.appendChild(el('circle', { cx: X(p.t), cy: Y(p.v), r: 3.2, fill: color, stroke: 'var(--surface-1)', 'stroke-width': 2 }));
      svg.appendChild(el('text', {
        class: 'direct-label', x: Math.min(Math.max(X(p.t), PAD.l + 14), W - PAD.r - 14),
        y: Y(p.v) + anchor, 'text-anchor': 'middle', text: `${p.v.toFixed(decimals)}`,
      }));
    }
  }

  const cross = el('line', { class: 'axis-line', y1: PAD.t, y2: H - PAD.b, opacity: 0 });
  const dot = el('circle', { r: 4, fill: color, stroke: 'var(--surface-1)', 'stroke-width': 2, opacity: 0 });
  svg.appendChild(cross); svg.appendChild(dot);
  svg.style.touchAction = 'pan-y';
  const move = (ev) => {
    const box = svg.getBoundingClientRect();
    const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - box.left;
    const t = x0 + ((cx - PAD.l) / (W - PAD.l - PAD.r)) * (x1 - x0);
    const p = live.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    cross.setAttribute('x1', X(p.t)); cross.setAttribute('x2', X(p.t)); cross.setAttribute('opacity', .5);
    dot.setAttribute('cx', X(p.t)); dot.setAttribute('cy', Y(p.v)); dot.setAttribute('opacity', 1);
    const e = ev.touches ? ev.touches[0] : ev;
    showTip(e.clientX, e.clientY, fmtTime(new Date(p.t).toISOString(), { weekday: 'short' }),
      tooltipRows ? tooltipRows(p) : [[unit || 'value', `${p.v.toFixed(decimals)}`]]);
  };
  const leave = () => { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); hideTip(); };
  svg.addEventListener('mousemove', move);
  svg.addEventListener('touchstart', move, { passive: true });
  svg.addEventListener('touchmove', move, { passive: true });
  svg.addEventListener('mouseleave', leave);
  svg.addEventListener('touchend', leave);
  host.appendChild(svg);
}

/**
 * Swell direction and period in one strip: arrow angle is the direction the
 * swell is travelling, and the blue ramp encodes period. Two facts that
 * normally cost two panels, shown where you can compare them hour by hour.
 */
const PERIOD_RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'];
const periodColor = (T) => PERIOD_RAMP[Math.max(0, Math.min(5, Math.floor(((T - 6) / 14) * 6)))];

function arrowStrip(host, hours, bands = []) {
  host.innerHTML = '';
  const W = Math.max(280, host.clientWidth || 320);
  const H = 62;
  if (!hours.length) return;
  const x0 = Date.parse(hours[0].time), x1 = Date.parse(hours[hours.length - 1].time);
  const X = (t) => PAD.l + ((t - x0) / (x1 - x0 || 1)) * (W - PAD.l - PAD.r);
  const svg = el('svg', { class: 'chart', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });
  for (const b of bands) {
    const bx0 = X(Math.max(b.from, x0)), bx1 = X(Math.min(b.to, x1));
    if (bx1 > bx0) svg.appendChild(el('rect', { class: 'band-window', x: bx0, y: 4, width: bx1 - bx0, height: H - 20 }));
  }
  // Thin out arrows so they never collide on a narrow screen.
  const step = Math.max(1, Math.ceil(hours.length / Math.floor((W - PAD.l - PAD.r) / 26)));
  for (let i = 0; i < hours.length; i += step) {
    const h = hours[i];
    if (!Number.isFinite(h.dirDeg)) continue;
    const cx = X(Date.parse(h.time)), cy = 26;
    // Waves travel TOWARD the shore: rotate 180 from the "coming from" bearing.
    const ang = (h.dirDeg + 180) % 360;
    const g = el('g', { transform: `translate(${cx},${cy}) rotate(${ang})` }, [
      el('path', { d: 'M0,-8 L4.6,7 L0,4.2 L-4.6,7 Z', fill: periodColor(h.periodS), stroke: 'var(--surface-1)', 'stroke-width': 1 }),
    ]);
    g.appendChild(el('title', { text: `${fmtHour(h.time)} - ${h.dirCompass} ${Math.round(h.dirDeg)}°, ${n1(h.periodS)}s` }));
    svg.appendChild(g);
    if (i % (step * 3) === 0) {
      svg.appendChild(el('text', { class: 'axis-label', x: cx, y: 48, 'text-anchor': 'middle', text: h.dirCompass }));
    }
  }
  host.appendChild(svg);
}

/** Horizontal score bars for the outlook - one row per day, value labelled. */
function scoreBars(host, days, todayDate, onClick) {
  host.innerHTML = '';
  const W = Math.max(280, host.clientWidth || 320);
  const rowH = 26, labelW = 66, valW = 34;
  const H = days.length * rowH + 6;
  const svg = el('svg', { class: 'chart', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const barMax = W - labelW - valW - 8;
  days.forEach((d, i) => {
    const y = i * rowH + 4;
    const g = gradeStyle(d.windowScore);
    const w = Math.max(3, (d.windowScore / 100) * barMax);
    svg.appendChild(el('text', {
      class: 'axis-label', x: 0, y: y + 13, text: dayTick(d.date),
      style: d.date === todayDate ? 'font-weight:700;fill:var(--text-primary)' : '',
    }));
    const bar = el('rect', { x: labelW, y: y + 4, width: w, height: 10, rx: 4, fill: g.color, opacity: d.date === todayDate ? 1 : .82 });
    bar.appendChild(el('title', { text: `${fmtDate(d.date)} - ${d.windowGrade} (${d.windowScore}). ${d.verdict}` }));
    svg.appendChild(bar);
    svg.appendChild(el('text', { class: 'direct-label', x: labelW + w + 6, y: y + 13, text: String(d.windowScore) }));
    if (onClick) { bar.style.cursor = 'pointer'; bar.addEventListener('click', () => onClick(d)); }
  });
  host.appendChild(svg);
}

/**
 * Model agreement: for each day, the span of face heights the different wave
 * models produce. A wide bar means the models are arguing and the day is not
 * yet decided - the honest signal most surf apps hide behind a single number.
 */
function spreadChart(host, days) {
  host.innerHTML = '';
  const rows = days.map((d) => {
    const win = d.hours.filter((h) => h.inWindow);
    const pool = win.length ? win : d.hours;
    const all = pool.flatMap((h) => (h.modelSpread?.heightFt || []).map((m) => m.faceFt));
    return { date: d.date, lo: Math.min(...all), hi: Math.max(...all), mid: d.faceMaxFt, n: all.length };
  }).filter((r) => Number.isFinite(r.lo) && Number.isFinite(r.hi));
  if (!rows.length) { host.appendChild(el('p', { class: 'cap', text: 'No spread data' })); return; }

  const W = Math.max(280, host.clientWidth || 320);
  const rowH = 24, labelW = 66;
  const H = rows.length * rowH + 20;
  const lo = 0, hi = Math.max(...rows.map((r) => r.hi)) * 1.1;
  const X = (v) => labelW + (v / (hi - lo || 1)) * (W - labelW - 30);
  const svg = el('svg', { class: 'chart', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });
  for (const tv of niceTicks(lo, hi, 4)) {
    svg.appendChild(el('line', { class: 'grid-line', x1: X(tv), x2: X(tv), y1: 2, y2: H - 16 }));
    svg.appendChild(el('text', { class: 'axis-label', x: X(tv), y: H - 4, 'text-anchor': 'middle', text: n0(sizeVal(tv)) }));
  }
  svg.appendChild(el('text', { class: 'axis-label', x: W - 26, y: H - 4, 'text-anchor': 'end', text: sizeUnit() }));
  rows.forEach((r, i) => {
    const y = i * rowH + 12;
    svg.appendChild(el('text', { class: 'axis-label', x: 0, y: y + 4, text: dayTick(r.date) }));
    const bar = el('rect', { x: X(r.lo), y: y - 4, width: Math.max(2, X(r.hi) - X(r.lo)), height: 9, rx: 4, fill: 'var(--swell)', opacity: .35 });
    bar.appendChild(el('title', { text: `${fmtDate(r.date)}: models range ${n1(sizeVal(r.lo))}-${n1(sizeVal(r.hi))} ${sizeUnit()}` }));
    svg.appendChild(bar);
    svg.appendChild(el('circle', { cx: X(r.mid), cy: y + .5, r: 4, fill: 'var(--swell)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));
  });
  host.appendChild(svg);
}

/* ----------------------------------------------------------------- state -- */

let DATA = null;
let BASEMAP = null;
let selectedDate = null;
const rerenderers = [];

/** Re-render charts at true pixel width when the viewport changes. */
function onResize() {
  clearTimeout(onResize._t);
  onResize._t = setTimeout(() => rerenderers.forEach((fn) => fn()), 150);
}
window.addEventListener('resize', onResize);

function panel(title, caption, draw, extra) {
  const host = el('div', { class: 'panel' });
  host.appendChild(el('h3', { text: title }));
  if (caption) host.appendChild(el('p', { class: 'cap', text: caption }));
  const body = el('div');
  host.appendChild(body);
  if (extra) host.appendChild(extra);
  const run = () => draw(body);
  rerenderers.push(run);
  requestAnimationFrame(run);
  return host;
}

/** The 7:30-10:00 shading used on every hourly chart. */
function windowBands(hours) {
  const bands = [];
  let start = null;
  for (const h of hours) {
    const t = Date.parse(h.time);
    if (h.inWindow && start == null) start = t;
    if (!h.inWindow && start != null) { bands.push({ from: start, to: t }); start = null; }
  }
  if (start != null) bands.push({ from: start, to: Date.parse(hours[hours.length - 1].time) });
  return bands;
}

/* ------------------------------------------------------------ today hero -- */

function renderToday(day, current, wetsuit) {
  const card = el('div', { class: 'card' });
  const left = el('div');
  const right = el('div');

  left.appendChild(el('h2', { text: `Today · ${fmtDate(day.date, { weekday: 'long', month: 'short', day: 'numeric' })}` }));
  left.appendChild(el('p', { class: 'note', text: `Scored for your 7:30–10:00am window. Day's best window score, not the day's peak.` }));

  const sizeLine = el('div', { class: 'figure' }, [
    document.createTextNode(range1(sizeVal(day.faceMinFt), sizeVal(day.faceMaxFt))),
    el('span', { class: 'unit', text: ` ${sizeUnit()}` }),
  ]);
  left.appendChild(sizeLine);
  left.appendChild(el('div', { class: 'figure-label', text: `${day.sizeLabel}, sets to ${n1(sizeVal(day.setMaxFt))} ft (${day.setSizeLabel.toLowerCase()})` }));
  left.appendChild(el('div', { style: 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap' }, [
    gradeChip(day.windowScore, day.windowGrade, true),
    el('span', { class: 'chip', text: day.board.board }),
    el('span', { class: 'chip', text: `${Math.round((day.confidence ?? 0) * 100)}% model agreement` }),
  ]));
  left.appendChild(el('p', { class: 'call', text: day.verdict }));
  left.appendChild(el('p', { class: 'note', style: 'margin-top:6px', text: day.board.note }));

  const stats = el('div', { class: 'statrow' });
  const stat = (cls, k, v, s) => stats.appendChild(el('div', { class: `stat ${cls}` }, [
    el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), el('div', { class: 's', text: s }),
  ]));
  stat('swell', 'Swell', `${day.dirCompass} ${n1(day.periodS)}s`, `${n0(day.dirDeg)}° in the window`);
  stat('swell', 'Energy', `${n0(day.powerKwPerM)} kW/m`, 'wave power per metre of crest');
  stat('wind', 'Wind', `${n0(day.windKt)} kt ${day.windCompass}`, day.windLabel);
  stat('tide', 'Tide', `${n1(day.tideAtWindowFt)} ft`, 'at 7:30–10:00, MLLW');
  right.appendChild(stats);

  if (current) {
    right.appendChild(el('div', { class: 'alert info' }, [
      el('span', { class: 'ic', text: '⛵' }),
      el('div', {
        html: `<b>Buoy right now</b> (CDIP ${current.station}, ${fmtTime(current.observedAt)}): `
          + `${n1(current.deepHsFt)} ft @ ${n1(current.periodS)}s from ${current.dirCompass}. `
          + `That works out to <b>${n1(sizeVal(current.faceFt))} ${sizeUnit()}</b> (${current.sizeLabel.toLowerCase()}) on the sand, `
          + `sets ${n1(sizeVal(current.faceSetFt))}. Tide ${n1(current.tideFt)} ft and ${current.tideRate > 0 ? 'filling' : 'draining'}.`,
      }),
    ]));
  }

  const w = day.water;
  right.appendChild(el('div', { class: `alert ${w.advisory ? 'bad' : 'info'}` }, [
    el('span', { class: 'ic', text: w.advisory ? '⚠' : '✓' }),
    el('div', { html: `<b>Water quality:</b> ${w.reason}` }),
  ]));
  right.appendChild(el('div', { class: 'alert info' }, [
    el('span', { class: 'ic', text: '❄' }),
    el('div', { html: `<b>Wetsuit:</b> ${wetsuit.call}${wetsuit.waterF ? ` · water ${n1(wetsuit.waterF)}°F` : ''}` }),
  ]));

  card.appendChild(el('div', { class: 'hero' }, [left, right]));
  return card;
}


/* ------------------------------------------------------------ surf map -- */

/**
 * The map of this specific piece of coast, with the surf modelled on top.
 *
 * The coastline, the north lot, the road and the access paths are real
 * OpenStreetMap geometry. The waves come from CDIP MOP, which publishes height,
 * period and direction every ~100 m along this beach, refracted over surveyed
 * bathymetry. What is modelled is the seafloor between the shoreline and the
 * MOP depth contour, and the last step from there to breaking.
 */
function renderMap(day) {
  const card = el('div', { class: 'card' });
  card.appendChild(el('h2', { text: 'The map \u00b7 where it will be breaking' }));
  card.appendChild(el('p', { class: 'note', text: 'Looking straight down at the north lot. Drag the slider through the next few days and watch which stretch of beach turns on. Hover anywhere on the water for the numbers there.' }));

  if (!window.TPSurfMap) {
    card.appendChild(el('div', { class: 'alert warn' }, [
      el('span', { class: 'ic', text: '\u26a0' }),
      el('div', { text: 'The map module did not load. Everything else on the page is unaffected.' }),
    ]));
    return card;
  }
  if (!DATA.nearshore) {
    card.appendChild(el('div', { class: 'alert warn' }, [
      el('span', { class: 'ic', text: '\u26a0' }),
      el('div', { text: 'CDIP MOP was unavailable on the last run, so there is no alongshore data to map yet. The rest of the forecast is unaffected; the map fills in on the next successful run.' }),
    ]));
    return card;
  }

  const host = el('div');
  card.appendChild(host);

  // Open on the crew's window if it falls inside the range.
  let start = DATA.nearshore.localHours.findIndex((h, i) =>
    h >= 7.5 && h <= 10 && Date.parse(DATA.nearshore.times[i]) >= Date.now() - 36e5);
  if (start < 0) start = 0;

  let handle = null;
  const run = () => {
    if (handle && handle.destroy) handle.destroy();
    handle = window.TPSurfMap.mount(host, {
      basemap: BASEMAP, nearshore: DATA.nearshore, hourly: DATA.hourly, startIndex: start,
    });
  };
  rerenderers.push(run);
  requestAnimationFrame(run);

  card.appendChild(el('div', { class: 'map-scale' }, [
    el('span', { text: 'Face height' }),
    el('span', { class: 'ramp' }, ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b']
      .map((c) => el('span', { style: `background:${c}` }))),
    el('span', { text: '0 \u2192 8 ft' }),
    el('span', { style: 'margin-left:8px', text: '\u2022 Peaky / walled ribbon: green peaky, amber mixed, red walled' }),
  ]));

  card.appendChild(el('div', { class: 'alert info' }, [
    el('span', { class: 'ic', text: 'i' }),
    el('div', {
      html: '<b>Real:</b> the map geometry (OpenStreetMap), and the wave height, period and '
        + 'direction every ~100 m along this beach from CDIP MOP \u2014 Scripps\u2019 own model, '
        + 'run over surveyed bathymetry. <b>Modelled:</b> the seafloor between the shoreline and '
        + 'the MOP depth contour, including the sandbar and rip channels, and the final step from '
        + 'the MOP line to breaking. The endpoints are measured; the shape between them is not.',
    }),
  ]));
  return card;
}

/* -------------------------------------------------------- hourly detail -- */

function renderHourly(day) {
  const card = el('div', { class: 'card' });
  card.appendChild(el('h2', { text: `Hour by hour · ${fmtDate(day.date, { weekday: 'long', month: 'short', day: 'numeric' })}` }));
  card.appendChild(el('p', { class: 'note', text: 'The shaded band is your 7:30–10:00am window. Each panel carries one measure on its own axis — hover or drag for exact values.' }));

  const picker = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px' });
  for (const d of DATA.days.slice(0, 7)) {
    const b = el('button', {
      text: fmtDate(d.date, { weekday: 'short' }),
      class: d.date === selectedDate ? 'primary' : '',
      onclick: () => { selectedDate = d.date; render(); },
    });
    picker.appendChild(b);
  }
  card.appendChild(picker);

  const hrs = day.hours.filter((h) => h.localHour >= 5 && h.localHour <= 20);
  const bands = windowBands(hrs);
  const pt = (f) => hrs.map((h) => ({ t: Date.parse(h.time), v: f(h), h }));

  card.appendChild(panel('Surf size', `Face height at the north lot, ${sizeUnit()}`, (host) => timeChart(host, {
    points: pt((h) => sizeVal(h.faceFt)), color: 'var(--swell)', softColor: 'var(--swell-soft)',
    unit: sizeUnit(), decimals: 1, bands, labelExtremes: true,
    tooltipRows: (p) => [
      ['Face', `${n1(sizeVal(p.h.faceFt))} ${sizeUnit()}`],
      ['Sets', `${n1(sizeVal(p.h.faceSetFt))}`],
      ['Size', p.h.sizeLabel],
      ['Score', `${p.h.score} (${p.h.grade})`],
    ],
  })));

  card.appendChild(panel('Total wave energy', 'Wave power per metre of crest, kW/m — what separates a punchy long-period swell from a gutless one of the same height', (host) => timeChart(host, {
    points: pt((h) => h.powerKwPerM), color: 'var(--swell)', softColor: 'var(--swell-soft)',
    unit: 'kW/m', decimals: 0, bands, labelExtremes: true,
    tooltipRows: (p) => [['Power', `${n0(p.h.powerKwPerM)} kW/m`], ['Deep Hs', `${n1(p.h.deepHsFt)} ft`], ['Period', `${n1(p.h.periodS)} s`]],
  })));

  card.appendChild(panel('Swell direction and period', 'Arrows point the way the swell is travelling; colour is period', (host) => arrowStrip(host, hrs, bands),
    el('div', { class: 'legend' }, [
      el('span', { class: 'item' }, [
        el('span', { text: 'Period' }),
        el('span', { class: 'ramp' }, PERIOD_RAMP.map((c) => el('span', { style: `background:${c}` }))),
        el('span', { text: '6s → 20s' }),
      ]),
    ])));

  card.appendChild(panel('Wind', 'Knots at the beach. Offshore here is from the ENE', (host) => timeChart(host, {
    points: pt((h) => h.windKt), color: 'var(--wind)', softColor: 'var(--wind-soft)',
    unit: 'kt', decimals: 0, bands, labelExtremes: true,
    tooltipRows: (p) => [['Wind', `${n0(p.h.windKt)} kt ${p.h.windCompass}`], ['Gusts', `${n0(p.h.gustKt)} kt`], ['Effect', p.h.windLabel]],
  })));

  card.appendChild(panel('Tide', 'Feet above MLLW at Scripps Pier — highs and lows labelled', (host) => timeChart(host, {
    points: pt((h) => h.tideFt), color: 'var(--tide)', softColor: 'var(--tide-soft)',
    unit: 'ft', decimals: 1, bands, labelExtremes: true, zeroBase: false,
    tooltipRows: (p) => [['Tide', `${n1(p.h.tideFt)} ft`], [p.h.tideRate > 0 ? 'Filling' : 'Draining', `${n1(Math.abs(p.h.tideRate))} ft/hr`], ['Tide score', `${Math.round((p.h.parts?.tide ?? 0) * 100)}%`]],
  })));

  // Contrast relief for the aqua tide series, and the accessible fallback for
  // every panel above: the same numbers as text.
  const table = el('table');
  table.appendChild(el('tr', {}, ['Time', `Face (${sizeUnit()})`, 'Sets', 'Energy kW/m', 'Period', 'Dir', 'Wind kt', 'Tide ft', 'Score']
    .map((h) => el('th', { text: h }))));
  for (const h of hrs) {
    table.appendChild(el('tr', {}, [
      el('td', { text: fmtHour(h.time) }),
      el('td', { text: n1(sizeVal(h.faceFt)) }),
      el('td', { text: n1(sizeVal(h.faceSetFt)) }),
      el('td', { text: n0(h.powerKwPerM) }),
      el('td', { text: `${n1(h.periodS)}s` }),
      el('td', { text: `${h.dirCompass} ${n0(h.dirDeg)}°` }),
      el('td', { text: `${n0(h.windKt)} ${h.windCompass}` }),
      el('td', { text: n1(h.tideFt) }),
      el('td', { text: `${h.score}` }),
    ]));
  }
  card.appendChild(el('details', { class: 'tableview' }, [
    el('summary', { text: 'Show the same data as a table' }),
    el('div', { class: 'table-wrap' }, [table]),
  ]));
  return card;
}

/* ---------------------------------------------------------------- buoy --- */

function renderBuoy(current) {
  const card = el('div', { class: 'card' });
  card.appendChild(el('h2', { text: 'Buoy · CDIP 100p1, Torrey Pines Outer' }));
  card.appendChild(el('p', { class: 'note', text: 'Measured, not modelled — this buoy sits about 8 miles straight out from the lineup and is what the whole forecast is anchored to.' }));
  if (!current) {
    card.appendChild(el('div', { class: 'alert warn' }, [el('span', { class: 'ic', text: '⚠' }), el('div', { text: 'Buoy data was unavailable on the last run, so the forecast is running uncorrected model output.' })]));
    return card;
  }

  if (current.trains?.length) {
    const t = el('table');
    t.appendChild(el('tr', {}, ['Swell train', 'Height', 'Period', 'From', `At the beach (${sizeUnit()})`, 'Energy'].map((h) => el('th', { text: h }))));
    current.trains.forEach((s, i) => {
      t.appendChild(el('tr', {}, [
        el('td', { text: `${i + 1}. ${s.kind}${s.energyFraction ? ` (${Math.round(s.energyFraction * 100)}% of energy)` : ''}` }),
        el('td', { text: `${n1(s.hsFt)} ft` }),
        el('td', { text: `${n1(s.periodS)} s` }),
        el('td', { text: `${s.dirCompass} ${n0(s.dirDeg)}°` }),
        el('td', { text: `${n1(sizeVal(s.faceFt))} (${s.sizeLabel.toLowerCase()})` }),
        el('td', { text: `${n0(s.powerKwPerM)} kW/m` }),
      ]));
    });
    card.appendChild(el('div', { class: 'table-wrap' }, [t]));
    card.appendChild(el('p', { class: 'note', style: 'margin-top:8px', text: 'Separating the sea into its actual swell trains is what tells you a new long-period pulse is filling in before it shows up in the overall height.' }));
  }

  const hist = current.history || [];
  if (hist.length > 2) {
    card.appendChild(panel('Last 48 hours, measured', 'Significant wave height at the buoy, feet', (host) => timeChart(host, {
      points: hist.map((r) => ({ t: Date.parse(r.time), v: r.hsFt, h: r })),
      color: 'var(--swell)', softColor: 'var(--swell-soft)', unit: 'ft Hs', decimals: 1, labelExtremes: true,
      tooltipRows: (p) => [['Hs', `${n1(p.h.hsFt)} ft`], ['Period', `${n1(p.h.periodS)} s`], ['Energy', `${n0(p.h.powerKwPerM)} kW/m`]],
    })));
  }
  if (DATA.nowcast) {
    const nc = DATA.nowcast;
    const off = Math.abs(nc.errorFt);
    card.appendChild(el('div', { class: `alert ${off <= 0.6 ? 'info' : 'warn'}` }, [
      el('span', { class: 'ic', text: off <= 0.6 ? '✓' : '⚠' }),
      el('div', { html: `<b>Nowcast check:</b> the model said ${n1(nc.forecastHsFt)} ft, the buoy measured ${n1(nc.buoyHsFt)} ft — off by ${n1(nc.errorFt)} ft right now. ${off <= 0.6 ? 'Running true.' : 'Treat today’s sizes with that much slack.'}` }),
    ]));
  }
  return card;
}

/* ------------------------------------------------------------ day cards -- */

function dayCard(d, isToday) {
  const c = el('div', { class: `daycard${isToday ? ' today' : ''}` });
  c.appendChild(el('div', { class: 'top' }, [
    el('div', {}, [
      el('span', { class: 'date', text: fmtDate(d.date, { weekday: 'short' }) }),
      el('span', { class: 'dow', text: ` ${fmtDate(d.date, { month: 'short', day: 'numeric' })}` }),
    ]),
    gradeChip(d.windowScore, d.windowGrade),
  ]));
  c.appendChild(el('div', { class: 'size', text: `${range1(sizeVal(d.faceMinFt), sizeVal(d.faceMaxFt))} ${sizeUnit()}` }));
  c.appendChild(el('div', { class: 'sizelabel', text: `${d.sizeLabel} · sets ${n1(sizeVal(d.setMaxFt))}` }));
  c.appendChild(el('div', { class: 'meta' }, [
    el('span', { html: `Swell <b>${d.dirCompass} ${n1(d.periodS)}s</b>` }),
    el('span', { html: `Energy <b>${n0(d.powerKwPerM)}</b> kW/m` }),
    el('span', { html: `Wind <b>${n0(d.windKt)} kt</b> ${d.windCompass}` }),
    el('span', { html: `Tide <b>${n1(d.tideAtWindowFt)} ft</b>` }),
    el('span', { html: `Board <b>${d.board.board}</b>` }),
  ]));
  c.appendChild(el('p', { class: 'verdict', text: d.verdict }));
  if (d.water?.advisory) {
    c.appendChild(el('div', { class: 'alert bad', style: 'margin-top:8px' }, [
      el('span', { class: 'ic', text: '⚠' }), el('div', { text: 'Post-rain water quality advisory' }),
    ]));
  }
  c.style.cursor = 'pointer';
  c.addEventListener('click', () => { selectedDate = d.date; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  return c;
}

/* ---------------------------------------------------------- what changed -- */

function renderDrift() {
  const card = el('div', { class: 'card' });
  card.appendChild(el('h2', { text: 'What changed since the last runs' }));
  card.appendChild(el('p', { class: 'note', text: 'Every run is archived, so each day can be compared against what we were saying 24, 48 and 120 hours ago. A day that keeps moving is not a forecast yet — a day that has held steady is worth planning around.' }));
  const moved = (DATA.drift || []).filter((d) => !d.stable);
  const rows = (DATA.drift || []).slice(0, 7);
  if (!rows.length || rows.every((r) => r.headline === 'No prior run to compare')) {
    card.appendChild(el('div', { class: 'alert info' }, [
      el('span', { class: 'ic', text: 'i' }),
      el('div', { text: 'No archived runs to compare against yet. This panel fills in once the scheduled build has run a few times.' }),
    ]));
    return card;
  }
  card.appendChild(el('p', { style: 'margin:0 0 10px;font-size:14px' , text:
    moved.length ? `${moved.length} of the next 7 days moved meaningfully.` : 'All seven days are holding steady across runs.' }));
  const t = el('table');
  t.appendChild(el('tr', {}, ['Day', 'Now', 'vs 24 h ago', 'vs 48 h ago', 'What changed'].map((h) => el('th', { text: h }))));
  for (const r of rows) {
    const day = DATA.days.find((d) => d.date === r.date);
    const at = (age) => {
      const c = r.changes.find((x) => x.ageHours === age);
      if (!c) return '—';
      return `${c.scoreDelta > 0 ? '+' : ''}${c.scoreDelta}`;
    };
    t.appendChild(el('tr', {}, [
      el('td', { text: dayTick(r.date) }),
      el('td', { text: String(day?.windowScore ?? '—') }),
      el('td', { text: at(24) }),
      el('td', { text: at(48) }),
      el('td', { text: r.headline, style: 'text-align:left;font-size:12.5px;color:var(--text-secondary)' }),
    ]));
  }
  card.appendChild(el('div', { class: 'table-wrap' }, [t]));
  return card;
}

/* ----------------------------------------------------------- skill panel -- */

function renderSkill() {
  const card = el('div', { class: 'card' });
  card.appendChild(el('h2', { text: 'Is this forecast actually any good?' }));
  card.appendChild(el('p', { class: 'note', text: 'Every archived run is graded against what CDIP 100p1 later measured. No forecast deserves trust without a scoreboard, so here is ours, by lead time.' }));
  const s = DATA.skill;
  if (!s?.buckets?.length) {
    card.appendChild(el('div', { class: 'alert info' }, [el('span', { class: 'ic', text: 'i' }), el('div', { text: s?.note || 'Not enough history yet.' })]));
    return card;
  }
  if (s.overall) {
    card.appendChild(el('div', { style: 'display:flex;gap:26px;flex-wrap:wrap;margin-bottom:12px' }, [
      el('div', {}, [el('div', { class: 'figure', text: `${n1(s.overall.hsMaeFt)}` , style:'font-size:32px'}), el('div', { class: 'figure-label', text: 'ft average error, all lead times' })]),
      el('div', {}, [el('div', { class: 'figure', text: `${s.overall.hsBiasFt > 0 ? '+' : ''}${n1(s.overall.hsBiasFt)}`, style: 'font-size:32px' }), el('div', { class: 'figure-label', text: `ft bias (${s.overall.hsBiasFt > 0 ? 'over' : 'under'}-forecasting)` })]),
      el('div', {}, [el('div', { class: 'figure', text: String(s.overall.n), style: 'font-size:32px' }), el('div', { class: 'figure-label', text: 'verified forecast hours' })]),
    ]));
  }
  const t = el('table');
  t.appendChild(el('tr', {}, ['Lead time', 'Hours checked', 'Height error (ft)', 'Bias (m)', 'Period error (s)', 'Direction error'].map((h) => el('th', { text: h }))));
  for (const b of s.buckets) {
    t.appendChild(el('tr', {}, [
      el('td', { text: b.label }), el('td', { text: String(b.n) }),
      el('td', { text: n1(b.hsMaeFt) }), el('td', { text: n1(b.hsBiasM) }),
      el('td', { text: b.tpMaeS == null ? '—' : n1(b.tpMaeS) }),
      el('td', { text: b.dirMaeDeg == null ? '—' : `${n0(b.dirMaeDeg)}°` }),
    ]));
  }
  card.appendChild(el('div', { class: 'table-wrap' }, [t]));
  card.appendChild(el('p', { class: 'note', style: 'margin-top:10px', text: s.note }));
  return card;
}

/* ----------------------------------------------------------- session log -- */

const LOG_KEY = 'tp-surfcast2-log';
const loadLog = () => { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; } };
const saveLog = (l) => { try { localStorage.setItem(LOG_KEY, JSON.stringify(l)); } catch { /* private mode */ } };

function renderLog() {
  const card = el('div', { class: 'card' });
  card.appendChild(el('h2', { text: 'Session log — what it was actually like' }));
  card.appendChild(el('p', { class: 'note', text: 'This is the part that makes the forecast beat the big services: they never find out how wrong they were at this exact beach. Log a session and the entry carries what we predicted alongside what you saw, so the local calibration can be retuned from real sessions.' }));

  const today = DATA.days[0]?.date || new Date().toISOString().slice(0, 10);
  const form = el('div');
  const dateIn = el('input', { type: 'date', value: today });
  const sizeIn = el('select', {}, ['Ankle', 'Knee', 'Thigh', 'Waist', 'Chest', 'Shoulder', 'Head high', 'Overhead', 'Well overhead', 'Double overhead']
    .map((s) => el('option', { text: s, value: s })));
  sizeIn.value = 'Chest';
  const rateIn = el('select', {}, [['5', '5 — one of the best'], ['4', '4 — really good'], ['3', '3 — fun, worth it'], ['2', '2 — marginal'], ['1', '1 — should have stayed home']]
    .map(([v, t]) => el('option', { text: t, value: v })));
  rateIn.value = '3';
  const crowdIn = el('select', {}, [['light', 'Light'], ['moderate', 'Moderate'], ['packed', 'Packed']].map(([v, t]) => el('option', { text: t, value: v })));
  const notesIn = el('textarea', { placeholder: 'How it broke, which bank worked, what the wind did, what board you were on…' });

  form.appendChild(el('div', { class: 'row2' }, [
    el('div', {}, [el('label', { class: 'field', text: 'Date' }), dateIn]),
    el('div', {}, [el('label', { class: 'field', text: 'Rating' }), rateIn]),
  ]));
  form.appendChild(el('div', { class: 'row2' }, [
    el('div', {}, [el('label', { class: 'field', text: 'Size it actually was' }), sizeIn]),
    el('div', {}, [el('label', { class: 'field', text: 'Crowd' }), crowdIn]),
  ]));
  form.appendChild(el('label', { class: 'field', text: 'Notes' }));
  form.appendChild(notesIn);

  const listHost = el('div', { style: 'margin-top:14px' });
  const renderList = () => {
    listHost.innerHTML = '';
    const log = loadLog().sort((a, b) => b.date.localeCompare(a.date));
    if (!log.length) { listHost.appendChild(el('p', { class: 'note', text: 'No sessions logged yet.' })); return; }
    const t = el('table');
    t.appendChild(el('tr', {}, ['Date', 'Rated', 'You saw', 'We said', 'Notes', ''].map((h) => el('th', { text: h }))));
    for (const s of log.slice(0, 20)) {
      const del = el('button', { text: '✕', title: 'Delete this entry' });
      del.addEventListener('click', () => { saveLog(loadLog().filter((x) => x.id !== s.id)); renderList(); });
      t.appendChild(el('tr', {}, [
        el('td', { text: fmtDate(s.date, { month: 'short', day: 'numeric' }) }),
        el('td', { text: `${s.rating}/5` }),
        el('td', { text: s.observedSize }),
        el('td', { text: s.forecast ? `${s.forecast.sizeLabel} (${s.forecast.windowScore})` : '—' }),
        el('td', { text: s.notes || '', style: 'text-align:left;font-size:12.5px;color:var(--text-secondary)' }),
        el('td', {}, [del]),
      ]));
    }
    listHost.appendChild(el('div', { class: 'table-wrap' }, [t]));
  };

  const toast = el('span', { class: 'note', style: 'margin-left:10px' });
  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.textContent = `${label} copied.`;
    } catch {
      // Clipboard can be blocked; fall back to a selectable box.
      const ta = el('textarea', { style: 'margin-top:8px' });
      ta.value = text; listHost.prepend(ta); ta.select();
      toast.textContent = 'Clipboard blocked — copy from the box above.';
    }
    setTimeout(() => { toast.textContent = ''; }, 4000);
  };

  const save = el('button', { class: 'primary', text: 'Log this session' });
  save.addEventListener('click', () => {
    const d = DATA.days.find((x) => x.date === dateIn.value);
    const entry = {
      id: `${Date.now()}`,
      date: dateIn.value,
      rating: Number(rateIn.value),
      observedSize: sizeIn.value,
      crowd: crowdIn.value,
      notes: notesIn.value.trim(),
      forecast: d ? {
        windowScore: d.windowScore, sizeLabel: d.sizeLabel,
        faceMinFt: d.faceMinFt, faceMaxFt: d.faceMaxFt, periodS: d.periodS,
        dirDeg: d.dirDeg, windKt: d.windKt, tideFt: d.tideAtWindowFt,
      } : null,
      generatedAt: DATA.meta.generatedAt,
    };
    saveLog([...loadLog(), entry]);
    notesIn.value = '';
    renderList();
    toast.textContent = 'Logged.';
    setTimeout(() => { toast.textContent = ''; }, 3000);
  });

  const chat = el('button', { text: 'Copy today’s call for the group chat' });
  chat.addEventListener('click', () => {
    const d = DATA.days.find((x) => x.date === selectedDate) || DATA.days[0];
    const lines = [
      `Torrey Pines (north lot) — ${fmtDate(d.date, { weekday: 'long', month: 'short', day: 'numeric' })}`,
      `${d.windowGrade} (${d.windowScore}/100) for 7:30–10`,
      `${range1(sizeVal(d.faceMinFt), sizeVal(d.faceMaxFt))} ${sizeUnit()}, ${d.sizeLabel.toLowerCase()}, sets ${n1(sizeVal(d.setMaxFt))}`,
      `Swell ${d.dirCompass} ${n1(d.periodS)}s · ${n0(d.powerKwPerM)} kW/m`,
      `Wind ${n0(d.windKt)} kt ${d.windCompass} (${d.windLabel}) · tide ${n1(d.tideAtWindowFt)} ft`,
      `Board: ${d.board.board}`,
      d.water?.advisory ? `⚠ ${d.water.reason}` : '',
      d.verdict,
    ].filter(Boolean);
    copy(lines.join('\n'), 'Call');
  });

  const exp = el('button', { text: 'Export log for calibration' });
  exp.addEventListener('click', () => copy(JSON.stringify({ site: 'torrey-pines-north-lot', exported: new Date().toISOString(), sessions: loadLog() }, null, 2), 'Log JSON'));

  card.appendChild(form);
  card.appendChild(el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px' }, [save, chat, exp, toast]));
  card.appendChild(listHost);
  card.appendChild(el('p', { class: 'note', style: 'margin-top:12px', text: 'Entries are stored in this browser only — they are never uploaded. Use "Export log for calibration" to hand them back for retuning.' }));
  renderList();
  return card;
}

/* --------------------------------------------------------------- render -- */

function render() {
  rerenderers.length = 0;
  const app = $('#app');
  app.innerHTML = '';
  const days = DATA.days;
  if (!days?.length) { app.appendChild(el('div', { class: 'alert bad' }, [el('div', { text: 'The last run produced no forecast days.' })])); return; }
  if (!selectedDate || !days.some((d) => d.date === selectedDate)) selectedDate = days[0].date;
  const selected = days.find((d) => d.date === selectedDate);

  if (DATA.meta.synthetic) {
    app.appendChild(el('div', { class: 'alert warn' }, [
      el('span', { class: 'ic', text: '⚠' }),
      el('div', { html: '<b>Synthetic data.</b> This page was built without live feeds — the numbers are physically plausible placeholders for layout review, not a real forecast.' }),
    ]));
  }
  const errs = Object.keys(DATA.meta.errors || {});
  if (errs.length) {
    app.appendChild(el('div', { class: 'alert warn' }, [
      el('span', { class: 'ic', text: '⚠' }),
      el('div', { html: `<b>Some sources failed on the last run:</b> ${errs.join(', ')}. The forecast is still built from what did come back.` }),
    ]));
  }

  app.appendChild(renderToday(days[0], DATA.current, DATA.wetsuit));
  app.appendChild(renderMap(selected));
  app.appendChild(renderHourly(selected));

  const week = el('div', { class: 'card' });
  week.appendChild(el('h2', { text: '7-day forecast' }));
  week.appendChild(el('p', { class: 'note', text: 'Each day scored for the 7:30–10:00am window. Tap a day to see it hour by hour.' }));
  const daysHost = el('div', { class: 'days' });
  days.slice(0, 7).forEach((d, i) => daysHost.appendChild(dayCard(d, i === 0)));
  week.appendChild(daysHost);
  app.appendChild(week);

  const outlook = el('div', { class: 'card' });
  outlook.appendChild(el('h2', { text: '14-day outlook' }));
  outlook.appendChild(el('p', { class: 'note', text: 'Beyond about a week a wave model is spotting patterns, not days. Use this to see swell arriving, not to plan a session.' }));
  outlook.appendChild(panel('Window score by day', 'Score for 7:30–10:00am, 0–100', (host) => scoreBars(host, days, days[0].date, (d) => { selectedDate = d.date; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); })));
  outlook.appendChild(panel('Model agreement', `Range of face heights across ${DATA.meta.sources.waveModels.length} wave models, ${sizeUnit()}. A wide bar means the models disagree and the day is not settled.`, (host) => spreadChart(host, days)));
  app.appendChild(outlook);

  app.appendChild(renderDrift());
  app.appendChild(renderBuoy(DATA.current));
  app.appendChild(renderSkill());
  app.appendChild(renderLog());

  $('#sources').innerHTML = [
    `Buoy: ${DATA.meta.sources.buoy}`,
    `Tides: ${DATA.meta.sources.tides}`,
    `Wave models: ${DATA.meta.sources.waveModels.join(', ')}`,
    `Wind models: ${DATA.meta.sources.windModels.join(', ')}`,
    `Surfline: ${DATA.meta.sources.surfline}`,
  ].map((s) => `<span>${s}</span>`).join('');
  $('#genline').textContent = `Built ${fmtTime(DATA.meta.generatedAt, { weekday: 'short', month: 'short', day: 'numeric' })} Pacific. Rebuilds on a schedule; reload for the latest.`;
  $('#subtitle').textContent = `Surf-only forecast for the 7:30–10:00am window · updated ${fmtTime(DATA.meta.generatedAt, { month: 'short', day: 'numeric' })}`;
}

/* ----------------------------------------------------------------- boot -- */

$('#themeToggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark' : (matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('tp-theme', next); } catch { /* ignore */ }
  rerenderers.forEach((fn) => fn());
});
try {
  const saved = localStorage.getItem('tp-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
} catch { /* ignore */ }

const unitBtn = $('#unitToggle');
const syncUnitBtn = () => { unitBtn.textContent = unitMode === 'face' ? 'Face ft' : 'Hawaiian'; };
unitBtn.addEventListener('click', () => {
  unitMode = unitMode === 'face' ? 'hawaiian' : 'face';
  try { localStorage.setItem('tp-units', unitMode); } catch { /* ignore */ }
  syncUnitBtn();
  render();
});
syncUnitBtn();

Promise.all([
  fetch(`data/forecast.json?t=${Date.now()}`).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }),
  // The map geometry changes about never, so a failure here must not stop the
  // forecast from rendering.
  fetch('data/basemap.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
])
  .then(([forecast, basemap]) => { BASEMAP = basemap; return forecast; })
  .then((j) => {
    DATA = j;
    // Days ship without their hours (it would double the payload); regroup the
    // single hourly array back onto each day here.
    const byDate = new Map();
    for (const h of DATA.hourly || []) {
      if (!byDate.has(h.localDate)) byDate.set(h.localDate, []);
      byDate.get(h.localDate).push(h);
    }
    for (const d of DATA.days || []) d.hours = byDate.get(d.date) || [];
    render();
  })
  .catch((err) => {
    $('#app').innerHTML = '';
    $('#app').appendChild(el('div', { class: 'alert bad' }, [
      el('span', { class: 'ic', text: '⚠' }),
      el('div', { html: `<b>Could not load the forecast.</b> ${err.message}. If this is a fresh deploy, the scheduled build may not have run yet — trigger the <code>forecast</code> workflow in Actions.` }),
    ]));
  });
