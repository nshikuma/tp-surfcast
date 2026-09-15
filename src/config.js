/**
 * Site constants and tunable calibration for Torrey Pines State Beach, north lot.
 *
 * Everything in CALIBRATION is meant to be adjusted from crew ground-truth logs.
 * Nothing here is a magic number without a stated basis - if you change one,
 * update the comment so the next person knows why.
 */

export const SITE = {
  id: 'torrey-pines-north-lot',
  name: 'Torrey Pines - North Lot',
  // North parking lot of Torrey Pines State Beach, at the foot of the grade.
  lat: 32.9340,
  lon: -117.2585,

  // Shoreline geometry. The beach runs roughly NNW-SSE here and faces WSW.
  // shoreNormalDeg is the compass bearing you face when you look straight out
  // to sea from the sand. Swell arriving from exactly this bearing hits square.
  shoreNormalDeg: 265,

  // Mean nearshore beach-face slope (rise/run) over the surf zone.
  // Torrey Pines is a moderately steep sand beach with a seasonal bar; 0.030
  // is a reasonable annual mean. Drives the Iribarren (breaker type) number.
  beachSlope: 0.030,

  // Depth (m) of the offshore buoy whose spectrum we treat as "deep water".
  // CDIP 100p1 (Torrey Pines Outer) sits in ~550 m, comfortably deep-water for
  // every period we care about, so no reverse-shoaling correction is needed.
  buoyDepthM: 550,

  timezone: 'America/Los_Angeles',
};

/** The crew's actual session window. Drives "best window" and the daily call. */
export const SESSION_WINDOW = {
  startHour: 7.5,   // 07:30
  endHour: 10.0,    // 10:00
  label: '7:30-10:00am',
};

/**
 * Directional exposure for Torrey Pines: the fraction of deep-water energy that
 * survives island shadowing and continental-shelf blocking before it reaches the
 * outer buoy line off Torrey Pines.
 *
 * Basis: the Southern California Bight is screened by the Channel Islands to the
 * west/northwest and by Point Loma plus the Baja headlands to the south. These
 * are engineering estimates, not measured transmission coefficients - they are
 * the first thing to retune once we have logged sessions.
 *
 * Keyed by deep-water peak direction (degrees TRUE, direction waves come FROM).
 */
export const EXPOSURE = [
  { from: 160, to: 185, t: 0.20 },  // deep S - heavily shadowed, mostly refracted scraps
  { from: 185, to: 200, t: 0.35 },  // S/SSW - Baja + Point Loma screening
  { from: 200, to: 215, t: 0.55 },  // SSW - the usual summer south angle
  { from: 215, to: 235, t: 0.72 },  // SW - decent window
  { from: 235, to: 252, t: 0.86 },  // WSW - good
  { from: 252, to: 272, t: 1.00 },  // W - straight in the window, no blocking
  { from: 272, to: 284, t: 0.90 },  // WNW - clips San Clemente Island
  { from: 284, to: 296, t: 0.68 },  // NW - Catalina + San Clemente shadow, the notch
  { from: 296, to: 308, t: 0.82 },  // NW - reopening between islands
  { from: 308, to: 325, t: 0.92 },  // NNW - the classic winter angle, wide open
  { from: 325, to: 340, t: 0.78 },  // steep NNW - refraction losses down the coast
  { from: 340, to: 360, t: 0.45 },  // N - very oblique, little energy turns the corner
];

/**
 * How well a given swell direction lines up with the north-lot sandbars, once
 * energy has actually arrived. This is shape, not size.
 *
 * WNW swell wraps into the bars here and lines up; straight W is clean but can
 * close out; S swell arrives peaky and inconsistent. 1.0 is neutral.
 */
export const BAR_ALIGNMENT = [
  { from: 160, to: 200, q: 0.70 },
  { from: 200, to: 235, q: 0.85 },
  { from: 235, to: 258, q: 0.95 },
  { from: 258, to: 272, q: 1.00 },
  { from: 272, to: 292, q: 1.10 },  // the angle that makes this place good
  { from: 292, to: 312, q: 1.02 },
  { from: 312, to: 360, q: 0.88 },
];

