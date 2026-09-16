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

/* ============================================================== the call ==
 *
 * The page answers one question before it answers any other: is it worth
 * getting up tomorrow? Everything below this card is supporting evidence.
 *
 * A webcam beats any model for what the ocean is doing RIGHT NOW, and pretending
 * otherwise is how forecasts lose people's trust. So the card says which it is:
 * for the session that is already within sight, it points at the cams; for the
 * days past the cam's horizon, the model is the only thing there is.
 */

const CAMS = [
  { name: 'Surfline · Torrey Pines', url: 'https://www.surfline.com/surf-report/torrey-pines-state-beach/584204204e65fad6a7709994', note: 'the north lot cam' },
  { name: 'Scripps Pier', url: 'https://scripps.ucsd.edu/piercam', note: 'free, 4 miles south' },
  { name: 'Surf-forecast · N Torrey Pines', url: 'https://www.surf-forecast.com/breaks/North-Torrey-Pines/webcams/latest', note: 'stills, no login' },
];

function camRow(reason) {
  const row = el('div', { class: 'cams' });
  row.appendChild(el('span', { class: 'cams-label', text: reason }));
  for (const c of CAMS) {
    row.appendChild(el('a', {
      class: 'cam', href: c.url, target: '_blank', rel: 'noopener noreferrer',
      title: c.note,
    }, [
      el('span', { class: 'cam-name', text: c.name }),
      el('span', { class: 'cam-note', text: c.note }),
    ]));
  }
  return row;
}

/**
 * Which session the page should lead with. Before about 10am the call is for
 * this morning; after that this morning is over and the only useful answer is
 * tomorrow. A forecast that is still headlining a session you have missed is
 * just decoration.
 */
function leadSession(days) {
  const nowHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: 'numeric', hour12: false,
  }).format(new Date()));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const i = days.findIndex((d) => d.date === today);
  if (i < 0) return { day: days[0], index: 0, when: 'Next session' };
  if (nowHour < 10) return { day: days[i], index: i, when: 'This morning' };
  const next = days[i + 1];
  return next
    ? { day: next, index: i + 1, when: 'Tomorrow morning' }
    : { day: days[i], index: i, when: 'Today' };
}

const TONE_VAR = {
  good: 'var(--good)', warning: 'var(--warning)',
  serious: 'var(--serious)', critical: 'var(--critical)',
};

