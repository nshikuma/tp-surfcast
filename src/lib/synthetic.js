/**
 * Synthetic data generator for offline development.
 *
 * The build environment used to create this project has no outbound network
 * access to the marine data hosts, so `npm run build:synthetic` produces a
 * physically plausible dataset in the exact shape of the real adapters. It
 * exists so the page can be developed and reviewed without live data - it is
 * never used by the scheduled workflow, and the published page marks any run
 * built this way as synthetic so nobody mistakes it for a real forecast.
 */

import { SITE, SOURCES, FORECAST_DAYS } from '../config.js';

const hourMs = 36e5;

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

export function syntheticBuoy(now = Date.now()) {
  const rnd = seeded(7);
  const records = [];
  for (let i = 96; i >= 0; i--) {
    const t = now - i * 1800e3;
    const phase = (i / 96) * Math.PI;
    records.push({
      time: new Date(t).toISOString(),
      hsM: 1.05 + 0.35 * Math.sin(phase * 2) + 0.05 * (rnd() - 0.5),
      tpS: 14 + 2 * Math.sin(phase) + 0.4 * (rnd() - 0.5),
      dirDeg: 288 + 8 * Math.sin(phase * 1.3),
      taS: 8.5,
    });
  }
  return { station: SOURCES.cdipStation, source: 'synthetic', records, latest: records[records.length - 1], sstC: 19.4 };
}

export function syntheticSpectrum() {
  const bands = [];
  for (let i = 0; i < 64; i++) {
    const f = 0.03 + i * 0.005;
    const T = 1 / f;
    // A long-period NW groundswell plus a short-period local windsea.
    const e = 0.9 * Math.exp(-((T - 14.5) ** 2) / 8) + 0.25 * Math.exp(-((T - 7) ** 2) / 3);
    bands.push({ freqHz: f, periodS: T, energy: e, bandwidth: 0.005, dirDeg: T > 10 ? 289 : 262 });
  }
  return { time: new Date().toISOString(), bands };
}

export function syntheticTides(now = Date.now()) {
  const start = now - 3 * 864e5;
  const series = [];
  const M2 = 12.42 * hourMs, K1 = 23.93 * hourMs;
  for (let i = 0; i < 24 * 18; i++) {
    const t = start + i * hourMs;
    const ft = 2.6 + 2.0 * Math.sin((2 * Math.PI * t) / M2) + 0.9 * Math.sin((2 * Math.PI * t) / K1 + 1.1);
    series.push({ time: new Date(t).toISOString(), ft });
  }
  const hilo = [];
  for (let i = 1; i < series.length - 1; i++) {
    const [a, b, c] = [series[i - 1].ft, series[i].ft, series[i + 1].ft];
    if (b > a && b >= c) hilo.push({ time: series[i].time, ft: b, type: 'high' });
    if (b < a && b <= c) hilo.push({ time: series[i].time, ft: b, type: 'low' });
  }
  return { station: SOURCES.tideStation, datum: 'MLLW', series, hilo, synthetic: true };
}

function localStamp(t) {
  // Fixed -7 offset is fine for synthetic data; real runs use the API's offset.
  const local = new Date(t - 7 * hourMs);
  return {
    time: new Date(t).toISOString(),
    localDate: local.toISOString().slice(0, 10),
    localHour: local.getUTCHours() + local.getUTCMinutes() / 60,
  };
}

export function syntheticMarine(now = Date.now()) {
  const byModel = {};
  const start = new Date(now).setMinutes(0, 0, 0) - 24 * hourMs;
  SOURCES.waveModels.forEach((model, mi) => {
    const rnd = seeded(11 + mi * 31);
    const rows = [];
    for (let i = 0; i < (FORECAST_DAYS.outlook + 2) * 24; i++) {
      const t = start + i * hourMs;
      const d = i / 24;
      // A groundswell peaking around day 3 and a second one around day 9.
      const g1 = 1.15 * Math.exp(-((d - 3) ** 2) / 4.5);
      const g2 = 0.85 * Math.exp(-((d - 9) ** 2) / 6);
      const swellHs = 0.55 + g1 + g2 + 0.06 * (rnd() - 0.5) + mi * 0.04;
      const windHs = 0.25 + 0.18 * Math.max(0, Math.sin((i - 8) / 24 * 2 * Math.PI));
      rows.push({
        ...localStamp(t),
        hsM: Math.sqrt(swellHs ** 2 + windHs ** 2),
        dirDeg: 290 - 6 * Math.sin(d / 2) + mi * 2,
        periodS: 13 + 3 * Math.exp(-((d - 3) ** 2) / 5) + 2 * Math.exp(-((d - 9) ** 2) / 6),
        swell: { hsM: swellHs, dirDeg: 291 - 6 * Math.sin(d / 2) + mi * 2, periodS: 14 + 3 * Math.exp(-((d - 3) ** 2) / 5) },
        windSea: { hsM: windHs, dirDeg: 262, periodS: 6.5 },
      });
    }
    byModel[model] = rows;
  });
  return { byModel, models: Object.keys(byModel), synthetic: true };
}

export function syntheticWeather(now = Date.now()) {
  const byModel = {};
  const start = new Date(now).setMinutes(0, 0, 0) - 4 * 24 * hourMs;
  SOURCES.windModels.forEach((model, mi) => {
    const rnd = seeded(101 + mi * 17);
    const rows = [];
    for (let i = 0; i < (FORECAST_DAYS.outlook + 6) * 24; i++) {
      const t = start + i * hourMs;
      const s = localStamp(t);
      // Classic coastal pattern: light offshore at dawn, sea breeze after noon.
      const morning = Math.max(0, Math.cos(((s.localHour - 6) / 24) * 2 * Math.PI));
      const seaBreeze = Math.max(0, Math.sin(((s.localHour - 9) / 24) * 2 * Math.PI));
      rows.push({
        ...s,
        windKt: 2 + 4 * morning + 11 * seaBreeze + 1.2 * (rnd() - 0.5) + mi * 0.6,
        windDirDeg: seaBreeze > morning ? 268 : 82,
        gustKt: 4 + 6 * morning + 15 * seaBreeze,
        precipIn: 0,
        airF: 62 + 9 * Math.max(0, Math.sin(((s.localHour - 6) / 24) * Math.PI * 2)),
        cloudPct: 40,
      });
    }
    byModel[model] = rows;
  });
  const daily = [];
  for (let i = -4; i < FORECAST_DAYS.outlook + 2; i++) {
    const d = new Date(now + i * 864e5 - 7 * hourMs).toISOString().slice(0, 10);
    daily.push({ localDate: d, sunrise: `${d}T06:32`, sunset: `${d}T19:04`, precipIn: 0 });
  }
  return { byModel, models: Object.keys(byModel), daily, synthetic: true };
}