export const CALIBRATION = {
  /**
   * Physical breaking significant height -> the face height a surfer would
   * actually call it. This is BELOW 1.0 on purpose: the measured trough-to
   * -crest height of a breaking wave is consistently larger than the number
   * surfers quote, and a forecast that ignores that reads as wildly optimistic.
   *
   * Tuned against three local anchor cases (buoy 100p1 -> what it is at the
   * north lot):
   *   Hs 1.0 m / 15 s / WNW  -> waist-to-chest, sets shoulder
   *   Hs 2.0 m / 16 s / NW   -> head high, sets a foot overhead
   *   Hs 0.7 m / 17 s / SSW  -> knee-to-thigh, inconsistent
   * All three land correctly at 0.74. Retune from the crew session log.
   */
  faceFactor: 0.74,

  // Typical face -> set-wave face. H(1/10) is about 1.27x Hs for a Rayleigh
  // sea; 1.30 is that rounded, and matches "occasional bigger ones".
  setFactor: 1.30,

  /**
   * Energy lost between the buoy line and the surf zone that plain refraction
   * and shoaling do not capture: directional spreading (the buoy's Hs is spread
   * over a band of directions, and only part of it focuses onto the beach) plus
   * bottom friction across ~8 miles of shelf.
   */
  shelfLoss: 0.88,

  /**
   * How hard to apply the island-shadowing table to GLOBAL MODEL data.
   *
   * Critical distinction, and the one most generic forecasts get wrong here:
   * CDIP 100p1 sits INSIDE the Channel Islands shadow, so its readings already
   * include the blocking - applying EXPOSURE to buoy data would double-count it.
   * The 0.25-degree global wave models only crudely resolve the islands, so
   * their nearshore output needs a partial correction. 0 = none, 1 = full.
   */
  modelExposureStrength: 0.6,

  // Depth-limited breaking index, H/h at break. 0.78 is the textbook solitary
  // -wave value; real beaches with a bar run a little higher.
  gammaBreak: 0.80,

  // Tide preference, feet above MLLW. Torrey Pines has a bar/trough profile:
  // dead low drains the bar and it closes out on dry sand, and a big high
  // pushes the peak onto the steep upper beach and goes fat and backwashy.
  tide: {
    best: [1.2, 3.6],      // the sweet spot band
    usable: [-0.4, 5.2],   // outside this, quality falls off hard
    incomingBonus: 0.05,   // a filling tide is modestly better than draining
  },

  // Wind, in knots. Offshore here is roughly from the ENE (085 deg true).
  wind: {
    glassyMax: 3,        // at or under this, direction barely matters
    offshoreIdeal: 6,    // light offshore grooming
    offshoreMax: 16,     // beyond this it is holding waves up / blowing you back
    onshoreTolerable: 5, // a light onshore is survivable
    onshoreRuin: 13,     // past this it is wind-chopped junk
  },

  // Period, seconds. Short-period local windswell is weak and disorganised;
  // very long-period swell at a beach break tends to close out unless the
  // tide is right.
  period: {
    weakBelow: 8,
    goodBand: [11, 17],
    closeoutRiskAbove: 18,
  },

  // Water quality: San Diego County advises staying out of the ocean for 72 h
  // after rain. Los Penasquitos Lagoon drains directly onto this stretch of
  // beach, so the north end is the worst place in the county to ignore that.
  rain: {
    advisoryHours: 72,
    triggerInches: 0.2,
    lagoonOutletNote: 'Los Penasquitos Lagoon outlet is at the north end - runoff plumes hit this exact stretch first.',
  },

  // Wetsuit thresholds in degrees F, based on a 2-hour session.
  wetsuit: [
    { minF: 68, call: 'Trunks or a spring suit' },
    { minF: 64, call: 'Spring suit / 2mm' },
    { minF: 60, call: '3/2 fullsuit' },
    { minF: 56, call: '3/2 fullsuit, booties if it is windy' },
    { minF: -99, call: '4/3 fullsuit + booties' },
  ],
};

/** Body-scale size labels, keyed on typical FACE height in feet (~5'10" surfer). */
export const SIZE_LADDER = [
  { max: 1.0,  label: 'Ankle high',        short: 'ankle' },
  { max: 1.5,  label: 'Shin high',         short: 'shin' },
  { max: 2.0,  label: 'Knee high',         short: 'knee' },
  { max: 2.5,  label: 'Thigh high',        short: 'thigh' },
  { max: 3.5,  label: 'Waist high',        short: 'waist' },
  { max: 4.5,  label: 'Chest high',        short: 'chest' },
  { max: 5.25, label: 'Shoulder high',     short: 'shoulder' },
  { max: 6.25, label: 'Head high',         short: 'head' },
  { max: 8.0,  label: 'Overhead',          short: 'OH' },
  { max: 9.5,  label: 'Well overhead',     short: 'well OH' },
  { max: 12.0, label: 'Double overhead',   short: '2x OH' },
  { max: 99,   label: 'Way overhead (2x+)', short: '2x+ OH' },
];

/** Data sources. All are public and unauthenticated. */
export const SOURCES = {
  // CDIP 100p1 "Torrey Pines Outer" - the buoy the user asked for. This is the
  // single most important input: it is 8 miles straight offshore of the lineup.
  cdipStation: '100p1',
  cdipThredds: 'https://thredds.cdip.ucsd.edu/thredds/dodsC/cdip/realtime',
  cdipJustdar: 'https://cdip.ucsd.edu/data_access/justdar.cdip',

  // NDBC mirror of the same buoy, used as a fallback if CDIP THREDDS is down.
  ndbcStation: '46225',

  // NOAA CO-OPS La Jolla (Scripps Pier) - nearest tide and water-temp station,
  // about 5 miles south. Tides at Torrey Pines are within a few minutes of it.
  tideStation: '9410230',
  coops: 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter',

  // Open-Meteo: free, no key, and exposes the raw model runs individually so we
  // can measure inter-model disagreement instead of hiding it behind a blend.
  marine: 'https://marine-api.open-meteo.com/v1/marine',
  weather: 'https://api.open-meteo.com/v1/forecast',

  // Wave models to compare. Keeping them separate is the point: spread between
  // them is our honest confidence signal.
  waveModels: ['ecmwf_wam025', 'ncep_gfswave025', 'meteofrance_wave'],
  windModels: ['ecmwf_ifs025', 'gfs_seamless'],
};

export const FORECAST_DAYS = { detailed: 7, outlook: 14 };