function renderCall(days, current, wetsuit) {
  const { day, when } = leadSession(days);
  const card = el('div', { class: 'card call-card' });

  card.appendChild(el('div', { class: 'call-when' }, [
    el('span', { class: 'when', text: when }),
    el('span', { class: 'when-date', text: fmtDate(day.date, { weekday: 'long', month: 'short', day: 'numeric' }) }),
    el('span', { class: 'when-win', text: DATA.meta.sessionWindow.label }),
  ]));

  const tone = TONE_VAR[day.tone] || 'var(--muted)';
  const verdict = el('div', { class: 'call-verdict' }, [
    el('div', { class: 'call-word', style: `--tone:${tone}` }, [
      el('span', { class: 'call-dot', style: `background:${tone}` }),
      el('span', { text: day.call || '—' }),
    ]),
    el('div', { class: 'call-gloss', text: day.gloss || '' }),
  ]);

  // Sets get equal billing with the ordinary wave. They are the waves people
  // actually decide on - and on 2026-09-16 this page called a head-high-sets
  // morning "waist high" by quoting one number and burying the other.
  const size = el('div', { class: 'call-size' }, [
    el('div', { class: 'size-pair' }, [
      el('div', { class: 'size-one' }, [
        el('div', { class: 'size-k', text: 'Most waves' }),
        el('div', { class: 'figure sm' }, [
          document.createTextNode(range1(sizeVal(day.faceMinFt), sizeVal(day.faceMaxFt))),
          el('span', { class: 'unit', text: ` ${sizeUnit()}` }),
        ]),
        el('div', { class: 'figure-label', text: day.sizeLabel }),
      ]),
      el('div', { class: 'size-one' }, [
        el('div', { class: 'size-k', text: 'Sets' }),
        el('div', { class: 'figure' }, [
          document.createTextNode(n1(sizeVal(day.setMaxFt))),
          el('span', { class: 'unit', text: ` ${sizeUnit()}` }),
        ]),
        el('div', { class: 'figure-label', text: day.setSizeLabel || '' }),
      ]),
    ]),
  ]);

  card.appendChild(el('div', { class: 'call-top' }, [verdict, size]));

  // The three numbers that decide it, in the order they decide it.
  const facts = el('div', { class: 'call-facts' });
  const fact = (cls, k, v, s) => facts.appendChild(el('div', { class: `fact ${cls}` }, [
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v', text: v }),
    el('div', { class: 's', text: s }),
  ]));
  fact('wind', 'Wind', `${n0(day.windKt)} kt ${day.windCompass}`, day.windLabel);
  fact('tide', 'Tide', `${n1(day.tideAtWindowFt)} ft`, tideWord(day));
  // Quote the DOMINANT swell, not the median of everything in the water: the
  // sentence below the fold names that swell, and the two disagreeing by half a
  // second on the same card reads as a bug.
  const lead = day.mix?.parts?.[0];
  fact('swell', 'Swell',
    lead ? `${n1(lead.periodS)}s ${lead.dirCompass}` : `${n1(day.periodS)}s ${day.dirCompass}`,
    `${n0(day.powerKwPerM)} kW/m of push`);
  card.appendChild(facts);

  const peel = peelForDay(day);
  if (peel) {
    card.appendChild(el('div', { class: `call-peel ${peel.makeable ? 'ok' : 'bad'}` }, [
      el('span', { class: 'ic', text: peel.makeable ? '✓' : '⚠' }),
      el('div', {
        html: peel.makeable
          ? `<b>Should be rideable.</b> The break runs along the wave at about ${Math.round(peel.speedMs)} m/s — slow enough to stay with it.`
          : `<b>Expect walls and closeouts.</b> The break runs along the wave at about ${peel.speedMs ? Math.round(peel.speedMs) : 'over 100'} m/s, faster than anyone paddles into. Corners will be short and hard to get into.`,
      }),
    ]));
  }

  if (day.mix) {
    card.appendChild(el('div', { class: 'call-look' }, [
      el('div', { class: 'look-head', text: 'What it should look like' }),
      el('p', { class: 'look-body', text: day.mix.look }),
      el('p', { class: 'look-sub', text: day.mix.read }),
      day.mix.tideNote ? el('p', { class: 'look-sub', text: day.mix.tideNote }) : null,
    ]));
  }

  const kit = el('div', { class: 'call-kit' }, [
    el('span', { class: 'chip', text: `Board: ${day.board.board}` }),
    el('span', { class: 'chip', text: `${wetsuit.call}${wetsuit.waterF ? ` · ${n0(wetsuit.waterF)}°F` : ''}` }),
    el('span', {
      class: `chip ${day.reliability === 'solid' ? '' : 'chip-soft'}`,
      title: (RELIABILITY_TEXT[day.reliability] || {}).note || '',
      text: (RELIABILITY_TEXT[day.reliability] || {}).chip || '',
    }),
    day.water?.advisory ? el('span', { class: 'chip chip-bad', text: '⚠ Rain advisory — stay out' }) : null,
  ]);
  card.appendChild(kit);

  if (current) {
    card.appendChild(el('div', { class: 'alert info' }, [
      el('span', { class: 'ic', text: '⛵' }),
      el('div', {
        html: `<b>Buoy right now</b> (CDIP ${current.station}, ${fmtTime(current.observedAt)}): `
          + `${n1(current.deepHsFt)} ft @ ${n1(current.periodS)}s from ${current.dirCompass}, `
          + `which is <b>${n1(sizeVal(current.faceFt))} ${sizeUnit()}</b> (${(current.sizeLabel || '').toLowerCase()}) on the sand right now.`,
      }),
    ]));
  }

  card.appendChild(camRow(when === 'This morning'
    ? 'This one is close enough to just look at — the cam beats any model for today:'
    : 'For today, skip the model and look:'));

  return card;
}

/**
 * The peel call for a day, taken from the hours inside the session window.
 * A morning is a closeout if most of the window is: one rideable hour at the
 * end of it does not make the dawn patrol worth it.
 */
function peelForDay(day) {
  const hrs = (day.hours || []).filter((h) => h.inWindow && h.peel);
  if (!hrs.length) return null;
  const makeable = hrs.filter((h) => h.peel.makeable).length;
  const speeds = hrs.map((h) => h.peel.speedMs).filter(Number.isFinite);
  return {
    makeable: makeable > hrs.length / 2,
    speedMs: speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null,
  };
}

/** Whether the tide is helping, in three words rather than a number. */
function tideWord(day) {
  const shift = day.mix?.tideShiftFt ?? 0;
  const t = day.tideAtWindowFt;
  const lo = 1.2 + shift, hi = 3.6 + shift;
  if (t >= lo && t <= hi) return 'in the sweet spot';
  return t < lo ? 'lower than this swell wants' : 'higher than this swell wants';
}

/**
 * Wording describes CONFIDENCE, not lead time. The two usually track each
 * other, but a day where the models disagree drops a notch on its own - and
 * once that happens the days after it inherit the lower rating, because
 * certainty cannot come back. Labelling that day "four to five days out" when
 * it is Friday would be plainly wrong.
 */
const RELIABILITY_TEXT = {
  solid: { label: 'Solid forecast', chip: 'Solid — models agree', note: 'Close in and the models agree. About as good as a wave forecast gets.' },
  likely: { label: 'Likely', chip: 'Likely — size holds, wind may move', note: 'The size usually holds from here; the wind is the part that moves.' },
  planning: { label: 'Planning only', chip: 'Planning only — do not commit', note: 'Far enough out, or the models disagree enough, that this is for picking which day to keep free rather than committing to one.' },
  rough: { label: 'Rough shape', chip: 'Rough shape — a trend, not a forecast', note: 'A trend rather than a forecast. Expect it to move.' },
};

