/* tp-surfcast — the timeline.
 *
 * Every measure on one shared time axis, stacked, so you read DOWN a moment in
 * time rather than across five separate charts and try to hold the alignment in
 * your head. It opens on today and tomorrow because that is what gets decided
 * most mornings, and drags sideways into next week.
 *
 * The whole range is drawn ONCE into one SVG at a fixed pixels-per-hour, and
 * panning moves a single transform. Redrawing seven tracks on every pointermove
 * would stutter on a phone; moving one <g> does not. The left gutter is drawn
 * after the panning group with an opaque backing, so the labels stay put while
 * the data slides underneath them.
 */
(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, kids) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in (attrs || {})) {
      if (attrs[k] == null || attrs[k] === false) continue;
      if (k === 'text') n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function div(cls, txt) {
    var d = document.createElement('div');
    if (cls) d.className = cls;
    if (txt != null) d.textContent = txt;
    return d;
  }

  /* ------------------------------------------------------------- scoring -- */

  /**
   * Viridis. Chosen because it is perceptually uniform AND stays separable
   * under every common form of colour blindness - a red-to-green "bad to good"
   * ramp, which is what surf forecasts almost always use, is the exact pair
   * that eight percent of men cannot tell apart.
   */
  var SCORE_BANDS = [
    { min: 88, color: '#fde725', label: 'Epic' },
    { min: 72, color: '#7ad151', label: 'Very good' },
    { min: 56, color: '#22a884', label: 'Good' },
    { min: 40, color: '#2a788e', label: 'Fair' },
    { min: 25, color: '#414487', label: 'Poor' },
    { min: -1, color: '#440154', label: 'Flat / blown' },
  ];
  function scoreBand(v) {
    for (var i = 0; i < SCORE_BANDS.length; i++) {
      if (v >= SCORE_BANDS[i].min) return SCORE_BANDS[i];
    }
    return SCORE_BANDS[SCORE_BANDS.length - 1];
  }

  /* --------------------------------------------------------------- tracks -- */

  var GUT = 44;          // left gutter for the row labels
  var AXIS_H = 26;       // day / hour strip under the tracks
  var MINI_H = 46;       // the overview strip
  var HOURS_VISIBLE = 48;

  window.TPTimeline = {
    SCORE_BANDS: SCORE_BANDS,
    scoreBand: scoreBand,

    mount: function (host, opts) {
      var hours = (opts.hours || []).slice().sort(function (a, b) {
        return Date.parse(a.time) - Date.parse(b.time);
      });
      if (hours.length < 4) {
        host.appendChild(div('cap', 'Not enough hourly data to draw the timeline.'));
        return null;
      }
      var sizeVal = opts.sizeVal || function (x) { return x; };
      var sizeUnit = opts.sizeUnit || 'ft';
      var showTip = opts.showTip, hideTip = opts.hideTip;
      var tz = opts.timeZone || 'America/Los_Angeles';

      var t0 = Date.parse(hours[0].time);
      var t1 = Date.parse(hours[hours.length - 1].time);

      // Which tracks exist depends on what the run actually produced.
      var has = function (key) { return hours.some(function (h) { return Number.isFinite(h[key]); }); };
      var tracks = [
        { id: 'score', label: 'Score', unit: '', h: 30, kind: 'ribbon' },
        { id: 'size', label: 'Size', unit: sizeUnit, h: 104, kind: 'size' },
        { id: 'periodS', label: 'Period', unit: 's', h: 68, kind: 'line', color: 'var(--swell)', zeroBase: false, decimals: 0 },
        { id: 'dirDeg', label: 'Swell', unit: '', h: 52, kind: 'arrows', what: 'swell' },
        { id: 'windKt', label: 'Wind', unit: 'kt', h: 76, kind: 'wind' },
        { id: 'tideFt', label: 'Tide', unit: 'ft', h: 76, kind: 'line', color: 'var(--tide)', softColor: 'var(--tide-soft)', area: true, zeroBase: false, decimals: 1 },
      ];
      if (has('waterF')) {
        tracks.push({ id: 'waterF', label: 'Water', unit: '°F', h: 44, kind: 'temp' });
      }

      var totalH = tracks.reduce(function (a, t) { return a + t.h + 6; }, 0);

      /* ---------------------------------------------------------- shell -- */
      host.innerHTML = '';
      var wrap = div('tl');
      var plot = div('tl-plot');
      wrap.appendChild(plot);
      var miniHost = div('tl-mini');
      wrap.appendChild(miniHost);
      var hint = div('tl-hint', 'Drag the charts sideways, or drag the bar below, to look further ahead. Hover or tap for the numbers.');
      wrap.appendChild(hint);
      wrap.appendChild(legend());
      host.appendChild(wrap);

      var W = 0, pxPerHour = 0, contentW = 0, offset = 0, maxOffset = 0;
      var svg, pan, cross, nowLine, mini, miniView;

      function xOf(ms) { return ((ms - t0) / 36e5) * pxPerHour; }
      function msAt(px) { return t0 + ((px + offset) / pxPerHour) * 36e5; }

      /* ------------------------------------------------------------ build -- */
      function build() {
        W = Math.max(260, plot.clientWidth || host.clientWidth || 320);
        pxPerHour = (W - GUT) / HOURS_VISIBLE;
        contentW = ((t1 - t0) / 36e5) * pxPerHour;
        maxOffset = Math.max(0, contentW - (W - GUT));

        plot.innerHTML = '';
        svg = el('svg', { width: W, height: totalH + AXIS_H, viewBox: '0 0 ' + W + ' ' + (totalH + AXIS_H), class: 'tl-svg' });

        // Clip the panning content so it cannot run under the gutter.
        var clip = el('clipPath', { id: 'tlclip' }, [
          el('rect', { x: GUT, y: 0, width: W - GUT, height: totalH + AXIS_H }),
        ]);
        svg.appendChild(el('defs', {}, [clip]));

        var clipped = el('g', { 'clip-path': 'url(#tlclip)' });
        pan = el('g', { transform: 'translate(' + GUT + ',0)' });
        clipped.appendChild(pan);
        svg.appendChild(clipped);

        // Session-window shading and midnight rules, behind everything.
        drawBands(pan, totalH);

        var y = 0;
        tracks.forEach(function (tr) {
          drawTrack(pan, tr, y, tr.h);
          tr._y = y;
          y += tr.h + 6;
        });
        drawAxis(pan, totalH);

        // Now marker, in the panning group so it sits at the right moment.
        nowLine = el('line', {
          x1: xOf(Date.now()), x2: xOf(Date.now()), y1: 0, y2: totalH,
          class: 'tl-now',
        });
        pan.appendChild(nowLine);

        // Gutter last, on top, with an opaque backing.
        var gut = el('g', { class: 'tl-gut' });
        gut.appendChild(el('rect', { x: 0, y: 0, width: GUT, height: totalH + AXIS_H, class: 'tl-gutter' }));
        tracks.forEach(function (tr) {
          gut.appendChild(el('text', { x: GUT - 6, y: tr._y + 11, 'text-anchor': 'end', class: 'tl-rowlabel', text: tr.label }));
          if (tr.unit) gut.appendChild(el('text', { x: GUT - 6, y: tr._y + 22, 'text-anchor': 'end', class: 'tl-rowunit', text: tr.unit }));
          // Scale numbers. A shape with no numbers on it is a sparkline, not a
          // graph, and reading values off is the whole point of this page.
          //
          // They sit just INSIDE the plot rather than in the gutter: at 44px
          // the gutter holds a row label and a unit and nothing else, and
          // stacking numbers there put them straight through the words.
          if (!tr._e) return;
          var pad = tr._inset || 10;
          var mid = (tr._e.lo + tr._e.hi) / 2;
          [tr._e.hi, mid].forEach(function (v) {
            var yy = tr._y + tr.h - ((v - tr._e.lo) / (tr._e.hi - tr._e.lo)) * (tr.h - pad) - 4;
            gut.appendChild(el('text', {
              x: GUT + 3, y: yy + 3, 'text-anchor': 'start', class: 'tl-scale',
              text: v.toFixed(tr._dec || 0),
            }));
          });
        });
        svg.appendChild(gut);

        cross = el('line', { x1: 0, x2: 0, y1: 0, y2: totalH, class: 'tl-cross', opacity: 0 });
        svg.appendChild(cross);

        plot.appendChild(svg);
        buildMini();
        applyOffset();
      }

      /* ------------------------------------------------------------ bands -- */
      function drawBands(g, h) {
        var run = null;
        hours.forEach(function (hr, i) {
          if (hr.inWindow && run == null) run = Date.parse(hr.time);
          var ends = !hr.inWindow || i === hours.length - 1;
          if (run != null && ends) {
            g.appendChild(el('rect', {
              x: xOf(run), y: 0, width: Math.max(2, xOf(Date.parse(hr.time)) - xOf(run)),
              height: h, class: 'tl-window',
            }));
            run = null;
          }
        });
        // Midnight rules.
        eachMidnight(function (ms) {
          g.appendChild(el('line', { x1: xOf(ms), x2: xOf(ms), y1: 0, y2: h, class: 'tl-midnight' }));
        });
      }

      function eachMidnight(fn) {
        var d = new Date(t0);
        for (var i = 0; i < 20; i++) {
          var key = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
          var ms = Date.parse(key + 'T00:00:00' + tzOffset(d));
          if (ms > t0 && ms < t1) fn(ms);
          d = new Date(d.getTime() + 24 * 36e5);
        }
      }
      function tzOffset(d) {
        // Pacific is -07:00 or -08:00; derive it rather than assuming.
        var s = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
          .formatToParts(d).find(function (p) { return p.type === 'timeZoneName'; });
        var m = s && s.value.match(/([+-]\d{2}:\d{2})/);
        return m ? m[1] : '-07:00';
      }

      /* ----------------------------------------------------------- tracks -- */
      function series(key) {
        return hours.map(function (h) { return { t: Date.parse(h.time), v: h[key], h: h }; })
          .filter(function (p) { return Number.isFinite(p.v); });
      }
      function extent(pts, zeroBase) {
        var vs = pts.map(function (p) { return p.v; });
        var lo = zeroBase ? Math.min(0, Math.min.apply(null, vs)) : Math.min.apply(null, vs);
        var hi = Math.max.apply(null, vs);
        if (hi - lo < 1e-6) hi = lo + 1;
        // Scales are GLOBAL over the whole range, not per-view: a chart whose
        // axis jumps while you drag is unreadable, and comparing Saturday to
        // today is the point. Keep the headroom small so a flat week still
        // fills the box.
        var pad = (hi - lo) * 0.08;
        return { lo: zeroBase ? lo : lo - pad, hi: hi + pad };
      }

      function drawTrack(g, tr, y, h) {
        if (tr.kind === 'ribbon') return drawRibbon(g, y, h);
        if (tr.kind === 'size') return drawSize(g, tr, y, h);
        if (tr.kind === 'arrows') return drawArrows(g, y, h);
        if (tr.kind === 'wind') return drawWind(g, tr, y, h);
        if (tr.kind === 'temp') return drawTemp(g, tr, y, h);
        return drawLine(g, tr, y, h);
      }

      function drawRibbon(g, y, h) {
        hours.forEach(function (hr, i) {
          if (!Number.isFinite(hr.score)) return;
          var nxt = hours[i + 1] ? Date.parse(hours[i + 1].time) : Date.parse(hr.time) + 36e5;
          var x = xOf(Date.parse(hr.time));
          g.appendChild(el('rect', {
            x: x, y: y + 4, width: Math.max(1, xOf(nxt) - x - 0.5), height: h - 8,
            fill: scoreBand(hr.score).color,
          }));
        });
      }

      function drawSize(g, tr, y, h) {
        var face = series('faceFt'), sets = series('faceSetFt');
        if (!face.length) return;
        var all = face.concat(sets);
        var e = extent(all.map(function (p) { return { v: sizeVal(p.v) }; }), true);
        tr._e = e; tr._dec = 1;
        var Y = function (v) { return y + h - ((sizeVal(v) - e.lo) / (e.hi - e.lo)) * (h - 10) - 4; };
        gridFor(g, y, h, e);

        // Sets as a lighter band ABOVE the ordinary wave: the gap between the
        // two lines is the thing that decides whether a session is worth it.
        var band = sets.map(function (p, i) { return (i ? 'L' : 'M') + xOf(p.t).toFixed(1) + ',' + Y(p.v).toFixed(1); }).join(' ');
        var backFace = face.slice().reverse()
          .map(function (p) { return 'L' + xOf(p.t).toFixed(1) + ',' + Y(p.v).toFixed(1); }).join(' ');
        g.appendChild(el('path', { d: band + ' ' + backFace + ' Z', fill: 'var(--swell-soft)', stroke: 'none' }));

        var fd = face.map(function (p, i) { return (i ? 'L' : 'M') + xOf(p.t).toFixed(1) + ',' + Y(p.v).toFixed(1); }).join(' ');
        g.appendChild(el('path', {
          d: fd + ' L' + xOf(face[face.length - 1].t).toFixed(1) + ',' + Y(0).toFixed(1)
            + ' L' + xOf(face[0].t).toFixed(1) + ',' + Y(0).toFixed(1) + ' Z',
          fill: 'var(--swell)', opacity: 0.22, stroke: 'none',
        }));
        g.appendChild(el('path', { d: fd, fill: 'none', stroke: 'var(--swell)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
        g.appendChild(el('path', { d: band, fill: 'none', stroke: 'var(--swell)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3', opacity: 0.75 }));
      }

      function drawLine(g, tr, y, h) {
        var pts = series(tr.id);
        if (!pts.length) return;
        var e = extent(pts, tr.zeroBase);
        tr._e = e; tr._dec = tr.decimals || 0;
        var Y = function (v) { return y + h - ((v - e.lo) / (e.hi - e.lo)) * (h - 10) - 4; };
        gridFor(g, y, h, e);
        var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + xOf(p.t).toFixed(1) + ',' + Y(p.v).toFixed(1); }).join(' ');
        if (tr.area) {
          g.appendChild(el('path', {
            d: d + ' L' + xOf(pts[pts.length - 1].t).toFixed(1) + ',' + (y + h - 4)
              + ' L' + xOf(pts[0].t).toFixed(1) + ',' + (y + h - 4) + ' Z',
            fill: tr.softColor || 'var(--swell-soft)', stroke: 'none',
          }));
        }
        g.appendChild(el('path', { d: d, fill: 'none', stroke: tr.color, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
      }

      function drawArrows(g, y, h) {
        var step = Math.max(1, Math.round(26 / pxPerHour));
        for (var i = 0; i < hours.length; i += step) {
          var hr = hours[i];
          if (!Number.isFinite(hr.dirDeg)) continue;
          var cx = xOf(Date.parse(hr.time)), cy = y + h / 2 - 3;
          g.appendChild(el('g', { transform: 'translate(' + cx + ',' + cy + ') rotate(' + ((hr.dirDeg + 180) % 360) + ')' }, [
            el('path', { d: 'M0,-8 L4.4,6 L0,3.6 L-4.4,6 Z', fill: periodShade(hr.periodS), stroke: 'var(--surface-1)', 'stroke-width': 0.8 }),
          ]));
          if (i % (step * 4) === 0) {
            g.appendChild(el('text', { x: cx, y: y + h - 1, 'text-anchor': 'middle', class: 'tl-tick', text: hr.dirCompass || '' }));
          }
        }
      }

      function drawWind(g, tr, y, h) {
        var pts = series('windKt');
        if (!pts.length) return;
        var e = extent(pts, true);
        tr._e = e; tr._dec = 0; tr._inset = 20;
        var Y = function (v) { return y + h - ((v - e.lo) / (e.hi - e.lo)) * (h - 20) - 4; };
        gridFor(g, y, h, e, 20);
        var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + xOf(p.t).toFixed(1) + ',' + Y(p.v).toFixed(1); }).join(' ');
        g.appendChild(el('path', {
          d: d + ' L' + xOf(pts[pts.length - 1].t).toFixed(1) + ',' + (y + h - 4)
            + ' L' + xOf(pts[0].t).toFixed(1) + ',' + (y + h - 4) + ' Z',
          fill: 'var(--wind-soft)', stroke: 'none',
        }));
        g.appendChild(el('path', { d: d, fill: 'none', stroke: 'var(--wind)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
        // Direction arrows along the bottom, coloured by whether it helps.
        var step = Math.max(1, Math.round(24 / pxPerHour));
        for (var i = 0; i < hours.length; i += step) {
          var hr = hours[i];
          if (!Number.isFinite(hr.windDirDeg)) continue;
          var c = hr.windLabel === 'offshore' ? 'var(--good)'
            : hr.windLabel === 'onshore' ? 'var(--serious)' : 'var(--muted)';
          g.appendChild(el('g', {
            transform: 'translate(' + xOf(Date.parse(hr.time)) + ',' + (y + h - 8) + ') rotate(' + ((hr.windDirDeg + 180) % 360) + ')',
          }, [el('path', { d: 'M0,-5 L2.8,4 L0,2.4 L-2.8,4 Z', fill: c })]));
        }
      }

      function drawTemp(g, tr, y, h) {
        var pts = series('waterF');
        if (!pts.length) return;
        var e = extent(pts, false);
        tr._e = e; tr._dec = 0; tr._inset = 16;
        var Y = function (v) { return y + h - ((v - e.lo) / (e.hi - e.lo)) * (h - 16) - 4; };
        var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + xOf(p.t).toFixed(1) + ',' + Y(p.v).toFixed(1); }).join(' ');
        g.appendChild(el('path', { d: d, fill: 'none', stroke: 'var(--tide)', 'stroke-width': 2 }));
        // Label the ends so the trend has numbers on it without an axis.
        [pts[0], pts[pts.length - 1]].forEach(function (p, i) {
          g.appendChild(el('text', {
            x: xOf(p.t) + (i ? -4 : 4), y: Y(p.v) - 5,
            'text-anchor': i ? 'end' : 'start', class: 'tl-tick', text: p.v.toFixed(0) + '°',
          }));
        });
      }

      function gridFor(g, y, h, e, inset) {
        var pad = inset || 10;
        [e.lo, (e.lo + e.hi) / 2].forEach(function (v) {
          var yy = y + h - ((v - e.lo) / (e.hi - e.lo)) * (h - pad) - 4;
          g.appendChild(el('line', { x1: 0, x2: contentW, y1: yy, y2: yy, class: 'tl-grid' }));
        });
      }

      var PERIOD_SHADES = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#0d366b'];
      function periodShade(T) {
        var i = Math.floor(((T - 6) / 14) * PERIOD_SHADES.length);
        return PERIOD_SHADES[Math.max(0, Math.min(PERIOD_SHADES.length - 1, i))];
      }

      /* ------------------------------------------------------------- axis -- */
      function drawAxis(g, y) {
        g.appendChild(el('line', { x1: 0, x2: contentW, y1: y, y2: y, class: 'tl-axisline' }));
        var fmtH = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric' });
        var fmtD = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'numeric', day: 'numeric' });
        hours.forEach(function (hr) {
          var ms = Date.parse(hr.time);
          var lbl = fmtH.format(new Date(ms));
          if (['6 AM', '12 PM', '6 PM'].indexOf(lbl) < 0) return;
          g.appendChild(el('text', {
            x: xOf(ms), y: y + 13, 'text-anchor': 'middle', class: 'tl-tick',
            text: lbl.replace(' AM', 'a').replace(' PM', 'p'),
          }));
        });
        eachMidnight(function (ms) {
          g.appendChild(el('text', { x: xOf(ms) + 4, y: y + 24, 'text-anchor': 'start', class: 'tl-day', text: fmtD.format(new Date(ms)) }));
        });
        g.appendChild(el('text', { x: 4, y: y + 24, 'text-anchor': 'start', class: 'tl-day', text: fmtD.format(new Date(t0)) }));
      }

      /* ------------------------------------------------------------- mini -- */
      function buildMini() {
        miniHost.innerHTML = '';
        mini = el('svg', { width: W, height: MINI_H, viewBox: '0 0 ' + W + ' ' + MINI_H, class: 'tl-minisvg' });
        var mx = function (ms) { return GUT + ((ms - t0) / (t1 - t0)) * (W - GUT); };
        // The score ribbon again, whole range: where the good days are, at a glance.
        hours.forEach(function (hr, i) {
          if (!Number.isFinite(hr.score)) return;
          var nxt = hours[i + 1] ? Date.parse(hours[i + 1].time) : t1;
          var x = mx(Date.parse(hr.time));
          mini.appendChild(el('rect', {
            x: x, y: 6, width: Math.max(0.8, mx(nxt) - x), height: 16,
            fill: scoreBand(hr.score).color,
          }));
        });
        // Day labels only where there is room for them. Fourteen days across a
        // phone ran them into one another - "ThuFriSatSunMon" - so a label is
        // skipped unless it clears the last one drawn.
        var lastLabelX = -999;
        eachMidnight(function (ms) {
          var x = mx(ms);
          mini.appendChild(el('line', { x1: x, x2: x, y1: 4, y2: 24, class: 'tl-midnight' }));
          if (x - lastLabelX < 30) return;
          lastLabelX = x;
          mini.appendChild(el('text', {
            x: x + 3, y: 34, class: 'tl-day',
            text: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(ms)),
          }));
        });
        mini.appendChild(el('text', { x: GUT - 6, y: 18, 'text-anchor': 'end', class: 'tl-rowlabel', text: 'All' }));
        miniView = el('rect', { x: GUT, y: 3, width: 10, height: 22, class: 'tl-miniview' });
        mini.appendChild(miniView);
        miniHost.appendChild(mini);

        var dragging = false;
        var jump = function (ev) {
          var box = mini.getBoundingClientRect();
          var px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - box.left;
          var frac = Math.max(0, Math.min(1, (px - GUT) / (W - GUT)));
          var centreMs = t0 + frac * (t1 - t0);
          offset = clamp(xOf(centreMs) - (W - GUT) / 2);
          applyOffset();
        };
        mini.addEventListener('pointerdown', function (e) { dragging = true; mini.setPointerCapture(e.pointerId); jump(e); });
        mini.addEventListener('pointermove', function (e) { if (dragging) jump(e); });
        mini.addEventListener('pointerup', function () { dragging = false; });
        mini.addEventListener('pointercancel', function () { dragging = false; });
      }

      function clamp(v) { return Math.max(0, Math.min(maxOffset, v)); }

      function applyOffset() {
        pan.setAttribute('transform', 'translate(' + (GUT - offset) + ',0)');
        if (miniView) {
          var vw = ((W - GUT) / contentW) * (W - GUT);
          miniView.setAttribute('x', GUT + (offset / contentW) * (W - GUT));
          miniView.setAttribute('width', Math.max(6, vw));
        }
      }

      /* ------------------------------------------------------ interaction -- */
      var down = null, moved = false;
      function onDown(e) {
        down = { x: e.clientX, offset: offset };
        moved = false;
        svg.setPointerCapture && svg.setPointerCapture(e.pointerId);
        svg.classList.add('grabbing');
      }
      function onMove(e) {
        if (down) {
          var dx = e.clientX - down.x;
          if (Math.abs(dx) > 3) moved = true;
          offset = clamp(down.offset - dx);
          applyOffset();
          if (hideTip) hideTip();
          return;
        }
        readout(e);
      }
      function onUp() { down = null; svg.classList.remove('grabbing'); }

      function readout(e) {
        var box = svg.getBoundingClientRect();
        var px = (e.touches ? e.touches[0].clientX : e.clientX) - box.left;
        if (px < GUT) { cross.setAttribute('opacity', 0); if (hideTip) hideTip(); return; }
        var ms = msAt(px - GUT);
        var best = null;
        for (var i = 0; i < hours.length; i++) {
          var d = Math.abs(Date.parse(hours[i].time) - ms);
          if (!best || d < best.d) best = { d: d, h: hours[i] };
        }
        if (!best || best.d > 2 * 36e5) { cross.setAttribute('opacity', 0); if (hideTip) hideTip(); return; }
        cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('opacity', 1);
        var h = best.h;
        var rows = [
          ['Score', Math.round(h.score) + ' · ' + scoreBand(h.score).label],
          ['Size', sizeVal(h.faceFt).toFixed(1) + ' ' + sizeUnit + '  (sets ' + sizeVal(h.faceSetFt).toFixed(1) + ')'],
          ['Period', (h.periodS || 0).toFixed(0) + ' s'],
          ['Swell', (h.dirCompass || '') + ' ' + Math.round(h.dirDeg || 0) + '°'],
          ['Wind', Math.round(h.windKt || 0) + ' kt ' + (h.windCompass || '') + ' ' + (h.windLabel || '')],
          ['Tide', (h.tideFt || 0).toFixed(1) + ' ft ' + (h.tideRate > 0 ? 'rising' : 'falling')],
        ];
        if (Number.isFinite(h.waterF)) rows.push(['Water', Math.round(h.waterF) + '°F']);
        if (showTip) {
          showTip(e.clientX, e.clientY,
            new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' })
              .format(new Date(h.time)), rows);
        }
      }

      function legend() {
        var box = div('tl-legend');
        box.appendChild(div('tl-legend-k', 'Score'));
        SCORE_BANDS.slice().reverse().forEach(function (b) {
          var item = div('tl-legend-i');
          var sw = div('sw'); sw.style.background = b.color;
          item.appendChild(sw);
          item.appendChild(div(null, b.label));
          box.appendChild(item);
        });
        return box;
      }

      build();
      // Open on today and tomorrow: a little before now, so a session already
      // under way is still on screen, and two full days forward.
      offset = clamp(xOf(Date.now() - 3 * 36e5));
      applyOffset();

      plot.addEventListener('pointerdown', onDown);
      plot.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      plot.addEventListener('pointerleave', function () {
        if (cross) cross.setAttribute('opacity', 0);
        if (hideTip) hideTip();
      });
      plot.addEventListener('wheel', function (e) {
        var dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
        if (!dx) return;
        e.preventDefault();
        offset = clamp(offset + dx);
        applyOffset();
      }, { passive: false });

      return {
        resize: function () {
          var keepMs = msAt(0);
          build();
          offset = clamp(xOf(keepMs));
          applyOffset();
        },
        destroy: function () { window.removeEventListener('pointerup', onUp); },
      };
    },
  };
})();
