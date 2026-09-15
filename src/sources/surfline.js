/**
 * Surfline adapter - present but DISABLED by design.
 *
 * You chose a models-only comparison, so nothing here runs. It is kept as a
 * working seam so Surfline can be dropped back in later without reshaping the
 * rest of the pipeline: return the same {hourly:[{time, surfMinFt, surfMaxFt}]}
 * shape and the comparison view will pick it up automatically.
 *
 * Enable by setting SURFLINE_ENABLED=1 in the workflow environment.
 */

export const ENABLED = process.env.SURFLINE_ENABLED === '1';

export async function fetchSurfline() {
  if (!ENABLED) return null;
  throw new Error('Surfline adapter is stubbed. Implement fetch here before enabling.');
}
