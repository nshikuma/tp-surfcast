/**
 * Latitude and longitude to UTM, which is the grid the satellite scenes are on.
 *
 * Sentinel-2 tiles are stored in UTM - this stretch of coast is in zone 11
 * north - and a scene's GeoTIFF header gives the easting and northing of its
 * top-left pixel plus the metres per pixel. To look at one particular sandbar,
 * the beach's latitude and longitude have to be turned into that same grid.
 *
 * This is the standard transverse Mercator projection on the WGS84 ellipsoid,
 * the same formulas the scenes themselves were projected with. Only the forward
 * direction is needed: nothing here ever has to turn a pixel back into a
 * latitude, because the whole question is "which pixel is this bit of beach".
 */

const A = 6378137.0;              // WGS84 semi-major axis, metres
const F = 1 / 298.257223563;      // flattening
const K0 = 0.9996;                // UTM scale factor on the central meridian
const E2 = F * (2 - F);           // first eccentricity squared
const EP2 = E2 / (1 - E2);        // second eccentricity squared
const FALSE_EASTING = 500000;
const FALSE_NORTHING = 10000000;  // southern hemisphere only

const rad = (d) => (d * Math.PI) / 180;

/** The UTM zone a longitude falls in. This coast is 11. */
export const zoneFor = (lonDeg) => Math.floor((lonDeg + 180) / 6) + 1;

/** Central meridian of a zone, in degrees. */
export const centralMeridian = (zone) => (zone - 1) * 6 - 180 + 3;

/**
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {number} [zone] - forced zone; defaults to the natural one for lonDeg.
 * @returns {{eastingM:number, northingM:number, zone:number, north:boolean}}
 */
export function toUtm(latDeg, lonDeg, zone = zoneFor(lonDeg)) {
  const lat = rad(latDeg);
  const lon = rad(lonDeg);
  const lon0 = rad(centralMeridian(zone));

  const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  const T = Math.tan(lat) ** 2;
  const C = EP2 * Math.cos(lat) ** 2;
  const Adist = Math.cos(lat) * (lon - lon0);

  // Meridional arc.
  const M = A * (
    (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * lat
    - ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * lat)
    + ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * lat)
    - ((35 * E2 ** 3) / 3072) * Math.sin(6 * lat)
  );

  const easting = FALSE_EASTING + K0 * N * (
    Adist
    + ((1 - T + C) * Adist ** 3) / 6
    + ((5 - 18 * T + T ** 2 + 72 * C - 58 * EP2) * Adist ** 5) / 120
  );

  let northing = K0 * (M + N * Math.tan(lat) * (
    Adist ** 2 / 2
    + ((5 - T + 9 * C + 4 * C ** 2) * Adist ** 4) / 24
    + ((61 - 58 * T + T ** 2 + 600 * C - 330 * EP2) * Adist ** 6) / 720
  ));
  const north = latDeg >= 0;
  if (!north) northing += FALSE_NORTHING;

  return { eastingM: easting, northingM: northing, zone, north };
}
