/* Torrey Pines north lot - surf map.
 *
 * A map of this specific piece of coast with the surf modelled on top of it.
 *
 * WHAT IS REAL
 *   - The map: coastline, the north lot, North Torrey Pines Road, the access
 *     paths and the lagoon are OpenStreetMap vector geometry, not a drawing.
 *   - The waves: CDIP MOP publishes height, period and direction every ~100 m
 *     along this beach, refracted over surveyed bathymetry. Each grid cell takes
 *     its offshore condition from the nearest MOP line.
 *   - The depth at the MOP lines, which anchors the profile.
 *
 * WHAT IS MODELLED
 *   - The seafloor BETWEEN the shoreline and the MOP depth contour. An
 *     equilibrium profile is fitted so it passes through zero at the real
 *     shoreline and through MOP's real published depth at the real MOP
 *     distance, with a sandbar and rip channels at typical spacing on top.
 *     The endpoints are measured; the shape between them is not.
 *   - Everything from the MOP line shoreward: refraction, shoaling, breaking.
 *
 * Plain script, not a module: the preview build inlines it.
 */
(function () {
  'use strict';

  var G = 9.81;
  var M_FT = 3.28084;
  var GAMMA = 0.78;
  var FACE_FACTOR = 0.74;   // matches src/config.js

  /* ---------------------------------------------------------- projection -- */

  function makeProjection(frame, w, h) {
    var latMid = (frame.n + frame.s) / 2;
    var kx = Math.cos(latMid * Math.PI / 180);
    var spanLon = (frame.e - frame.w) * kx;
    var spanLat = frame.n - frame.s;
    var scale = Math.max(w / spanLon, h / spanLat);
    var ox = (w - spanLon * scale) / 2;
    var oy = (h - spanLat * scale) / 2;
    return {
      scale: scale, kx: kx,
      // The rectangle the map actually occupies. Anything drawn from grid
      // indices must go through this, not the raw canvas size.
      rect: { x: ox, y: oy, w: spanLon * scale, h: spanLat * scale },
      x: function (lon) { return ox + (lon - frame.w) * kx * scale; },
      y: function (lat) { return oy + (frame.n - lat) * scale; },
      lon: function (px) { return frame.w + (px - ox) / (scale * kx); },
      lat: function (py) { return frame.n - (py - oy) / scale; },
      metresPerPx: 111320 / scale,
    };
  }

  /* ----------------------------------------------------------- shoreline -- */

  /** Longest coastline way, as a polyline ordered south to north. */
  function shorelineFrom(features) {
    var ways = features.filter(function (f) { return f.layer === 'coastline' && f.line; });
    if (!ways.length) return null;
    var pts = [];
    ways.sort(function (a, b) { return b.line.length - a.line.length; });
    ways.forEach(function (w) { pts = pts.concat(w.line); });
    pts.sort(function (a, b) { return a[1] - b[1]; });
    return pts;
  }

  /**
   * Nearest point on the shoreline, in metres, plus the local coast bearing.
   * Everything about depth and wave angle hangs off this.
   */
  function shoreGeometry(shore, lon, lat) {
    var kx = Math.cos(lat * Math.PI / 180);
    var best = null;
    for (var i = 0; i < shore.length - 1; i++) {
      var ax = (shore[i][0] - lon) * kx * 111320, ay = (shore[i][1] - lat) * 111320;
      var bx = (shore[i + 1][0] - lon) * kx * 111320, by = (shore[i + 1][1] - lat) * 111320;
      var dx = bx - ax, dy = by - ay;
      var len2 = dx * dx + dy * dy;
      var t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      var px = ax + t * dx, py = ay + t * dy;
      var d = Math.hypot(px, py);
      if (!best || d < best.dist) {
        best = { dist: d, seaward: px > 0, bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 };
      }
    }
    return best;
  }

  /* --------------------------------------------------------- wave theory -- */

  function wavenumber(omega, h) {
    if (!(h > 0.05)) return null;
    var k0 = omega * omega / G;
    var k = k0 / Math.sqrt(Math.tanh(k0 * h));
    for (var i = 0; i < 10; i++) {
      var th = Math.tanh(k * h);
      var f = G * k * th - omega * omega;
      var df = G * th + G * k * h * (1 - th * th);
      var n = k - f / df;
      if (!isFinite(n) || n <= 0) break;
      if (Math.abs(n - k) < 1e-9) { k = n; break; }
      k = n;
    }
    return k;
  }
  function groupSpeed(omega, k, h) {
    var kh2 = 2 * k * h;
    var n = kh2 > 50 ? 0.5 : 0.5 * (1 + kh2 / Math.sinh(kh2));
    return n * omega / k;
  }
  function angDiff(a, b) { return ((a - b + 540) % 360) - 180; }

  /* -------------------------------------------------------------- field -- */

  var GRID = { nx: 190, ny: 150 };

  /**
   * Build the modelled seafloor and the wave field for one hour.
   * `lines` are the MOP lines for this frame with their values at this hour.
   */
  function buildField(ctxInfo, lines, tideFt, bar) {
    var proj = ctxInfo.proj, frame = ctxInfo.frame, shore = ctxInfo.shore;
    var nx = GRID.nx, ny = GRID.ny;
    var depth = new Float32Array(nx * ny);
    var amp = new Float32Array(nx * ny);
    var phase = new Float32Array(nx * ny);
    var foam = new Float32Array(nx * ny);
    var faceFt = new Float32Array(nx * ny);
    var land = new Uint8Array(nx * ny);
    // Where the wave first breaks on each alongshore row, and how deep it is
    // there. This is the whitewater line, and the geometry the peel comes from.
    var breakIx = new Int16Array(ny).fill(-1);
    var breakDepth = new Float32Array(ny);
    var breakAngle = new Float32Array(ny).fill(NaN);
    var tideM = (tideFt || 0) * 0.3048;

    // Each MOP line, with its real distance offshore, so the profile can be
    // fitted between two measured points instead of assumed outright.
    var anchors = lines.map(function (l) {
      var g = shoreGeometry(shore, l.lon, l.lat);
      return { lat: l.lat, lon: l.lon, dist: Math.max(120, g ? g.dist : 900), depthM: l.depthM || 10, rec: l };
    }).sort(function (a, b) { return a.lat - b.lat; });

    function blendAt(lat) {
      if (!anchors.length) return null;
      if (lat <= anchors[0].lat) return anchors[0];
      if (lat >= anchors[anchors.length - 1].lat) return anchors[anchors.length - 1];
      var i = 1;
      while (i < anchors.length && anchors[i].lat < lat) i++;
      var a = anchors[i - 1], b = anchors[i];
      var span = b.lat - a.lat;
      var f = span ? (lat - a.lat) / span : 0;
      var mix = function (x, y) {
        if (x == null) return y; if (y == null) return x;
        return x + (y - x) * f;
      };
      // Directions are compass bearings; blend them as vectors.
      var mixDir = function (x, y) {
        if (x == null) return y; if (y == null) return x;
        var ax = Math.cos(x * Math.PI / 180) * (1 - f) + Math.cos(y * Math.PI / 180) * f;
        var ay = Math.sin(x * Math.PI / 180) * (1 - f) + Math.sin(y * Math.PI / 180) * f;
        return ((Math.atan2(ay, ax) * 180 / Math.PI) + 360) % 360;
      };
      return {
        dist: mix(a.dist, b.dist),
        depthM: mix(a.depthM, b.depthM),
        rec: {
          hsM: mix(a.rec && a.rec.hsM, b.rec && b.rec.hsM),
          periodS: mix(a.rec && a.rec.periodS, b.rec && b.rec.periodS),
          dirDeg: mixDir(a.rec && a.rec.dirDeg, b.rec && b.rec.dirDeg),
          shoreNormalDeg: mixDir(a.rec && a.rec.shoreNormalDeg, b.rec && b.rec.shoreNormalDeg),
        },
      };
    }

    var cellW = (frame.e - frame.w) / nx;
    var cellH = (frame.n - frame.s) / ny;

    for (var iy = 0; iy < ny; iy++) {
      var lat = frame.n - (iy + 0.5) * cellH;
      var a = blendAt(lat);
      if (!a) continue;
      // Fit h = A * x^(2/3) through the real MOP depth at its real distance.
      var A = a.depthM / Math.pow(a.dist, 2 / 3);
      var rec = a.rec;

      var broken = false;
      for (var ix = 0; ix < nx; ix++) {
        var idx = iy * nx + ix;
        var lon = frame.w + (ix + 0.5) * cellW;
        var g = shoreGeometry(shore, lon, lat);
        if (!g) { land[idx] = 1; continue; }
        if (!g.seaward) { land[idx] = 1; depth[idx] = -1; continue; }

        var x = g.dist;
        var h = A * Math.pow(x, 2 / 3);
        // Sandbar and rip channels: modelled, not surveyed.
        if (bar) {
          var ph = (2 * Math.PI * (lat - frame.s) * 111320) / bar.ripSpacingM;
          var crest = bar.crestM + bar.meanderM * Math.sin(ph);
          var strength = bar.floor + (1 - bar.floor) * (0.5 + 0.5 * Math.cos(ph));
          var dd = (x - crest) / bar.widthM;
          h -= bar.heightM * strength * Math.exp(-dd * dd);
          var dt = (x - (crest - bar.widthM * 1.5)) / (bar.widthM * 0.9);
          h += 0.3 * strength * Math.exp(-dt * dt);
        }
        h += tideM;
        depth[idx] = h;
        if (h <= 0.12) { land[idx] = 1; continue; }

        if (!rec || !(rec.hsM > 0) || !(rec.periodS > 0)) continue;
        var omega = 2 * Math.PI / rec.periodS;
        var shoreNormal = rec.shoreNormalDeg != null ? rec.shoreNormalDeg : 262;
        var thetaIn = angDiff(rec.dirDeg != null ? rec.dirDeg : shoreNormal, shoreNormal) * Math.PI / 180;
        if (Math.abs(thetaIn) > 1.4) continue;

        var kIn = wavenumber(omega, a.depthM);
        var CgIn = groupSpeed(omega, kIn, a.depthM);
        var ky = kIn * Math.sin(thetaIn);
        var flux = rec.hsM * rec.hsM * CgIn * Math.cos(thetaIn);

        var k = wavenumber(omega, h);
        if (!k) continue;
        var kx2 = k * k - ky * ky;
        if (kx2 <= 0) continue;
        var cosT = Math.sqrt(kx2) / k;
        var Cg = groupSpeed(omega, k, h);
        var H = Math.sqrt(flux / (Cg * cosT));
        var Hmax = GAMMA * h;
        if (!broken && H >= Hmax) {
          broken = true;
          breakIx[iy] = ix;
          breakDepth[iy] = h;
          // Angle of the crest to shore normal where it breaks. Its SIGN is
          // which way the wave peels.
          breakAngle[iy] = Math.asin(Math.max(-1, Math.min(1, ky / k))) * 180 / Math.PI;
        }
        if (broken) { H = Math.min(H, Hmax); foam[idx] = 1; }
        else if (H > 0.72 * Hmax) {
          foam[idx] = (H / Hmax - 0.72) / 0.28 * 0.6;
          if (breakIx[iy] < 0) { breakIx[iy] = ix; breakDepth[iy] = h; breakAngle[iy] = Math.asin(Math.max(-1, Math.min(1, ky / k))) * 180 / Math.PI; }
        }
        amp[idx] = H / 2;
        faceFt[idx] = H * M_FT * FACE_FACTOR;
        // Phase accumulates shoreward; x decreases toward the beach.
        phase[idx] = -Math.sqrt(kx2) * x + ky * (lat - frame.s) * 111320;
        if (!phase[idx] && phase[idx] !== 0) phase[idx] = 0;
      }
    }
    return {
      nx: nx, ny: ny, depth: depth, amp: amp, phase: phase, foam: foam,
      faceFt: faceFt, land: land, anchors: anchors, tideM: tideM,
      breakIx: breakIx, breakDepth: breakDepth, breakAngle: breakAngle,
      cellH: cellH, cellW: cellW, frame: frame,
    };
  }

  /* ------------------------------------------------------- base map draw -- */

  var STYLE = {
    ocean: '#a9d3dd', oceanDeep: '#4d8fa3',
    sand: '#efe3c8', reserve: '#dfe8d4', water: '#bcd9e6',
    road: '#ffffff', roadCase: '#d8d2c4', major: '#fff3c4', majorCase: '#e3c96a',
    path: '#c8a978', parking: '#e8e2d2', parkingEdge: '#cdc5b0',
    label: '#4a4a44', labelHalo: 'rgba(255,255,255,.85)',
  };

  function drawBase(ctx, proj, features, W, H, shore) {
    ctx.save();
    ctx.fillStyle = STYLE.sand;
    ctx.fillRect(0, 0, W, H);

    // The sea: everything west of the coastline out to the frame edge.
    if (shore && shore.length > 1) {
      ctx.beginPath();
      ctx.moveTo(-5, proj.y(shore[0][1]) + 5000);
      ctx.lineTo(-5, proj.y(shore[0][1]));
      shore.forEach(function (p) { ctx.lineTo(proj.x(p[0]), proj.y(p[1])); });
      ctx.lineTo(-5, proj.y(shore[shore.length - 1][1]));
      ctx.lineTo(-5, proj.y(shore[shore.length - 1][1]) - 5000);
      ctx.closePath();
      ctx.fillStyle = STYLE.ocean;
      ctx.fill();
    }

    function path(f) {
      ctx.beginPath();
      f.line.forEach(function (p, i) {
        var x = proj.x(p[0]), y = proj.y(p[1]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
    }
    function poly(list, fill) {
      list.forEach(function (f) { path(f); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); });
    }
    var by = function (l) { return features.filter(function (f) { return f.layer === l && f.line; }); };

    poly(by('reserve'), STYLE.reserve);
    poly(by('water'), STYLE.water);

    // Parking areas, then their outline: this is the orientation anchor.
    by('parking').forEach(function (f) {
      path(f); ctx.closePath();
      ctx.fillStyle = STYLE.parking; ctx.fill();
      ctx.strokeStyle = STYLE.parkingEdge; ctx.lineWidth = 1; ctx.stroke();
    });

    // Roads: casing under fill, majors wider.
    [['case', 2.5], ['fill', 1.4]].forEach(function (pass) {
      by('road').forEach(function (f) {
        var major = ['primary', 'secondary', 'trunk', 'motorway', 'tertiary'].indexOf(f.kind) >= 0;
        ctx.lineWidth = (major ? pass[1] * 2.4 : pass[1]) ;
        ctx.strokeStyle = pass[0] === 'case'
          ? (major ? STYLE.majorCase : STYLE.roadCase)
          : (major ? STYLE.major : STYLE.road);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        path(f); ctx.stroke();
      });
    });

    // Foot access to the sand.
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = STYLE.path; ctx.lineWidth = 1.2;
    by('path').forEach(function (f) { path(f); ctx.stroke(); });
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawLabels(ctx, proj, features, mapFeatures) {
    ctx.save();
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    function label(text, x, y) {
      ctx.lineWidth = 3; ctx.strokeStyle = STYLE.labelHalo;
      ctx.strokeText(text, x, y); ctx.fillStyle = STYLE.label; ctx.fillText(text, x, y);
    }
    // The biggest parking polygon in frame is the north lot.
    var lots = features.filter(function (f) { return f.layer === 'parking' && f.line; });
    if (lots.length) {
      lots.sort(function (a, b) { return b.line.length - a.line.length; });
      var l = lots[0];
      var cx = 0, cy = 0;
      l.line.forEach(function (p) { cx += proj.x(p[0]); cy += proj.y(p[1]); });
      label('North lot', cx / l.line.length, cy / l.line.length);
    }
    var road = features.filter(function (f) { return f.name === 'North Torrey Pines Road' && f.line && f.line.length > 2; })[0];
    if (road) {
      var m = road.line[Math.floor(road.line.length / 2)];
      ctx.save();
      ctx.translate(proj.x(m[0]), proj.y(m[1])); ctx.rotate(-Math.PI / 2);
      ctx.font = '600 10px system-ui, sans-serif';
      label('N Torrey Pines Rd', 0, -4);
      ctx.restore();
    }
    ctx.restore();
  }

  window.TPSurfMap = {
    makeProjection: makeProjection,
    shorelineFrom: shorelineFrom,
    shoreGeometry: shoreGeometry,
    buildField: buildField,
    drawBase: drawBase,
    drawLabels: drawLabels,
    GRID: GRID,
    STYLE: STYLE,
    M_FT: M_FT,
  };
})();

/* ===================================================================== UI == */
(function () {
  'use strict';
  var API = window.TPSurfMap;
  var M_FT = API.M_FT;

  var LAYERS = [
    { id: 'waves', label: 'Waves', on: true, hint: 'Animated surface: swell refracting, standing up and breaking.' },
    { id: 'size', label: 'Size', on: true, hint: 'Breaking face height along the beach.' },
    { id: 'shape', label: 'Peaky / walled', on: false, hint: 'How much the size changes along the beach. Big changes make defined peaks; flat means it walls up and closes out.' },
    { id: 'peel', label: 'Peel & whitewater', on: true, hint: 'The breaking line, which way each section peels, and the broken water inside it.' },
    { id: 'trains', label: 'Swell trains', on: true, hint: 'Every swell in the water right now: size, period and the direction it is coming FROM, out in deep water.' },
    { id: 'depth', label: 'Bottom', on: false, hint: 'Modelled seafloor between the real shoreline and the real MOP depth contour.' },
    { id: 'best', label: 'Best spot', on: true, hint: 'The stretch scoring highest at this hour.' },
  ];

  /** Face-height ramp: one hue, light to dark, so it reads as magnitude. */
  var SIZE_RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  var RAMP_RGB = SIZE_RAMP.map(function (c) {
    return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  });
  /** Continuous, so the water shades smoothly instead of banding. */
  function sizeRgb(ft) {
    var u = Math.max(0, Math.min(RAMP_RGB.length - 1.001, (ft || 0) / 1.35));
    var i = Math.floor(u), f = u - i;
    var a = RAMP_RGB[i], b = RAMP_RGB[Math.min(RAMP_RGB.length - 1, i + 1)];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** Alongshore change in face height: what makes peaks rather than a wall. */
  function peakiness(lines, i) {
    var vals = [];
    for (var j = 0; j < lines.length; j++) {
      var f = lines[j].faceFt[i];
      if (f != null) vals.push({ lat: lines[j].lat, f: f });
    }
    if (vals.length < 3) return null;
    var grad = 0, n = 0;
    for (var k = 1; k < vals.length; k++) {
      var dm = Math.abs(vals[k].lat - vals[k - 1].lat) * 111320;
      if (dm < 10) continue;
      grad += Math.abs(vals[k].f - vals[k - 1].f) / dm * 100;   // ft per 100 m
      n++;
    }
    if (!n) return null;
    var g = grad / n;
    return {
      gradient: g,
      label: g > 0.55 ? 'Peaky - defined A-frames' : g > 0.22 ? 'Some shape' : 'Walled - closeout risk',
      key: g > 0.55 ? 'peaky' : g > 0.22 ? 'mixed' : 'walled',
    };
  }


  /**
   * Peel: which way the wave runs, and how fast the break travels along it.
   *
   * The crest angle at breaking carries the sign. This beach faces roughly
   * west, so a swell arriving from NORTH of shore normal breaks progressively
   * southward - the rider travels south, which facing the beach is a RIGHT. A
   * swell from south of shore normal peels north: a LEFT.
   *
   * Peel speed is the celerity at the break divided by the sine of the angle
   * between the crest and the breaking line. As that angle goes to zero the
   * whole wall stands up at once - a closeout.
   */
  function peelAt(field, iy) {
    var b = field.breakIx[iy];
    if (b < 0 || !isFinite(field.breakAngle[iy])) return null;
    var alongM = field.cellH * 111320;

    // Tilt of the breaking line, fitted by least squares over a window either
    // side. Taking two endpoints three rows apart was measuring quantisation
    // noise as much as bathymetry: rows are 6 m apart and the break point moves
    // in whole cells, so a single-cell step read as a 10-degree swing.
    var WIN = 8;
    var n = 0, sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (var j = -WIN; j <= WIN; j++) {
      var r = iy + j;
      if (r < 0 || r >= field.ny) continue;
      var bi = field.breakIx[r];
      if (bi < 0) continue;
      var xa = j * alongM;
      var yc = bi * field.cellW * 111320 * 0.84;
      n++; sx += xa; sy += yc; sxy += xa * yc; sxx += xa * xa;
    }
    var slope = 0;
    if (n >= 4) {
      var den = n * sxx - sx * sx;
      if (Math.abs(den) > 1e-6) slope = (n * sxy - sx * sy) / den;
    }
    var lineTilt = Math.atan(slope) * 180 / Math.PI;

    var crestAngle = field.breakAngle[iy];          // + = from north of normal
    // Angle between the crest and the breaking line.
    var alpha = Math.abs(crestAngle - lineTilt);
    if (alpha > 90) alpha = 180 - alpha;
    alpha = Math.max(0.6, alpha);

    var c = Math.sqrt(9.81 * Math.max(0.3, field.breakDepth[iy]));
    var speed = Math.min(60, c / Math.sin(alpha * Math.PI / 180));
    return {
      dir: crestAngle > 0.4 ? 'right' : crestAngle < -0.4 ? 'left' : 'both',
      alpha: alpha,
      speedMs: speed,
      quality: alpha < 4 ? 'closeout' : alpha < 11 ? 'fast' : alpha < 32 ? 'makeable' : 'slow',
      ix: b,
    };
  }


  // The fastest a surfer realistically travels along a wall, metres/second.
  // Past this the section outruns you, and the wave is a closeout however good
  // it looks from the beach.
  var MAX_RIDE_SPEED = 11;

  /**
   * Rideable sections: runs along the break where the peel stays slow enough to
   * make and the wave stays big enough to ride.
   *
   * Length is how far the section runs along the beach. Duration is that length
   * divided by the peel speed, because a surfer keeps pace with the pocket - so
   * a slower-peeling wave gives a longer ride over the same distance.
   */
  function rideSections(field) {
    var alongM = field.cellH * 111320;
    var runs = [], cur = null;
    for (var iy = 0; iy < field.ny; iy++) {
      var p = peelAt(field, iy);
      var b = field.breakIx[iy];
      var face = b >= 0 ? field.faceFt[iy * field.nx + b] : 0;
      var ok = p && p.speedMs <= MAX_RIDE_SPEED && face >= 1.2 && p.dir !== 'both';
      if (ok) {
        if (cur && cur.dir === p.dir) { cur.end = iy; cur.speeds.push(p.speedMs); cur.faces.push(face); }
        else { if (cur) runs.push(cur); cur = { dir: p.dir, start: iy, end: iy, speeds: [p.speedMs], faces: [face] }; }
      } else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);

    return runs.map(function (r) {
      var n = r.speeds.length;
      var meanSpeed = r.speeds.reduce(function (a, b) { return a + b; }, 0) / n;
      var meanFace = r.faces.reduce(function (a, b) { return a + b; }, 0) / n;
      var lengthM = (r.end - r.start + 1) * alongM;
      return {
        dir: r.dir, start: r.start, end: r.end, lengthM: lengthM,
        seconds: lengthM / Math.max(1.2, meanSpeed),
        speedMs: meanSpeed, faceFt: meanFace,
      };
    }).filter(function (r) { return r.lengthM >= 15; })
      .sort(function (a, b) { return b.lengthM - a.lengthM; });
  }

  /** The dominant peel across the frame, for the headline. */
  function peelSummary(field) {
    var lefts = 0, rights = 0, alphas = [], speeds = [];
    for (var iy = 0; iy < field.ny; iy += 2) {
      var p = peelAt(field, iy);
      if (!p) continue;
      if (p.dir === 'left') lefts++; else if (p.dir === 'right') rights++;
      alphas.push(p.alpha); speeds.push(p.speedMs);
    }
    if (!alphas.length) return null;
    alphas.sort(function (a, b) { return a - b; });
    var med = alphas[alphas.length >> 1];
    return {
      dir: lefts > rights * 1.3 ? 'Lefts' : rights > lefts * 1.3 ? 'Rights' : 'Both ways',
      alpha: med,
      quality: med < 4 ? 'closing out' : med < 11 ? 'fast' : med < 32 ? 'makeable' : 'slow and fat',
    };
  }

  // Exposed for inspection: the peel and ride maths are the easiest thing in
  // here to get quietly wrong, and eyeballing a canvas does not catch it.
  API.peelAt = peelAt;
  API.rideSections = rideSections;
  API.MAX_RIDE_SPEED = MAX_RIDE_SPEED;

  API.mount = function (host, opts) {
    var basemap = opts.basemap, nearshore = opts.nearshore, hourly = opts.hourly || [];
    host.innerHTML = '';
    if (!basemap || !basemap.features || !nearshore || !nearshore.lines || !nearshore.times) {
      host.appendChild(el('p', 'cap', 'Map data unavailable on this run.'));
      return null;
    }
    var shore = API.shorelineFrom(basemap.features);
    if (!shore || shore.length < 2) {
      host.appendChild(el('p', 'cap', 'No coastline geometry in the basemap.'));
      return null;
    }

    var idx = Math.max(0, Math.min(nearshore.times.length - 1, opts.startIndex || 0));
    // Never open on a frame with nothing in it: step forward to the first one
    // that actually carries a forecast.
    var homeLine = nearshore.lines.filter(function (l) { return l.id === nearshore.homeLine; })[0]
      || nearshore.lines[Math.floor(nearshore.lines.length / 2)];
    if (homeLine) {
      var probe = idx;
      while (probe < nearshore.times.length && homeLine.faceFt[probe] == null) probe++;
      if (probe < nearshore.times.length) idx = probe;
    }
    var on = {};
    LAYERS.forEach(function (l) { on[l.id] = l.on; });
    var playing = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var t = 0, raf = null, field = null, baseCache = null, proj = null, img = null;

    var wrap = el('div', 'map-wrap');
    var canvas = el('canvas', 'map-canvas');
    canvas.setAttribute('role', 'img');
    wrap.appendChild(canvas);
    var readout = el('div', 'map-readout');
    wrap.appendChild(readout);
    host.appendChild(wrap);

    var toggles = el('div', 'map-layers');
    LAYERS.forEach(function (l) {
      var lab = el('label', 'map-toggle');
      var box = document.createElement('input');
      box.type = 'checkbox'; box.checked = l.on; box.id = 'layer-' + l.id;
      box.addEventListener('change', function () { on[l.id] = box.checked; draw(); });
      lab.appendChild(box);
      lab.appendChild(el('span', null, l.label));
      lab.title = l.hint;
      toggles.appendChild(lab);
    });
    host.appendChild(toggles);

    var controls = el('div', 'sim-controls');
    var play = el('button', null, playing ? 'Pause' : 'Play');
    play.type = 'button';
    var slider = document.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = String(nearshore.times.length - 1);
    slider.value = String(idx); slider.className = 'sim-slider';
    slider.setAttribute('aria-label', 'Time');
    var stamp = el('span', 'sim-stamp');
    controls.appendChild(play); controls.appendChild(slider); controls.appendChild(stamp);
    host.appendChild(controls);

    function nearestShore(lat) {
      var sp = shore[0];
      for (var i = 1; i < shore.length; i++) {
        if (Math.abs(shore[i][1] - lat) < Math.abs(sp[1] - lat)) sp = shore[i];
      }
      return sp;
    }
    // Period ramp: one hue, short to long, so it reads as magnitude.
    var PERIOD_RAMP = ['#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
    function periodColor(T) {
      var i = Math.max(0, Math.min(PERIOD_RAMP.length - 1, Math.floor(((T || 0) - 6) / 3)));
      return PERIOD_RAMP[i];
    }

    var ctx = canvas.getContext('2d');
    var buf = document.createElement('canvas');
    buf.width = API.GRID.nx; buf.height = API.GRID.ny;
    var bctx = buf.getContext('2d');
    var baseLayer = document.createElement('canvas');

    function size() {
      var w = Math.max(280, host.clientWidth || 320);
      var frame = basemap.frame;
      var kx = Math.cos(((frame.n + frame.s) / 2) * Math.PI / 180);
      var aspect = (frame.n - frame.s) / ((frame.e - frame.w) * kx);
      var h = Math.round(Math.min(w * aspect, 640));
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      canvas.width = w; canvas.height = h;
      baseLayer.width = w; baseLayer.height = h;
      proj = API.makeProjection(frame, w, h);
      baseCache = null;
    }

    function hourAt(i) {
      var time = nearshore.times[i];
      return hourly.filter(function (h) { return h.time === time; })[0] || null;
    }

    function linesAt(i) {
      return nearshore.lines.map(function (l) {
        return {
          lat: l.lat, lon: l.lon, depthM: l.depthM, shoreNormalDeg: l.shoreNormalDeg,
          hsM: l.faceFt[i] != null ? l.faceFt[i] / M_FT / 0.74 / 1.0 : null,
          faceFt: l.faceFt[i], periodS: l.periodS[i], dirDeg: l.dirDeg[i], score: l.score[i],
        };
      });
    }

    function rebuild() {
      var h = hourAt(idx);
      // Rebuild the field from MOP values at this hour. hsM is recovered from
      // the shipped face height so the map and the forecast cannot disagree.
      var lines = nearshore.lines.map(function (l) {
        var face = l.faceFt[idx];
        return {
          lat: l.lat, lon: l.lon, depthM: l.depthM,
          shoreNormalDeg: l.shoreNormalDeg,
          periodS: l.periodS[idx], dirDeg: l.dirDeg[idx],
          hsM: face != null ? face / M_FT / 0.74 * 0.62 : null,
          faceFt: face, score: l.score[idx],
        };
      });
      field = API.buildField({ proj: proj, frame: basemap.frame, shore: shore },
        lines, h ? h.tideFt : 2,
        { crestM: 95, heightM: 1.0, widthM: 38, ripSpacingM: 185, floor: 0.55, meanderM: 20 });
      img = bctx.createImageData(API.GRID.nx, API.GRID.ny);

      var when = new Date(nearshore.times[idx]).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit',
      });
      var pk = peakiness(nearshore.lines, idx);
      API.lastField = field;      // inspection hook
      var pe = peelSummary(field);
      var bestRide = rideSections(field)[0];
      stamp.textContent = when
        + (h ? '  ·  tide ' + h.tideFt.toFixed(1) + ' ft  ·  wind ' + Math.round(h.windKt) + ' kt ' + h.windCompass : '')
        + (bestRide
          ? '  ·  best ride ' + bestRide.dir + ' ' + Math.round(bestRide.lengthM)
            + ' m, ' + bestRide.seconds.toFixed(0) + 's'
          : '  ·  nothing rideable')
        + (pe ? '  ·  ' + pe.quality : '')
        + (pk ? '  ·  ' + pk.label : '');
      canvas.setAttribute('aria-label', 'Modelled surf map for ' + when
        + (pk ? '. ' + pk.label : '') + '.');
      draw();
    }

    function paintWater() {
      var d = img.data, nx = field.nx, ny = field.ny;
      for (var i = 0; i < nx * ny; i++) {
        var p = i * 4;
        if (field.land[i]) { d[p + 3] = 0; continue; }
        var h = field.depth[i];
        var shallow = Math.max(0, Math.min(1, 1 - h / 8));
        var r = 77 + (169 - 77) * shallow * shallow;
        var g = 143 + (211 - 143) * shallow * shallow;
        var b = 163 + (221 - 163) * shallow * shallow;

        if (on.depth) {
          // Contour banding every metre, so the bottom reads as a bottom.
          var band = Math.abs((h % 1) - 0.5);
          if (band > 0.44) { r *= 0.82; g *= 0.82; b *= 0.86; }
        }
        if (on.size && field.faceFt[i] > 0.3) {
          var c = sizeRgb(field.faceFt[i]);
          r = r * 0.45 + c[0] * 0.55; g = g * 0.45 + c[1] * 0.55; b = b * 0.45 + c[2] * 0.55;
        }
        if (on.waves && field.amp[i] > 0) {
          var left = i % nx > 0 ? field.amp[i - 1] * Math.cos(field.phase[i - 1] - t * 1.1) : 0;
          var eta = field.amp[i] * Math.cos(field.phase[i] - t * 1.1);
          // Waves run shoreward, so the slope that catches light is across x.
          var standUp = Math.max(0, Math.min(1, (4.5 - h) / 4));
          var lit = Math.max(-0.5, Math.min(0.85, (eta - left) * (0.9 + 2.6 * standUp) + eta * 0.05 * standUp));
          r += lit * 70; g += lit * 78; b += lit * 70;
          if (field.foam[i]) {
            var w = Math.min(1, field.foam[i] * (0.45 + 0.85 * Math.max(0, eta / (field.amp[i] + 1e-6))));
            r += (250 - r) * w; g += (252 - g) * w; b += (252 - b) * w;
          }
        }
        d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 235;
      }
    }

    function drawOverlays() {
      var lines = nearshore.lines;
      var hour = hourAt(idx);

      // ---- the breaking line, and which way each section peels -------------
      if (on.peel && field) {
        ctx.save();
        var pts = [];
        for (var iy = 0; iy < field.ny; iy++) {
          var b = field.breakIx[iy];
          if (b < 0) continue;
          pts.push({
            iy: iy,
            x: proj.rect.x + (b + 0.5) / field.nx * proj.rect.w,
            y: proj.rect.y + (iy + 0.5) / field.ny * proj.rect.h,
          });
        }
        if (pts.length > 2) {
          // The whitewater edge.
          ctx.beginPath();
          pts.forEach(function (p, i) { i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
          ctx.strokeStyle = 'rgba(255,255,255,.95)';
          ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
          ctx.stroke();
          ctx.strokeStyle = 'rgba(18,60,80,.35)'; ctx.lineWidth = 1; ctx.stroke();

          // Rideable sections: the stretches you could actually make.
          var rides = rideSections(field);
          var byRow = {};
          pts.forEach(function (p) { byRow[p.iy] = p; });
          rides.slice(0, 4).forEach(function (rd, ri) {
            var seg = [];
            for (var q = rd.start; q <= rd.end; q++) if (byRow[q]) seg.push(byRow[q]);
            if (seg.length < 2) return;
            ctx.beginPath();
            seg.forEach(function (p, i) { i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
            ctx.strokeStyle = ri === 0 ? 'rgba(28,111,63,.95)' : 'rgba(28,111,63,.5)';
            ctx.lineWidth = ri === 0 ? 7 : 5;
            ctx.lineCap = 'round';
            ctx.stroke();

            var mid = seg[seg.length >> 1];
            ctx.font = '700 11px system-ui, sans-serif';
            ctx.textAlign = 'left';
            var tag = (rd.dir === 'right' ? 'RIGHT' : 'LEFT') + '  '
              + Math.round(rd.lengthM) + ' m · ' + rd.seconds.toFixed(0) + 's';
            ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(255,255,255,.95)';
            ctx.strokeText(tag, mid.x + 12, mid.y + 4);
            ctx.fillStyle = '#14301f'; ctx.fillText(tag, mid.x + 12, mid.y + 4);
          });

          // Peel arrows along it: direction the break runs.
          var step = Math.max(6, Math.round(pts.length / 9));
          for (var pi = step; pi < pts.length - step; pi += step) {
            var p = pts[pi];
            var peel = peelAt(field, p.iy);
            if (!peel || peel.dir === 'both') continue;
            // On screen, north is up; a right peels south (down the canvas).
            var down = peel.dir === 'right';
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(down ? 0 : Math.PI);
            ctx.beginPath();
            ctx.moveTo(0, -2); ctx.lineTo(0, 16); ctx.lineTo(-4, 10);
            ctx.moveTo(0, 16); ctx.lineTo(4, 10);
            ctx.strokeStyle = peel.quality === 'closeout' ? '#d03b3b'
              : peel.quality === 'fast' ? '#fab219' : '#1c6f3f';
            ctx.lineWidth = 2.4; ctx.lineCap = 'round';
            ctx.stroke();
            ctx.restore();

            ctx.font = '700 10px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.92)';
            var tag = down ? 'R' : 'L';
            ctx.strokeText(tag, p.x, p.y - 7); ctx.fillStyle = '#12303f';
            ctx.fillText(tag, p.x, p.y - 7);
          }
        }
        ctx.restore();
      }

      // ---- deep-water swell trains ----------------------------------------
      if (on.trains && hour && hour.trains && hour.trains.length) {
        ctx.save();
        var ox = canvas.width * 0.16;
        var oy0 = canvas.height * 0.18;
        hour.trains.slice(0, 4).forEach(function (tr, ti) {
          var y = oy0 + ti * 64;
          var len = 16 + Math.min(26, tr.hsFt * 6);
          ctx.save();
          ctx.translate(ox, y);
          // Canvas rotate(t) sends local (0,1) to (-sin t, cos t), and on
          // screen +y is south. Rotating by dirDeg therefore points the arrow
          // along dirDeg + 180 - the way the swell TRAVELS. Rotating by
          // dirDeg + 180 pointed it back at where the swell came from.
          ctx.rotate(tr.dirDeg * Math.PI / 180);
          ctx.beginPath();
          ctx.moveTo(0, -len); ctx.lineTo(0, len * 0.5);
          ctx.moveTo(0, len * 0.5); ctx.lineTo(-7, len * 0.5 - 9);
          ctx.moveTo(0, len * 0.5); ctx.lineTo(7, len * 0.5 - 9);
          ctx.strokeStyle = periodColor(tr.periodS);
          ctx.lineWidth = tr.kind === 'wind sea' ? 2 : 3.4;
          ctx.lineCap = 'round';
          ctx.stroke();
          ctx.restore();

          ctx.font = '600 11px system-ui, sans-serif';
          ctx.textAlign = 'left';
          var txt = tr.hsFt.toFixed(1) + ' ft \u00b7 ' + tr.periodS.toFixed(0) + 's \u00b7 ' + tr.dirCompass;
          ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(255,255,255,.92)';
          ctx.strokeText(txt, ox + 28, y + 4); ctx.fillStyle = '#12303f';
          ctx.fillText(txt, ox + 28, y + 4);
          ctx.font = '500 9.5px system-ui, sans-serif';
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.9)';
          ctx.strokeText(tr.kind, ox + 28, y + 16); ctx.fillStyle = '#5a6b74';
          ctx.fillText(tr.kind, ox + 28, y + 16);
        });
        ctx.restore();
      }

      // ---- peaky / walled ribbon ------------------------------------------
      if (on.shape) {
        ctx.save();
        ctx.lineWidth = 6; ctx.lineCap = 'round';
        for (var i = 1; i < lines.length; i++) {
          var a = lines[i - 1], b2 = lines[i];
          if (a.faceFt[idx] == null || b2.faceFt[idx] == null) continue;
          var dm = Math.abs(b2.lat - a.lat) * 111320 || 1;
          var g = Math.abs(b2.faceFt[idx] - a.faceFt[idx]) / dm * 100;
          ctx.strokeStyle = g > 0.55 ? 'rgba(28,111,63,.85)' : g > 0.22 ? 'rgba(250,178,25,.85)' : 'rgba(208,59,59,.8)';
          var sa = nearestShore(a.lat), sb = nearestShore(b2.lat);
          ctx.beginPath();
          ctx.moveTo(proj.x(sa[0] - 0.0007), proj.y(sa[1]));
          ctx.lineTo(proj.x(sb[0] - 0.0007), proj.y(sb[1]));
          ctx.stroke();
        }
        ctx.restore();
      }

      // ---- best stretch ----------------------------------------------------
      if (on.best && nearshore.best && nearshore.best[idx]) {
        var bst = nearshore.best[idx];
        var onShore = nearestShore(bst.lat);
        var bx = proj.x(onShore[0] - 0.0012), by = proj.y(onShore[1]);
        ctx.save();
        ctx.beginPath(); ctx.arc(bx, by, 11, 0, Math.PI * 2);
        ctx.strokeStyle = '#1c6f3f'; ctx.lineWidth = 3; ctx.stroke();
        ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#1c6f3f'; ctx.fill();
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.9)';
        var txt2 = 'Best here \u00b7 ' + bst.score;
        ctx.strokeText(txt2, bx + 15, by + 4); ctx.fillStyle = '#14301f';
        ctx.fillText(txt2, bx + 15, by + 4);
        ctx.restore();
      }
    }

    function draw() {
      if (!field || !proj) return;
      if (!baseCache) {
        var b = baseLayer.getContext('2d');
        b.clearRect(0, 0, baseLayer.width, baseLayer.height);
        API.drawBase(b, proj, basemap.features, baseLayer.width, baseLayer.height, shore);
        baseCache = true;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(baseLayer, 0, 0);
      paintWater();
      bctx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      var R = proj.rect;
      ctx.drawImage(buf, R.x, R.y, R.w, R.h);
      API.drawLabels(ctx, proj, basemap.features);
      drawOverlays();
    }

    function loop() {
      if (!playing) { raf = null; return; }
      t += 0.16; draw(); raf = requestAnimationFrame(loop);
    }
    function start() { if (!raf && playing) raf = requestAnimationFrame(loop); }

    play.addEventListener('click', function () {
      playing = !playing; play.textContent = playing ? 'Pause' : 'Play';
      if (playing) start(); else if (raf) { cancelAnimationFrame(raf); raf = null; }
    });
    slider.addEventListener('input', function () { idx = Number(slider.value); rebuild(); });

    // Hover readout: the numbers at the point under the cursor.
    canvas.addEventListener('mousemove', function (ev) {
      if (!field || !proj) return;
      var box = canvas.getBoundingClientRect();
      var px = ev.clientX - box.left, py = ev.clientY - box.top;
      var R = proj.rect;
      var gx = Math.floor((px - R.x) / R.w * field.nx);
      var gy = Math.floor((py - R.y) / R.h * field.ny);
      if (gx < 0 || gy < 0 || gx >= field.nx || gy >= field.ny) { readout.style.opacity = 0; return; }
      var i = gy * field.nx + gx;
      if (field.land[i]) { readout.style.opacity = 0; return; }
      var lat = proj.lat(py);
      var near = nearshore.lines.reduce(function (a, b) {
        return Math.abs(b.lat - lat) < Math.abs(a.lat - lat) ? b : a;
      });
      readout.innerHTML = '<b>' + (field.faceFt[i] > 0.3 ? field.faceFt[i].toFixed(1) + ' ft face' : 'outside the break') + '</b>'
        + '<span>depth ' + field.depth[i].toFixed(1) + ' m</span>'
        + (function () {
          var pr = peelAt(field, gy);
          if (!pr) return '<span>not breaking here</span>';
          return '<span>peels ' + (pr.dir === 'both' ? 'both ways' : pr.dir)
            + ' at ' + pr.speedMs.toFixed(0) + ' m/s</span>'
            + '<span>' + (pr.speedMs <= MAX_RIDE_SPEED ? 'makeable' : 'outruns you, closeout') + '</span>';
        })()
        + '<span>' + near.id + ' · ' + (near.periodS[idx] || '--') + 's · score '
        + (near.score[idx] != null ? near.score[idx] : '--') + '</span>';
      readout.style.opacity = 1;
      readout.style.left = Math.min(px + 14, canvas.width - 170) + 'px';
      readout.style.top = Math.max(6, py - 66) + 'px';
    });
    canvas.addEventListener('mouseleave', function () { readout.style.opacity = 0; });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (e.isIntersecting) start();
          else if (raf) { cancelAnimationFrame(raf); raf = null; }
        });
      }, { threshold: 0.05 }).observe(canvas);
    }

    size(); rebuild(); start();
    return {
      resize: function () { size(); rebuild(); },
      destroy: function () { if (raf) cancelAnimationFrame(raf); raf = null; playing = false; },
    };
  };
})();
