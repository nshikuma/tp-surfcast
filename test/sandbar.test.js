/**
 * The satellite record, checked on made-up beaches.
 *
 * The readings that matter here are medians and scatter, and both have failure
 * modes that look fine in a table: one transect cutting a rivermouth channel
 * drags a mean but not a median, and a bar that is simply oblique to the
 * coastline looks rhythmic unless the trend is taken out first. Both are built
 * here on purpose.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { summariseScene, accumulate, summarise, RHYTHMIC_SPREAD_M, MAX_DETAILED } from '../src/model/sandbar.js';

/** A beach: bar at a given distance, with optional rhythm and obliquity. */
const scene = ({ id = 's1', time = '2026-09-13T18:35:00Z', bar = 250, amplitude = 0, slope = 0, waterline = 200, extra = [] }) => ({
  sceneId: id,
  time,
  cloudPct: 5,
  looksLikeWater: true,
  outerWaterNir: 0.001,
  transects: [
    ...Array.from({ length: 24 }, (_, i) => {
      const s = -900 + i * 50;
      return {
        alongshoreM: s,
        waterlineM: waterline + slope * s,
        foamPeakM: bar + slope * s + amplitude * Math.sin((s / 200) * Math.PI),
        surfWidthM: 60,
      };
    }),
    ...extra,
  ],
});

test('sandbar: one rogue transect does not move the reading', () => {
  const clean = summariseScene(scene({}));
  const withChannel = summariseScene(scene({
    extra: [{ alongshoreM: 750, waterlineM: -80, foamPeakM: 90, surfWidthM: 400 }],
  }));
  assert.equal(withChannel.transectsDropped, 1, 'the channel transect is thrown out');
  assert.equal(withChannel.waterlineM, clean.waterlineM);
  assert.equal(withChannel.barM, clean.barM);
});

test('sandbar: a straight bar reads straight even when it runs oblique to the beach', () => {
  // The whole bar shifted 40 m offshore over 1.6 km of beach. That is the
  // coastline's own trend, not rhythm, and calling it rhythm would promise
  // corners that are not there.
  const s = summariseScene(scene({ slope: 0.025, amplitude: 0 }));
  assert.ok(s.barSpreadM < 5, `spread ${s.barSpreadM}`);
  assert.equal(s.rhythmic, false);
});

test('sandbar: bulges and gaps read as rhythm', () => {
  const s = summariseScene(scene({ amplitude: 60 }));
  assert.ok(s.barSpreadM >= RHYTHMIC_SPREAD_M, `spread ${s.barSpreadM}`);
  assert.equal(s.rhythmic, true);
});

test('sandbar: a scene that is not open water is refused outright', () => {
  const cloudy = { ...scene({}), looksLikeWater: false };
  const s = summariseScene(cloudy);
  assert.equal(s.usable, false);
  assert.match(s.reason, /not open water|near-infrared/);
});

test('sandbar: the record ignores a scene it already holds', () => {
  const a = summariseScene(scene({ id: 'a', time: '2026-09-01T18:35:00Z' }));
  let state = accumulate(null, a);
  state = accumulate(state, a);
  assert.equal(state.scenes.length, 1);
});

test('sandbar: only the newest passes keep their transects', () => {
  let state = null;
  for (let i = 0; i < MAX_DETAILED + 3; i += 1) {
    state = accumulate(state, summariseScene(scene({
      id: `s${i}`, time: `2026-09-${String(i + 1).padStart(2, '0')}T18:35:00Z`, bar: 240 + i,
    })));
  }
  const detailed = state.scenes.filter((s) => s.transects);
  assert.equal(detailed.length, MAX_DETAILED);
  assert.equal(detailed[detailed.length - 1].sceneId, `s${MAX_DETAILED + 2}`);
});

test('sandbar: movement is reported against the previous pass', () => {
  let state = accumulate(null, summariseScene(scene({ id: 'a', time: '2026-09-01T18:35:00Z', bar: 230, waterline: 200 })));
  state = accumulate(state, summariseScene(scene({ id: 'b', time: '2026-09-13T18:35:00Z', bar: 280, waterline: 180 })));
  const out = summarise(state);
  assert.equal(out.scenes, 2);
  assert.equal(out.barMovedM, 50);
  assert.equal(out.waterlineMovedM, -20);
  assert.match(out.shape, /straight/);
  assert.match(out.note, /shown, not used/);
});

test('sandbar: with nothing logged it says so rather than inventing a bar', () => {
  const out = summarise({ scenes: [] });
  assert.equal(out.scenes, 0);
  assert.match(out.note, /No usable satellite pass/);
});

test('sandbar: how far out it breaks is a median of differences, not a difference of medians', () => {
  // Three stretches of beach: two where it breaks twenty metres off the sand,
  // and one deep-water stretch where the shoreline happens to sit mid-way but
  // the breaking is a long way out. Differencing the two medians reports
  // seventy metres, which is true of no part of this beach; taking each
  // transect's own distance first reports the twenty metres that thirteen of
  // the twenty transects actually show.
  const make = (n, waterlineM, barM, from) => Array.from({ length: n }, (_, i) => ({
    alongshoreM: from + i * 50, waterlineM, foamPeakM: barM, surfWidthM: 60,
  }));
  const transects = [
    ...make(6, 200, 220, -900),
    ...make(7, 300, 320, -600),
    ...make(7, 250, 400, -250),
  ];
  const out = summariseScene({
    sceneId: 'x', time: '2026-09-13T18:35:00Z', cloudPct: 3,
    looksLikeWater: true, outerWaterNir: 0.001, transects,
  });
  assert.equal(out.transectsDropped, 0, 'none of these is an outlier, they are the beach');
  assert.equal(out.barOffsetM, 20);
  assert.equal(out.barM - out.waterlineM, 70, 'what differencing the medians would have claimed');
});