/* ============================================================== the week ==
 *
 * Five tiles, one job: which day do we plan the week around. Sorted by date,
 * not by score, because the answer has to stay in calendar order to be usable -
 * but the best day of the five is marked, so the eye lands on it first.
 */

function renderWeek(days) {
  const card = el('div', { class: 'card' });
  card.appendChild(el('h2', { text: 'The week' }));
  card.appendChild(el('p', { class: 'note', text: `Every day scored for your ${DATA.meta.sessionWindow.label} window — not the day's peak, which is usually some hour you will be at work. Tap a day for the detail.` }));

  const five = days.slice(0, 5);
  const bestScore = Math.max(...five.map((d) => d.windowScore));
  // Only crown a day if it is actually worth crowning. A flat week has no best
  // day, and saying so is the honest answer.
  const worthCrowning = bestScore >= 56;
  const scale = Math.max(3, ...five.map((d) => sizeVal(d.setMaxFt)));

  const grid = el('div', { class: 'week' });
  five.forEach((d, i) => grid.appendChild(weekTile(d, i, worthCrowning && d.windowScore === bestScore, scale)));
  card.appendChild(grid);

  if (!worthCrowning) {
    card.appendChild(el('div', { class: 'alert info' }, [
      el('span', { class: 'ic', text: 'i' }),
      el('div', { html: '<b>No standout day in the next five.</b> Nothing here reaches Good in your window. Plan the week around something else and check back — this page would rather tell you that than talk up the least bad morning.' }),
    ]));
  }
  return card;
}

