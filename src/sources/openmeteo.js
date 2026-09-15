/**
 * Open-Meteo marine and weather APIs.
 *
 * We deliberately request each wave model SEPARATELY rather than taking a
 * blended "best match". The disagreement between ECMWF-WAM, NOAA GFS-Wave and
 * Meteo-France WAM is the single most honest confidence signal available: when
 * the models agree, a day is locked in; when they diverge, it is a coin flip
 * dressed up as a forecast. Most consumer surf apps hide this.
 */

import { SITE, SOURCES, FORECAST_DAYS } from '../config.js';
import { getJson } from '../lib/http.js';

const MARINE_VARS = [
  'wave_height', 'wave_direction', 'wave_period',
  'wind_wave_height', 'wind_wave_direction', 'wind_wave_period',
  'swell_wave_height', 'swell_wave_direction', 'swell_wave_period',
];

const WEATHER_VARS = [
  'temperature_2m', 'precipitation', 'cloud_cover',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
];

/**
 * Open-Meteo suffixes variables with the model name when `models` is supplied,
 * but omits the suffix for a single-model request. Accept either shape.
 */
function pick(hourly, name, model) {
  return hourly[`${name}_${model}`] ?? hourly[name] ?? null;
}

/**
 * Convert Open-Meteo's local wall-clock timestamps to UTC, and keep the local
 * hour-of-day alongside. The local hour is what the 7:30-10:00 window is
 * defined in, so we keep it explicitly rather than re-deriving it later.
 */
function normaliseTimes(times, offsetSeconds) {
  return times.map((t) => {
    const utcMs = Date.parse(`${t}Z`) - offsetSeconds * 1000;
    const [, hh, mm] = t.match(/T(\d{2}):(\d{2})/) || [];
    return {
      time: new Date(utcMs).toISOString(),
      localDate: t.slice(0, 10),
      localHour: hh ? Number(hh) + Number(mm) / 60 : 0,
    };
  });
}

/**
 * Per-model hourly wave forecasts out to the outlook horizon.
 *
 * `pastDays` is not cosmetic: the buoy bias correction compares each model
 * against the last 24 h of measurements, so a model that returns only future
 * hours has nothing to be measured against and silently goes uncorrected. That
 * is exactly what happened to GFS-Wave on the first live runs.
 */
export async function fetchMarine({ days = FORECAST_DAYS.outlook + 1, pastDays = 2 } = {}) {
  const models = SOURCES.waveModels;
  const q = new URLSearchParams({
    latitude: String(SITE.lat),
    longitude: String(SITE.lon),
    hourly: MARINE_VARS.join(','),
    models: models.join(','),
    timezone: SITE.timezone,
    forecast_days: String(days),
    past_days: String(pastDays),
    cell_selection: 'sea',
  });
  const j = await getJson(`${SOURCES.marine}?${q}`, { label: 'openmeteo:marine' });
  if (j.error) throw new Error(`Open-Meteo marine: ${j.reason}`);
  const stamps = normaliseTimes(j.hourly.time, j.utc_offset_seconds ?? 0);

  const byModel = {};
  for (const model of models) {
    const get = (v) => pick(j.hourly, v, model);
    if (!get('wave_height')) continue;
    byModel[model] = stamps.map((s, i) => ({
      ...s,
      hsM: get('wave_height')?.[i] ?? null,
      dirDeg: get('wave_direction')?.[i] ?? null,
      periodS: get('wave_period')?.[i] ?? null,
      windSea: {
        hsM: get('wind_wave_height')?.[i] ?? null,
        dirDeg: get('wind_wave_direction')?.[i] ?? null,
        periodS: get('wind_wave_period')?.[i] ?? null,
      },
      swell: {
        hsM: get('swell_wave_height')?.[i] ?? null,
        dirDeg: get('swell_wave_direction')?.[i] ?? null,
        periodS: get('swell_wave_period')?.[i] ?? null,
      },
    })).filter((r) => Number.isFinite(r.hsM));
  }
  if (!Object.keys(byModel).length) throw new Error('Open-Meteo marine returned no usable model data');
  return { byModel, models: Object.keys(byModel) };
}

/**
 * Wind, rain and sun. `pastDays` of precipitation history feeds the water
 * quality advisory - Los Penasquitos Lagoon drains onto this beach, so what
 * fell three days ago matters as much as today's forecast.
 */
