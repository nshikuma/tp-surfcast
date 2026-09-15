/* Torrey Pines north lot - nearshore wave simulation.
 *
 * WHAT THIS IS
 * A phase-resolving plan view of the surf zone. Deep-water swell from the
 * forecast is propagated shoreward over a model seafloor using linear wave
 * theory: the dispersion relation sets the local wavelength, alongshore
 * wavenumber conservation bends the crests (refraction), wave-action
 * conservation sets the height, and a depth-limited criterion breaks them.
 * The same equations the forecast already uses, solved on a 2-D grid instead
 * of a single profile.
 *
 * WHAT THIS IS NOT
 * A camera, and not a survey. The seafloor is PARAMETERISED from what is known
 * about this beach - an equilibrium profile, a shore-parallel bar, rip channels
 * at realistic spacing - not measured. So trust the behaviour (where it peaks,
 * where it closes out, how the tide changes it) rather than the exact position
 * of any one sandbar.
 *
 * Deliberately a plain script, not a module: the preview build inlines it.
 */
(function () {
  'use strict';

  var G = 9.81;
  var M_PER_FT = 0.3048;

  /* ------------------------------------------------------------- domain -- */
  // Shore-aligned frame. Canvas x runs ALONGSHORE (wide axis), canvas y runs
  // CROSS-SHORE with deep water at the top and the sand at the bottom, which is
  // how every surfer already reads a spot map.
  var DOMAIN = {
    alongM: 1000,     // metres of beach shown
    crossM: 620,      // metres from the outer boundary to the back of the beach
    beachM: 70,       // metres of dry sand at the bottom
    nx: 240,          // grid columns (alongshore)
    ny: 150,          // grid rows (cross-shore)
  };

  var BEACH = {
    // Dean equilibrium profile h = A * x^(2/3). A ~ 0.11 for the medium sand
    // here, which puts the 8 m contour about 600 m out - the right order for
    // this stretch of coast.
    deanA: 0.11,
    barCrestM: 95,     // mean distance offshore of the bar crest
    barHeightM: 1.05,  // how far the bar rises above the equilibrium profile
    barWidthM: 38,
    ripSpacingM: 185,  // alongshore wavelength of the rip channels
    ripDepthFrac: 0.55,// how much of the bar survives in a channel (0 = fully cut)
    barMeanderM: 20,   // how much the bar crest wanders alongshore
    shoreNormalDeg: 265,
  };

  var GAMMA = 0.78;    // breaking index, H/h

  /* --------------------------------------------------------- wave theory -- */

  // Solve w^2 = g k tanh(k h) for k, seeded with the Fenton & McKee approximation.
  function wavenumber(omega, h) {
    if (!(h > 0.05)) return null;
    var k0 = omega * omega / G;
    var k = k0 / Math.sqrt(Math.tanh(k0 * h));
    for (var i = 0; i < 12; i++) {
      var th = Math.tanh(k * h);
      var f = G * k * th - omega * omega;
      var df = G * th + G * k * h * (1 - th * th);
      var next = k - f / df;
      if (!isFinite(next) || next <= 0) break;
      if (Math.abs(next - k) < 1e-9) { k = next; break; }
      k = next;
    }
    return k;
  }

  function groupSpeed(omega, k, h) {
    var kh2 = 2 * k * h;
    var n = kh2 > 50 ? 0.5 : 0.5 * (1 + kh2 / Math.sinh(kh2));
    return n * omega / k;
  }

  /* -------------------------------------------------------- bathymetry --- */

  /** Still-water depth in metres at (alongshore a, distance offshore xs). */
  function depthAt(a, xs, tideM) {
    if (xs <= 0) return -(0 - xs) * 0.08 - 0.05;          // dry beach, sloping up
    var h = BEACH.deanA * Math.pow(xs, 2 / 3);
    // Shore-parallel bar, meandering alongshore, cut by rip channels.
    var phase = (2 * Math.PI * a) / BEACH.ripSpacingM;
    var crest = BEACH.barCrestM + BEACH.barMeanderM * Math.sin(phase);
    var strength = BEACH.ripDepthFrac + (1 - BEACH.ripDepthFrac) * (0.5 + 0.5 * Math.cos(phase));
    var d = (xs - crest) / BEACH.barWidthM;
    h -= BEACH.barHeightM * strength * Math.exp(-d * d);
    // A gentle trough just inside the bar, where the water runs alongshore.
    var dt = (xs - (crest - BEACH.barWidthM * 1.5)) / (BEACH.barWidthM * 0.9);
    h += 0.35 * strength * Math.exp(-dt * dt);
    return h + tideM;
  }

  /* ------------------------------------------------------------- field --- */

  /**
   * Precompute the wave field for one set of conditions. Everything expensive
   * happens here; the animation loop only evaluates a cosine per cell.
   */
  function buildField(cond) {
    var nx = DOMAIN.nx, ny = DOMAIN.ny;
    var dxA = DOMAIN.alongM / nx;
    var dyC = DOMAIN.crossM / ny;
    var tideM = (cond.tideFt || 0) * M_PER_FT;

    var depth = new Float32Array(nx * ny);
    var amp = new Float32Array(nx * ny);
    var phase = new Float32Array(nx * ny);
    var foam = new Float32Array(nx * ny);

    var trains = cond.trains.filter(function (t) { return t.hsM > 0.03 && t.periodS > 1; });
    if (!trains.length) trains = [{ hsM: 0.05, periodS: 8, dirDeg: BEACH.shoreNormalDeg }];

    var fields = trains.map(function (t) {
      return {
        omega: 2 * Math.PI / t.periodS,
        hs: t.hsM,
        theta0: ((t.dirDeg - BEACH.shoreNormalDeg + 540) % 360 - 180) * Math.PI / 180,
        periodS: t.periodS,
        amp: new Float32Array(nx * ny),
        phase: new Float32Array(nx * ny),
      };
    });

    for (var f = 0; f < fields.length; f++) {
      var F = fields[f];
      // Beyond ~80 degrees off shore-normal nothing meaningful arrives.
      if (Math.abs(F.theta0) > 1.4) continue;
      var k0 = F.omega * F.omega / G;
      var ky = k0 * Math.sin(F.theta0);          // conserved alongshore wavenumber
      var Cg0 = 0.5 * F.omega / k0;

      for (var ix = 0; ix < nx; ix++) {
        var a = ix * dxA;
        var acc = 0;          // accumulated cross-shore phase
        var broken = false;
        for (var iy = 0; iy < ny; iy++) {
          var idx = iy * nx + ix;
          // Row 0 is the outer boundary; xs decreases shoreward.
          var xs = DOMAIN.crossM - DOMAIN.beachM - iy * dyC;
          var h = depthAt(a, xs, tideM);
          depth[idx] = h;
          if (!(h > 0.12)) { F.amp[idx] = 0; F.phase[idx] = acc; continue; }

          var k = wavenumber(F.omega, h);
          if (!k) { F.amp[idx] = 0; continue; }
          var kx2 = k * k - ky * ky;
          if (kx2 <= 1e-9) { F.amp[idx] = 0; continue; }  // turned fully alongshore
          var kx = Math.sqrt(kx2);
          var cosT = kx / k;

          acc += kx * dyC;
          F.phase[idx] = acc;

          var Cg = groupSpeed(F.omega, k, h);
          // Wave action: H^2 * Cg * cos(theta) is conserved along a ray.
          var H = F.hs * Math.sqrt((Cg0 * Math.cos(F.theta0)) / (Cg * cosT));
          var Hmax = GAMMA * h;
          if (H >= Hmax || broken) {
            broken = h < Hmax / GAMMA * 1.3;   // stays broken through the surf zone
            H = Math.min(H, Hmax);
            foam[idx] = Math.max(foam[idx], Math.min(1, (F.hs / (cond.hsTotal || F.hs)) * 1));
          }
          F.amp[idx] = H / 2;   // amplitude, not height
        }
      }
    }

    for (var i = 0; i < nx * ny; i++) {
      var s = 0;
      for (var j = 0; j < fields.length; j++) s += fields[j].amp[i] * fields[j].amp[i];
      amp[i] = Math.sqrt(s);
    }

    // Onshore wind textures the surface; offshore wind grooms it. Shore normal
    // is 265, so the offshore quarter is centred on 085.
    var offBearing = (BEACH.shoreNormalDeg + 180) % 360;
    var dw = ((cond.windDirDeg - offBearing + 540) % 360 - 180) * Math.PI / 180;
    var onshoreKt = -(cond.windKt || 0) * Math.cos(dw);
    var chop = Math.max(0, Math.min(0.05, onshoreKt * 0.004));

    return {
      nx: nx, ny: ny, dxA: dxA, dyC: dyC,
      depth: depth, amp: amp, foam: foam, fields: fields,
      tideM: tideM, cond: cond, chop: chop,
    };
  }

  /* ------------------------------------------------------------ render --- */

  var SEA_DEEP = [16, 52, 74];
  var SEA_SHALLOW = [94, 186, 196];
  var SAND = [214, 200, 176];
  var SAND_WET = [176, 164, 146];

  function lerp3(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  function paint(field, img, t) {
    var nx = field.nx, ny = field.ny, d = img.data;
    var fields = field.fields;
    // Wave groups: real swell arrives in sets, and seeing them roll through is
    // most of what makes a lineup readable.
    var groupPhase = t * 0.22;

    for (var iy = 0; iy < ny; iy++) {
      for (var ix = 0; ix < nx; ix++) {
        var idx = iy * nx + ix;
        var p = idx * 4;
        var h = field.depth[idx];

        if (h <= 0.05) {                       // dry sand
          var wetness = Math.max(0, Math.min(1, (0.05 - h) / 1.2));
          var c = lerp3(SAND_WET, SAND, wetness);
          d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255;
          continue;
        }

        // Surface elevation from every swell train present.
        var eta = 0, etaUp = 0;
        for (var j = 0; j < fields.length; j++) {
          var F = fields[j];
          var A = F.amp[idx];
          if (!A) continue;
          var grp = 0.68 + 0.42 * Math.cos(F.phase[idx] / 7 - groupPhase - j * 1.7);
          eta += A * grp * Math.cos(F.phase[idx] - F.omega * t);
          var up = iy > 0 ? F.amp[idx - nx] * grp * Math.cos(F.phase[idx - nx] - F.omega * t) : 0;
          etaUp += up;
        }

        // Depth shading, then lit by the cross-shore slope of the surface so
        // crests catch light and troughs fall away.
        var shade = Math.max(0, Math.min(1, 1 - h / 7.5));
        var base = lerp3(SEA_DEEP, SEA_SHALLOW, shade * shade);
        // Steepness does the lighting. Out the back a swell is a long low
        // undulation you can barely see; over the bar the same wave stands up
        // and throws a hard shadow. Lighting on elevation alone made the
        // outside read as a barcode.
        // True surface slope in metres per metre. The earlier gain saturated
        // offshore and painted the deep water as hard stripes; a long-period
        // swell in 8 m of water really is almost flat to look at.
        var steep = (eta - etaUp) / field.dyC * 11;
        var standUp = Math.max(0, Math.min(1, (4.2 - h) / 3.6));
        var lit = Math.max(-0.5, Math.min(0.8, steep * (0.6 + 0.85 * standUp) + eta * 0.06 * standUp));
        // Wind texture: onshore wind ruffles the surface, offshore leaves it glassy.
        lit += field.chop * (Math.sin(ix * 2.7 + iy * 1.9 + t * 5.5) + Math.sin(ix * 1.3 - iy * 3.1 - t * 4.1)) * 0.5;

        var r = base[0] + lit * 70;
        var g = base[1] + lit * 80;
        var b = base[2] + lit * 70;

        // Whitewater: foam rides the front face of a breaking wave and washes
        // shoreward, so weight it by the surface being up and pitching.
        var fo = field.foam[idx];
        if (fo > 0) {
          var crest = Math.max(0, eta / (field.amp[idx] + 1e-6));
          var w = Math.min(1, fo * (0.35 + 0.75 * crest));
          r += (250 - r) * w; g += (252 - g) * w; b += (252 - b) * w;
        }

        d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
      }
    }
  }

  /* ----------------------------------------------------- cross-section --- */

  function drawProfile(ctx, W, H, field, t) {
    var cond = field.cond;
    ctx.clearRect(0, 0, W, H);
    var css = getComputedStyle(document.body);
    var ink = css.getPropertyValue('--text-secondary') || '#555';
    var grid = css.getPropertyValue('--grid') || '#ddd';

    // Take the alongshore slice through the middle of the domain.
    var ixMid = Math.floor(field.nx / 2);
    var maxDepth = 7;
    var yFor = function (h) { return 18 + (h / maxDepth) * (H - 46); };
    var xFor = function (iy) { return (iy / (field.ny - 1)) * W; };

    // Seabed.
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (var iy = 0; iy < field.ny; iy++) {
      var h = field.depth[iy * field.nx + ixMid] - field.tideM;
      ctx.lineTo(xFor(iy), yFor(h));
    }
    ctx.lineTo(W, H); ctx.closePath();
    ctx.fillStyle = 'rgba(190,175,150,.55)'; ctx.fill();

    // Water body, so the section reads as a beach rather than a line graph.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, yFor(-field.tideM));
    for (var iw = 0; iw < field.ny; iw++) {
      ctx.lineTo(xFor(iw), yFor(field.depth[iw * field.nx + ixMid] - field.tideM));
    }
    ctx.lineTo(W, yFor(-field.tideM)); ctx.closePath();
    ctx.fillStyle = 'rgba(46,130,160,.20)'; ctx.fill();
    ctx.restore();

    // Still-water line at the current tide.
    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, yFor(-field.tideM)); ctx.lineTo(W, yFor(-field.tideM)); ctx.stroke();

    // Water surface with the wave riding on it.
    ctx.beginPath();
    for (var iy2 = 0; iy2 < field.ny; iy2++) {
      var idx = iy2 * field.nx + ixMid;
      var eta = 0;
      for (var j = 0; j < field.fields.length; j++) {
        var F = field.fields[j];
        var grp = 0.68 + 0.42 * Math.cos(F.phase[idx] / 7 - t * 0.22 - j * 1.7);
        eta += F.amp[idx] * grp * Math.cos(F.phase[idx] - F.omega * t);
      }
      // Wave faces steepen as they shoal: skew the crest shoreward.
      var y = yFor(-field.tideM - eta * 2.6);
      if (iy2 === 0) ctx.moveTo(xFor(iy2), y); else ctx.lineTo(xFor(iy2), y);
    }
    ctx.strokeStyle = css.getPropertyValue('--swell') || '#2a78d6';
    ctx.lineWidth = 2; ctx.stroke();

    ctx.fillStyle = ink; ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('outside', 4, 12);
    ctx.textAlign = 'right'; ctx.fillText('sand', W - 4, 12); ctx.textAlign = 'left';
  }

  /* -------------------------------------------------------------- mount -- */

  function conditionsFrom(hour) {
    var trains = [];
    if (hour.partitions && hour.partitions.length) {
      hour.partitions.forEach(function (p) {
        if (p.hsM > 0.03 && p.periodS > 1) {
          trains.push({ hsM: p.hsM, periodS: p.periodS, dirDeg: p.dirDeg });
        }
      });
    }
    if (!trains.length) {
      trains.push({ hsM: hour.deepHsM, periodS: hour.periodS, dirDeg: hour.dirDeg });
    }
    return {
      trains: trains,
      hsTotal: hour.deepHsM,
      tideFt: hour.tideFt,
      windKt: hour.windKt,
      windDirDeg: hour.windDirDeg,
      hour: hour,
    };
  }

  function mount(host, hours, startIndex) {
    host.innerHTML = '';
    if (!hours || !hours.length) return;

    var idx = Math.max(0, Math.min(hours.length - 1, startIndex || 0));
    var field = null, img = null, raf = null, t = 0, playing = true;
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) playing = false;

    var wrap = document.createElement('div');
    wrap.className = 'sim-wrap';
    var canvas = document.createElement('canvas');
    canvas.className = 'sim-canvas';
    canvas.setAttribute('role', 'img');
    wrap.appendChild(canvas);

    var overlay = document.createElement('div');
    overlay.className = 'sim-overlay';
    wrap.appendChild(overlay);
    host.appendChild(wrap);

    var profile = document.createElement('canvas');
    profile.className = 'sim-profile';
    host.appendChild(profile);
    var profCap = document.createElement('p');
    profCap.className = 'cap';
    profCap.textContent = 'Side view through the middle of the frame — the bar, the trough behind it, and the wave shoaling over them.';
    host.appendChild(profCap);

    var controls = document.createElement('div');
    controls.className = 'sim-controls';
    var play = document.createElement('button');
    play.type = 'button';
    play.textContent = playing ? 'Pause' : 'Play';
    var slider = document.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = String(hours.length - 1);
    slider.value = String(idx); slider.className = 'sim-slider';
    slider.setAttribute('aria-label', 'Hour of day');
    var stamp = document.createElement('span');
    stamp.className = 'sim-stamp';
    controls.appendChild(play);
    controls.appendChild(slider);
    controls.appendChild(stamp);
    host.appendChild(controls);

    var ctx = canvas.getContext('2d');
    var pctx = profile.getContext('2d');

    function sizeCanvas() {
      var w = Math.max(280, host.clientWidth || 320);
      var h = Math.round(w * (DOMAIN.crossM / DOMAIN.alongM));
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      canvas.width = w; canvas.height = h;
      profile.style.width = w + 'px'; profile.style.height = '108px';
      profile.width = Math.round(w * dpr); profile.height = Math.round(108 * dpr);
      pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function rebuild() {
      var hour = hours[idx];
      field = buildField(conditionsFrom(hour));
      img = ctx.createImageData(DOMAIN.nx, DOMAIN.ny);
      var lbl = new Date(hour.time).toLocaleTimeString('en-US', {
        timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit',
      });
      stamp.textContent = lbl + '  ·  ' + hour.faceFt.toFixed(1) + ' ft '
        + hour.dirCompass + ' ' + hour.periodS.toFixed(0) + 's  ·  tide '
        + hour.tideFt.toFixed(1) + ' ft  ·  wind ' + Math.round(hour.windKt) + ' kt';
      canvas.setAttribute('aria-label',
        'Simulated surf at ' + lbl + ': ' + hour.sizeLabel + ', ' + hour.dirCompass
        + ' swell at ' + hour.periodS.toFixed(0) + ' seconds, tide ' + hour.tideFt.toFixed(1) + ' feet.');
      overlay.innerHTML = ''
        + '<span class="sim-tag sim-north">N &uarr;</span>'
        + '<span class="sim-tag sim-lot">North lot</span>'
        + '<span class="sim-tag sim-out">&larr; outside</span>'
        + '<span class="sim-scale"><i></i>200 m</span>';
      draw();
    }

    var buf = document.createElement('canvas');
    buf.width = DOMAIN.nx; buf.height = DOMAIN.ny;
    var bctx = buf.getContext('2d');

    function draw() {
      if (!field) return;
      paint(field, img, t);
      bctx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(buf, 0, 0, canvas.width, canvas.height);
      drawProfile(pctx, canvas.width, 108, field, t);
    }

    function loop() {
      if (!playing) { raf = null; return; }
      t += 1 / 30;
      draw();
      raf = requestAnimationFrame(loop);
    }
    function start() { if (!raf && playing) raf = requestAnimationFrame(loop); }

    play.addEventListener('click', function () {
      playing = !playing;
      play.textContent = playing ? 'Pause' : 'Play';
      if (playing) start(); else if (raf) { cancelAnimationFrame(raf); raf = null; }
    });
    slider.addEventListener('input', function () {
      idx = Number(slider.value);
      rebuild();
    });

    // Only animate while the panel is actually on screen.
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) start();
          else if (raf) { cancelAnimationFrame(raf); raf = null; }
        });
      }, { threshold: 0.05 }).observe(canvas);
    }

    sizeCanvas();
    rebuild();
    start();

    return {
      resize: function () { sizeCanvas(); draw(); },
      destroy: function () { if (raf) cancelAnimationFrame(raf); raf = null; playing = false; },
    };
  }

  window.TPWaveSim = { mount: mount, DOMAIN: DOMAIN, BEACH: BEACH };
})();