function weekTile(d, i, isBest, scale) {
  const tone = TONE_VAR[d.tone] || 'var(--muted)';
  const tile = el('button', {
    class: `tile${isBest ? ' best' : ''}${d.date === selectedDate ? ' sel' : ''}`,
    type: 'button',
    'aria-label': `${fmtDate(d.date, { weekday: 'long' })}: ${d.call}, ${n1(sizeVal(d.faceMaxFt))} ${sizeUnit()}, ${d.sizeLabel}`,
  });
  if (isBest) tile.appendChild(el('div', { class: 'tile-ribbon', text: 'Best of the five' }));

  tile.appendChild(el('div', { class: 'tile-day' }, [
    el('span', { class: 'wd', text: i === 0 ? 'Today' : fmtDate(d.date, { weekday: 'short' }) }),
    el('span', { class: 'md', text: fmtDate(d.date, { month: 'short', day: 'numeric' }) }),
  ]));

  tile.appendChild(el('div', { class: 'tile-call', style: `--tone:${tone}` }, [
    el('span', { class: 'call-dot', style: `background:${tone}` }),
    el('span', { text: d.call }),
  ]));

  // Size as a bar as well as a number: five bars side by side answer "which day
  // is biggest" in one glance, which five numbers do not.
  const frac = Math.max(0.04, Math.min(1, sizeVal(d.faceMaxFt) / scale));
  const setFrac = Math.max(frac, Math.min(1, sizeVal(d.setMaxFt) / scale));
  tile.appendChild(el('div', { class: 'tile-bar' }, [
    el('div', { class: 'bar-set', style: `width:${setFrac * 100}%` }),
    el('div', { class: 'bar-typ', style: `width:${frac * 100}%` }),
  ]));
  tile.appendChild(el('div', { class: 'tile-size' }, [
    el('b', { text: `${n1(sizeVal(d.faceMaxFt))} ${sizeUnit()}` }),
    el('span', { text: ` · sets ${n1(sizeVal(d.setMaxFt))}` }),
  ]));
  tile.appendChild(el('div', { class: 'tile-word', text: d.sizeLabel }));

  const meta = el('div', { class: 'tile-meta' });
  meta.appendChild(el('span', {}, [
    windArrow(d.windDirDeg ?? 0, d.windLabel),
    el('span', { text: ` ${n0(d.windKt)} kt ${d.windCompass} ${d.windLabel}` }),
  ]));
  // The dominant swell, not the median of everything in the water. The median
  // reported "6.7s W" on a day the mix bar directly below it called 77% south
  // swell, because a fat slice of short-period chop drags the median down.
  const lead = d.mix?.parts?.[0];
  meta.appendChild(el('span', {
    text: lead ? `${n1(lead.periodS)}s ${lead.dirCompass}` : `${n1(d.periodS)}s ${d.dirCompass}`,
  }));
  meta.appendChild(el('span', { text: `tide ${n1(d.tideAtWindowFt)} ft` }));
  tile.appendChild(meta);

  const tp = peelForDay(d);
  if (tp && !tp.makeable) {
    tile.appendChild(el('div', { class: 'tile-closeout', text: '⚠ Walls / closeouts' }));
  }
  if (d.mix) tile.appendChild(el('div', { class: 'tile-mix' }, [mixBar(d.mix, d)]));

  tile.appendChild(el('div', {
    class: `tile-rel rel-${d.reliability}`,
    text: (RELIABILITY_TEXT[d.reliability] || {}).label || '',
  }));

  tile.addEventListener('click', () => {
    selectedDate = d.date;
    render();
    const h = document.querySelector('#hourly');
    if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  return tile;
}

/** A small inline arrow for wind, pointing the way the wind blows. */
function windArrow(fromDeg, label) {
  const svg = el('svg', { class: 'wind-arrow', width: 13, height: 13, viewBox: '0 0 13 13', 'aria-hidden': 'true' });
  const colour = label === 'offshore' ? 'var(--good)' : label === 'onshore' ? 'var(--serious)' : 'var(--muted)';
  svg.appendChild(el('g', { transform: `translate(6.5,6.5) rotate(${(fromDeg + 180) % 360})` }, [
    el('path', { d: 'M0,-5 L3,4 L0,2.2 L-3,4 Z', fill: colour }),
  ]));
  return svg;
}

/* ========================================================= the swell mix ==
 *
 * The reason this beach is hard to call. Two feet of clean fourteen-second
 * south and two feet of eight-second windswell are the same number and a
 * completely different morning, and a combined height cannot tell them apart.
 */

const MIX_COLORS = {
  southGround: 'var(--mix-south)',
  westGround: 'var(--mix-west)',
  windswell: 'var(--mix-wind)',
};
const MIX_LABEL = {
  southGround: 'South swell',
  westGround: 'W/NW swell',
  windswell: 'Windswell',
};
const MIX_ORDER = ['southGround', 'westGround', 'windswell'];

/** A single stacked bar showing a day's energy split. Always direct-labelled,
 *  because the aqua/orange pair is hard to separate for a tritan viewer. */
function mixBar(mix, day) {
  const wrap = el('div', { class: 'mixbar-wrap' });
  const bar = el('div', { class: 'mixbar', role: 'img', 'aria-label': mix.read });
  for (const p of mix.parts) {
    if (p.share < 0.02) continue;
    const seg = el('div', {
      class: 'mixseg',
      style: `width:${p.share * 100}%;background:${MIX_COLORS[p.cls]}`,
      title: `${MIX_LABEL[p.cls]} — ${Math.round(p.share * 100)}% of the energy, ${n1(p.periodS)}s from the ${p.dirCompass}`,
    });
    bar.appendChild(seg);
  }
  wrap.appendChild(bar);
  const dom = mix.parts[0];
  if (dom) {
    wrap.appendChild(el('div', {
      class: 'mixbar-label',
      text: `${Math.round(dom.share * 100)}% ${MIX_LABEL[dom.cls].toLowerCase()}`
        + (mix.crossing ? ' · crossed up' : ''),
    }));
  }
  return wrap;
}

function renderMix(days) {
  const card = el('div', { class: 'card' });
  card.appendChild(el('h2', { text: 'What the swell is made of' }));
  card.appendChild(el('p', {
    class: 'note',
    text: 'The part a single wave height cannot tell you, and the reason this beach is hard to call. '
      + 'Two feet of clean 14-second south and two feet of 8-second windswell are the same number '
      + 'and a completely different morning. Each band is that swell’s share of the wave, so the '
      + 'bands add up to the face height rather than to some bigger number — real swells combine '
      + 'as energy, which is why two 2 ft swells make a 2.8 ft wave and not a 4 ft one.',
  }));

  const five = days.slice(0, 5);
  const hours = five.flatMap((d) => d.hours || []).filter((h) => h.mixFt);
  if (hours.length) {
    card.appendChild(panel(
      'Swell by type, through the week',
      'Each band is that swell\u2019s share of the wave, so the top of the stack is the whole wave. The dashed line is surface chop on top. Hover for the numbers.',
      (host) => stackedMix(host, hours, five),
      mixLegend(),
    ));
  }

  const list = el('div', { class: 'mixdays' });
  for (const d of five) {
    if (!d.mix) continue;
    const row = el('div', { class: 'mixday' });
    row.appendChild(el('div', { class: 'mixday-head' }, [
      el('b', { text: fmtDate(d.date, { weekday: 'short', month: 'short', day: 'numeric' }) }),
      el('span', { class: 'mixday-call', style: `color:${TONE_VAR[d.tone]}`, text: d.call }),
    ]));
    row.appendChild(mixBar(d.mix, d));
    row.appendChild(el('p', { class: 'mixday-read', text: d.mix.read }));
    row.appendChild(el('p', { class: 'mixday-look', text: d.mix.look }));
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

function mixLegend() {
  const leg = el('div', { class: 'legend' });
  for (const id of MIX_ORDER) {
    leg.appendChild(el('span', { class: 'lg' }, [
      el('span', { class: 'sw', style: `background:${MIX_COLORS[id]}` }),
      el('span', { text: MIX_LABEL[id] }),
    ]));
  }
  leg.appendChild(el('span', { class: 'lg' }, [
    el('span', { class: 'sw sw-chop' }),
    el('span', { text: 'Sub-6s chop (not surf)' }),
  ]));
  return leg;
}

/**
 * Stacked area of each swell class's contribution to the breaking face.
 *
 * Segments are separated by a 2px surface-coloured stroke so adjacent bands
 * never touch: the aqua/orange pair is close under tritan vision, and the gap
 * plus the legend plus the direct day labels carry the identity rather than
 * the hue alone.
 */
function stackedMix(host, hours, days) {
  host.innerHTML = '';
  const W = Math.max(280, host.clientWidth || 320);
  const H = 190;
  const P = { l: 40, r: 12, t: 12, b: 26 };

  const pts = hours.map((h) => ({
    t: Date.parse(h.time),
    v: MIX_ORDER.map((_, i) => sizeVal(h.mixFt[i] || 0)),
    hour: h,
  })).sort((a, b) => a.t - b.t);

  const x0 = pts[0].t, x1 = pts[pts.length - 1].t;
  // The axis is scaled to the SURF. Chop is drawn on the same axis so you can
  // see how it compares, but a 3 ft chop day must not squash a 2 ft swell into
  // the bottom third of the chart - that would hide the thing being plotted.
  const top = Math.max(0.5, ...pts.map((p) => p.v.reduce((a, b) => a + b, 0)));
  const y1 = top * 1.24;
  const X = (t) => P.l + ((t - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
  const Y = (v) => H - P.b - (v / y1) * (H - P.t - P.b);

  const svg = el('svg', { class: 'chart', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });

  for (const tv of niceTicks(0, y1, 3)) {
    svg.appendChild(el('line', { class: 'grid-line', x1: P.l, x2: W - P.r, y1: Y(tv), y2: Y(tv) }));
    svg.appendChild(el('text', { class: 'axis-label', x: P.l - 6, y: Y(tv) + 3.5, 'text-anchor': 'end', text: tv.toFixed(1) }));
  }
  svg.appendChild(el('text', { class: 'axis-label', x: P.l - 6, y: P.t - 1, 'text-anchor': 'end', text: sizeUnit() }));

  // Day separators and labels, so the week is legible without reading the axis.
  for (const d of days) {
    const t = Date.parse(`${d.date}T12:00:00-07:00`);
    if (t < x0 || t > x1) continue;
    svg.appendChild(el('text', {
      class: 'axis-label', x: X(t), y: H - 8, 'text-anchor': 'middle',
      text: fmtDate(d.date, { weekday: 'short' }),
    }));
    const start = Date.parse(`${d.date}T00:00:00-07:00`);
    if (start > x0 && start < x1) {
      svg.appendChild(el('line', { class: 'grid-line', x1: X(start), x2: X(start), y1: P.t, y2: H - P.b }));
    }
  }

  // Bottom-up stack. The band order is fixed so a class never changes position
  // when another one drops to zero.
  const base = pts.map(() => 0);
  const tops = [];
  MIX_ORDER.forEach((id, si) => {
    const lower = pts.map((_, i) => base[i]);
    pts.forEach((p, i) => { base[i] += p.v[si]; });
    if (!pts.some((_, i) => base[i] - lower[i] > 0.01)) return;
    const upPath = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(base[i]).toFixed(1)}`).join(' ');
    const downPath = pts.map((p, i) => `L${X(pts[pts.length - 1 - i].t).toFixed(1)},${Y(lower[pts.length - 1 - i]).toFixed(1)}`).join(' ');
    // Fill only. Stroking the closed band paints a white outline all the way
    // round it, and wherever a band pinches to nothing - one hour where a swell
    // drops out - that outline collapses into a vertical sliver straight
    // through the bands underneath. The 2px separator is drawn as a top edge
    // instead, which cannot do that.
    svg.appendChild(el('path', { d: `${upPath} ${downPath} Z`, fill: MIX_COLORS[id], stroke: 'none' }));
    tops.push(upPath);
  });
  for (const d of tops.slice(0, -1)) {
    svg.appendChild(el('path', {
      d, fill: 'none', stroke: 'var(--surface-1)', 'stroke-width': 2, 'stroke-linejoin': 'round',
    }));
  }

  // Chop rides on top as a dashed outline: present, visible, and unmistakably
  // not part of the stack.
  const chop = pts.map((p, i) => ({
    t: p.t,
    v: Math.min(y1, base[i] + sizeVal(p.hour.chopFt || 0)),
    clipped: base[i] + sizeVal(p.hour.chopFt || 0) > y1,
  }));
  if (chop.some((c, i) => c.v - base[i] > 0.15)) {
    svg.appendChild(el('path', {
      d: chop.map((c, i) => `${i ? 'L' : 'M'}${X(c.t).toFixed(1)},${Y(c.v).toFixed(1)}`).join(' '),
      fill: 'none', stroke: 'var(--muted)', 'stroke-width': 1.5, 'stroke-dasharray': '3 3',
    }));
  }

  svg.appendChild(el('line', { class: 'axis-line', x1: P.l, x2: W - P.r, y1: H - P.b, y2: H - P.b }));

  const cross = el('line', { class: 'axis-line', y1: P.t, y2: H - P.b, opacity: 0 });
  svg.appendChild(cross);
  svg.style.touchAction = 'pan-y';
  const move = (ev) => {
    const box = svg.getBoundingClientRect();
    const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - box.left;
    const t = x0 + ((cx - P.l) / (W - P.l - P.r)) * (x1 - x0);
    const p = pts.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    cross.setAttribute('x1', X(p.t)); cross.setAttribute('x2', X(p.t)); cross.setAttribute('opacity', .5);
    const rows = MIX_ORDER
      .map((id, i) => [MIX_LABEL[id], p.v[i]])
      .filter(([, v]) => v > 0.05)
      .map(([k, v]) => [k, `${v.toFixed(1)} ${sizeUnit()}`]);
    const total = p.v.reduce((a, b) => a + b, 0);
    rows.push(['Together', `${total.toFixed(1)} ${sizeUnit()}`]);
    if ((p.hour.chopFt || 0) > 0.5) rows.push(['Surface chop', `${n1(sizeVal(p.hour.chopFt))} ft`]);
    if (p.hour.crossing) rows.push(['', 'crossed-up sea']);
    const e = ev.touches ? ev.touches[0] : ev;
    showTip(e.clientX, e.clientY, fmtTime(new Date(p.t).toISOString(), { weekday: 'short' }), rows);
  };
  svg.addEventListener('mousemove', move);
  svg.addEventListener('touchstart', move, { passive: true });
  svg.addEventListener('touchmove', move, { passive: true });
  const leave = () => { cross.setAttribute('opacity', 0); hideTip(); };
  svg.addEventListener('mouseleave', leave);
  svg.addEventListener('touchend', leave);
  host.appendChild(svg);
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
      basemap: BASEMAP, nearshore: DATA.nearshore, hourly: DATA.hourly,
      beach: DATA.beach, startIndex: start,
    });
  };
  rerenderers.push(run);
  requestAnimationFrame(run);

  if (DATA.beach) {
    const b = DATA.beach;
    card.appendChild(el('div', { class: 'alert info', style: 'margin-top:12px' }, [
      el('span', { class: 'ic', text: '\u26f0' }),
      el('div', {
        html: `<b>Sand right now:</b> ${b.summary} `
          + (Math.abs(b.shorelineM) < 0.5
            ? 'The waterline is sitting about where it normally does. '
            : `The waterline is about ${Math.abs(b.shorelineM).toFixed(0)} m `
              + `${b.shorelineM > 0 ? 'further out than usual' : 'further up the beach than usual'}. `)
          + `${b.consequence}`
          + (b.spinUpRuns < 40
            ? ` <i>Still building memory \u2014 ${b.spinUpRuns} run${b.spinUpRuns === 1 ? '' : 's'} of history so far, so treat this as provisional.</i>`
            : ''),
      }),
    ]));
  }

  card.appendChild(el('div', { class: 'map-scale' }, [
    el('span', { text: 'Face height' }),
    el('span', { class: 'ramp' }, ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b']
      .map((c) => el('span', { style: `background:${c}` }))),
    el('span', { text: '0 \u2192 8 ft' }),
    el('span', { style: 'margin-left:8px', text: '\u2022 White line: where it breaks. Green stretches are rideable, labelled with how far the section runs and how long the ride lasts.' }),
    el('span', { style: 'margin-left:8px', text: '\u2022 The darker band along the sand is wet beach \u2014 how far up the sea has been since the last high tide. The waterline moves with the tide and with how much sand the beach is holding.' }),
  ]));

  card.appendChild(el('div', { class: 'alert info' }, [
    el('span', { class: 'ic', text: 'i' }),
    el('div', {
      html: '<b>Real:</b> the map geometry (OpenStreetMap), and the wave height, period and '
        + 'direction every ~100 m along this beach from CDIP MOP \u2014 Scripps\u2019 own model, '
        + 'run over surveyed bathymetry. <b>Modelled:</b> the seafloor between the shoreline and '
        + 'the MOP depth contour, including the sandbar and rip channels, and the final step from '
        + 'the MOP line to breaking. The endpoints are measured; the shape between them is not. '
        + 'The waterline is set by the real tide on its own datum, shifted by a sand budget that '
        + 'tracks how much energy this beach has taken lately \u2014 storms pull the berm down and '
        + 'drag the bar offshore, calm spells walk it back. '
        + '<b>Rideable</b> means the break travels along the wave slower than about 11 m/s \u2014 faster than that and the section outruns you, which is a closeout however good it looks.',
    }),
  ]));
  return card;
}

/* -------------------------------------------------------- hourly detail -- */

function renderHourly(day) {
  const card = el('div', { class: 'card', id: 'hourly' });
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

/* ---------------------------------------------------------- what changed -- */

function renderDrift() {
  const card = el('div', { class: 'card' });
  card.appendChild(el('h2', { text: 'What changed since the last runs' }));
  card.appendChild(el('p', { class: 'note', text: 'Every run is archived, so each day can be compared against what we were saying 24, 48 and 120 hours ago. A day that keeps moving is not a forecast yet — a day that has held steady is worth planning around.' }));
  const rows = (DATA.drift || []).slice(0, 7);
  // Count within the rows actually shown. Counting the full 14-day drift array
  // produced "10 of the next 7 days moved meaningfully".
  const moved = rows.filter((d) => !d.stable);
  if (!rows.length || rows.every((r) => r.headline === 'No prior run to compare')) {
    card.appendChild(el('div', { class: 'alert info' }, [
      el('span', { class: 'ic', text: 'i' }),
      el('div', { text: 'No archived runs to compare against yet. This panel fills in once the scheduled build has run a few times.' }),
    ]));
    return card;
  }
  card.appendChild(el('p', { style: 'margin:0 0 10px;font-size:14px' , text:
    moved.length ? `${moved.length} of the next ${rows.length} days moved meaningfully.`
      : `All ${rows.length} days are holding steady across runs.` }));
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
  if (!days?.length) {
    app.appendChild(el('div', { class: 'alert bad' }, [el('div', { text: 'The last run produced no forecast days.' })]));
    return;
  }
  if (!selectedDate || !days.some((d) => d.date === selectedDate)) selectedDate = days[0].date;
  const selected = days.find((d) => d.date === selectedDate);

  if (DATA.meta.synthetic) {
    app.appendChild(el('div', { class: 'alert warn' }, [
      el('span', { class: 'ic', text: '\u26a0' }),
      el('div', { html: '<b>Synthetic data.</b> This page was built without live feeds \u2014 the numbers are physically plausible placeholders for layout review, not a real forecast.' }),
    ]));
  }
  const errs = Object.keys(DATA.meta.errors || {});
  if (errs.length) {
    app.appendChild(el('div', { class: 'alert warn' }, [
      el('span', { class: 'ic', text: '\u26a0' }),
      el('div', { html: `<b>Some sources failed on the last run:</b> ${errs.join(', ')}. The forecast is still built from what did come back.` }),
    ]));
  }

  // The buoy and the models describing different oceans is the single most
  // diagnostic thing this page can tell you, and it belongs above everything.
  if (DATA.buoyCheck?.periodDisagrees) {
    app.appendChild(el('div', { class: 'alert warn' }, [
      el('span', { class: 'ic', text: '⚠' }),
      el('div', {
        html: `<b>The buoy and the models disagree about what is in the water.</b> `
          + `CDIP 100p1 is measuring a <b>${n1(DATA.buoyCheck.buoyPeriodS)} s</b> peak period; the wave models are on `
          + `<b>${n1(DATA.buoyCheck.modelPeriodS)} s</b>. A gap that size normally means the models are missing a swell `
          + `the buoy can already see. The next ${12} hours here are taken from the buoy instead of from them; `
          + `further out, the models are all there is.`,
      }),
    ]));
  }

  // Order is the argument: the call, then the week, then why - and the model's
  // own track record before any of the pretty pictures.
  app.appendChild(renderCall(days, DATA.current, DATA.wetsuit));
  app.appendChild(renderWeek(days));
  app.appendChild(renderMix(days));
  app.appendChild(renderHourly(selected));
  app.appendChild(collapsible('Where it will break', renderMap(selected),
    'A model of this exact stretch of sand. Useful for picking which end of the beach to walk to; not a substitute for looking.'));
  app.appendChild(collapsible('How this forecast has actually done', trustCard(),
    'Every run is checked against the buoy. If this page is wrong, this is where it shows.'));
  app.appendChild(collapsible('Longer outlook, 14 days', outlookCard(days),
    'Beyond about a week a wave model is spotting patterns, not days.'));
  app.appendChild(renderLog());

  $('#sources').innerHTML = [
    `Buoy: ${DATA.meta.sources.buoy}`,
    `Tides: ${DATA.meta.sources.tides}`,
    `Nearshore: ${DATA.meta.sources.nearshore}`,
    `Wave models: ${DATA.meta.sources.waveModels.join(', ')}`,
    `Wind models: ${DATA.meta.sources.windModels.join(', ')}`,
  ].map((s) => `<span>${s}</span>`).join('');
  $('#genline').textContent = `Built ${fmtTime(DATA.meta.generatedAt, { weekday: 'short', month: 'short', day: 'numeric' })} Pacific. Rebuilds every three hours; reload for the latest.`;
  $('#subtitle').textContent = `Surf only, ${DATA.meta.sessionWindow.label}, north lot \u00b7 updated ${fmtTime(DATA.meta.generatedAt, { month: 'short', day: 'numeric' })}`;
}

/**
 * Everything past the week is evidence rather than headline, so it ships folded
 * away. The thirty-second read is the first three cards; the rest is there when
 * somebody wants to argue with it.
 */
function collapsible(title, body, blurb) {
  const wrap = el('details', { class: 'card fold' });
  wrap.appendChild(el('summary', {}, [
    el('span', { class: 'fold-title', text: title }),
    blurb ? el('span', { class: 'fold-blurb', text: blurb }) : null,
  ]));
  const inner = el('div', { class: 'fold-body' });
  inner.appendChild(body);
  wrap.appendChild(inner);
  // Charts measure their host, which is zero-width while folded, so they have
  // to be drawn again the first time the fold opens.
  wrap.addEventListener('toggle', () => { if (wrap.open) rerenderers.forEach((fn) => fn()); }, { once: true });
  return wrap;
}

/**
 * How the forecast did against sessions people actually surfed.
 *
 * The buoy scoreboard below grades the swell, which this model is decent at.
 * This grades the SURF, which is harder and is where it has been caught out:
 * on the first logged session it had the ordinary waves about right and the
 * sets out by a factor of two.
 */
function renderGroundTruth() {
  const g = DATA.groundTruth;
  const card = el('div', { class: 'card' });
  card.appendChild(el('h3', { text: 'Graded against sessions we actually surfed' }));
  card.appendChild(el('p', { class: 'cap', text: 'The buoy check below grades the swell. This grades the surf — set size, shape, and whether the call was right — which no instrument can do.' }));

  if (!g || !g.sessions?.length) {
    card.appendChild(el('div', { class: 'alert info' }, [
      el('span', { class: 'ic', text: 'i' }),
      el('div', { text: 'No sessions logged yet. Use the log at the bottom of the page — this is the only thing that can tell the model it is wrong about the surf rather than about the swell.' }),
    ]));
    return card;
  }

  const sm = g.summary;
  if (sm.n) {
    const stats = el('div', { class: 'statrow' });
    const stat = (k, v, sub) => stats.appendChild(el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), el('div', { class: 's', text: sub }),
    ]));
    stat('Ordinary waves', sm.typicalBiasRatio ? `×${sm.typicalBiasRatio}` : '—', 'observed vs forecast');
    stat('Sets', sm.setBiasRatio ? `×${sm.setBiasRatio}` : '—', 'observed vs forecast');
    stat('Shape call', sm.shapeRightPct != null ? `${sm.shapeRightPct}%` : '—', 'right / wrong');
    stat('Sessions', String(sm.n), 'logged so far');
    card.appendChild(stats);
    card.appendChild(el('p', { class: 'cap', style: 'margin-top:10px', text: sm.note }));
  }

  for (const sess of g.sessions) {
    const row = el('div', { class: 'gt-row' });
    row.appendChild(el('div', { class: 'gt-head' }, [
      el('b', { text: `${fmtDate(sess.date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${sess.window}` }),
      el('span', { class: 'gt-spot', text: sess.spot || '' }),
    ]));
    if (sess.matched) {
      row.appendChild(el('div', { class: 'gt-cmp' }, [
        el('span', { html: `<b>Said</b> ${n1(sess.forecast.typicalFt)} ft, sets ${n1(sess.forecast.setFt)} ft` }),
        el('span', { html: `<b>Was</b> ${n1(sess.observedTypicalFt)} ft, sets ${n1(sess.observedSetFt)} ft` }),
      ]));
      row.appendChild(el('p', { class: 'gt-verdict', text: sess.verdict }));
      if (sess.forecast.hindcast) {
        row.appendChild(el('p', { class: 'cap', text: 'No run was archived before this session, so this compares against the current model looking backwards \u2014 a hindcast, not a forecast that came true.' }));
      }
    } else {
      row.appendChild(el('p', { class: 'cap', text: sess.note }));
    }
    if (sess.sizeWords) row.appendChild(el('p', { class: 'cap', text: `“${sess.sizeWords}”` }));
    if (sess.barNote) row.appendChild(el('p', { class: 'cap', text: sess.barNote }));
    card.appendChild(row);
  }
  return card;
}

function trustCard() {
  const box = el('div');
  box.appendChild(renderGroundTruth());
  box.appendChild(renderSkill());
  box.appendChild(renderDrift());
  box.appendChild(renderBuoy(DATA.current));
  return box;
}

function outlookCard(days) {
  const box = el('div');
  box.appendChild(panel('Window score by day', 'Score for your window, 0\u2013100',
    (host) => scoreBars(host, days, days[0].date, (d) => {
      selectedDate = d.date; render(); window.scrollTo({ top: 0, behavior: 'smooth' });
    })));
  box.appendChild(panel('Model agreement',
    `Range of face heights across ${DATA.meta.sources.waveModels.length} wave models, ${sizeUnit()}. A wide bar means the models disagree and the day is not settled.`,
    (host) => spreadChart(host, days)));
  return box;
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