export async function fetchWeather({ days = FORECAST_DAYS.outlook + 1, pastDays = 4 } = {}) {
  const models = SOURCES.windModels;
  const q = new URLSearchParams({
    latitude: String(SITE.lat),
    longitude: String(SITE.lon),
    hourly: WEATHER_VARS.join(','),
    daily: 'sunrise,sunset,precipitation_sum',
    models: models.join(','),
    timezone: SITE.timezone,
    forecast_days: String(days),
    past_days: String(pastDays),
    wind_speed_unit: 'kn',
    temperature_unit: 'fahrenheit',
    precipitation_unit: 'inch',
  });
  const j = await getJson(`${SOURCES.weather}?${q}`, { label: 'openmeteo:weather' });
  if (j.error) throw new Error(`Open-Meteo weather: ${j.reason}`);
  const stamps = normaliseTimes(j.hourly.time, j.utc_offset_seconds ?? 0);

  const byModel = {};
  for (const model of models) {
    const get = (v) => pick(j.hourly, v, model);
    if (!get('wind_speed_10m')) continue;
    byModel[model] = stamps.map((s, i) => ({
      ...s,
      windKt: get('wind_speed_10m')?.[i] ?? null,
      windDirDeg: get('wind_direction_10m')?.[i] ?? null,
      gustKt: get('wind_gusts_10m')?.[i] ?? null,
      precipIn: get('precipitation')?.[i] ?? 0,
      airF: get('temperature_2m')?.[i] ?? null,
      cloudPct: get('cloud_cover')?.[i] ?? null,
    })).filter((r) => Number.isFinite(r.windKt));
  }
  if (!Object.keys(byModel).length) throw new Error('Open-Meteo weather returned no usable model data');

  const daily = (j.daily?.time || []).map((d, i) => ({
    localDate: d,
    sunrise: j.daily.sunrise?.[i] ?? null,
    sunset: j.daily.sunset?.[i] ?? null,
    precipIn: j.daily.precipitation_sum?.[i] ?? null,
  }));

  return { byModel, models: Object.keys(byModel), daily };
}


/**
 * Swell trains: what is actually in the water, separated out.
 *
 * The models in the height ensemble (ECMWF-WAM, Meteo-France WAM) do not
 * publish partitioned swell fields, so asking them for partitions silently
 * returned one lumped "total" sea for every hour of the week - which is exactly
 * the information a surfer most wants separated. Open-Meteo's best_match does
 * publish primary, secondary and tertiary swell plus the wind sea, so this
 * fetches those in one extra request and keeps the ensemble for height and
 * confidence where it belongs.
 */
const TRAIN_VARS = [
  'swell_wave_height', 'swell_wave_direction', 'swell_wave_period',
  'secondary_swell_wave_height', 'secondary_swell_wave_direction', 'secondary_swell_wave_period',
  'tertiary_swell_wave_height', 'tertiary_swell_wave_direction', 'tertiary_swell_wave_period',
  'wind_wave_height', 'wind_wave_direction', 'wind_wave_period',
];

export async function fetchSwellTrains({ days = 8 } = {}) {
  const q = new URLSearchParams({
    latitude: String(SITE.lat),
    longitude: String(SITE.lon),
    hourly: TRAIN_VARS.join(','),
    timezone: SITE.timezone,
    forecast_days: String(days),
    cell_selection: 'sea',
  });
  const j = await getJson(`${SOURCES.marine}?${q}`, { label: 'openmeteo:trains' });
  if (j.error) throw new Error(`Open-Meteo trains: ${j.reason}`);
  const stamps = normaliseTimes(j.hourly.time, j.utc_offset_seconds ?? 0);
  const H = j.hourly;

  const pick = (prefix, i) => {
    const h = H[`${prefix}height`]?.[i];
    const p = H[`${prefix}period`]?.[i];
    const d = H[`${prefix}direction`]?.[i];
    if (!Number.isFinite(h) || h < 0.03 || !Number.isFinite(p) || p <= 1) return null;
    return { hsM: h, periodS: p, dirDeg: Number.isFinite(d) ? d : null };
  };

  const byTime = new Map();
  stamps.forEach((s, i) => {
    const trains = [];
    const add = (prefix, kind) => {
      const t = pick(prefix, i);
      if (t && t.dirDeg != null) trains.push({ ...t, kind });
    };
    add('swell_wave_', 'primary swell');
    add('secondary_swell_wave_', 'secondary swell');
    add('tertiary_swell_wave_', 'tertiary swell');
    add('wind_wave_', 'wind sea');
    if (trains.length) {
      trains.sort((a, b) => b.hsM - a.hsM);
      byTime.set(s.time, trains);
    }
  });
  if (!byTime.size) throw new Error('Open-Meteo returned no swell trains');
  return byTime;
}

/** Sea surface temperature, as a backstop if neither buoy reports it. */
export async function fetchSeaTempF() {
  const q = new URLSearchParams({
    latitude: String(SITE.lat), longitude: String(SITE.lon),
    hourly: 'sea_surface_temperature', timezone: 'UTC', forecast_days: '1', cell_selection: 'sea',
  });
  const j = await getJson(`${SOURCES.marine}?${q}`, { label: 'openmeteo:sst' });
  const arr = (j.hourly?.sea_surface_temperature || []).filter((v) => Number.isFinite(v));
  if (!arr.length) throw new Error('No SST available');
  return { f: arr[0] * 9 / 5 + 32, source: 'open-meteo' };
}
