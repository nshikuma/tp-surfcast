/**
 * How much sand is on the beach right now, and which way it is going.
 *
 * A beach is not a fixed shape. A week of big surf pulls the berm down and
 * drags the bar offshore; a calm spell walks it back on. Torrey Pines swings
 * through tens of metres of shoreline position over a season, which changes
 * where waves break, how they peel, and how early the tide drains the bank -
 * so a surf model with a frozen seafloor is missing one of its main variables.
 *
 * This carries an equilibrium model of the Yates, Guza & O'Reilly (2009) form,
 * which was developed on this coast:
 *
 *     dS/dt = C * sqrt(E) * (Eeq(S) - E)      Eeq(S) = a*S + b,  a < 0
 *
 * S is shoreline position in metres (positive = sand built up, seaward). E is
 * wave energy. When the sea is rougher than the beach's equilibrium the beach
 * erodes; calmer, and it accretes, more slowly than it eroded.
 *
 * HONEST ABOUT THE CONSTANTS. The coefficients below are NOT the published
 * Torrey Pines fits - I have not been able to read that paper's tables from
 * here. They are plausible values chosen to give the right behaviour and
 * timescale (a 3 m swell pulls roughly 10 m of shoreline in two days; recovery
 * takes weeks). They are the first thing to refit once the Ludka survey data is
 * ingested, which contains sixteen years of exactly the observations needed.
 *
 * The state accumulates across runs, so it starts neutral and earns its memory.
 */

export const COEFFS = {
  a: -0.002,      // m^2 per metre of shoreline: more sand, lower equilibrium energy
  b: 0.076,       // m^2: equilibrium energy at the neutral shoreline (~1.1 m Hs)
  cErode: 0.60,   // metres per hour per (m^2 * sqrt(m^2))
  // Accretion carries the LARGER coefficient, which looks wrong until you note
  // the sqrt(E) term: a calm sea has so little energy to move sand with that a
  // smaller coefficient recovered 0.4 m in a week, when real beaches walk back
  // a few metres. Erosion still dominates in practice because storm energy is
  // an order of magnitude greater - the asymmetry lives in E, not in C.
  cAccrete: 1.20,
  sMin: -25,
  sMax: 25,
};

/** Wave energy in the convention this model family uses: E = Hs^2 / 16, m^2. */
export const energyOf = (hsM) => (hsM > 0 ? (hsM * hsM) / 16 : 0);

/**
 * Step the beach forward through a series of observations.
 * @param {number} s0 starting shoreline position, metres
 * @param {Array<{time:string, hsM:number}>} obs oldest first
 */
export function stepState(s0, obs, { from = null } = {}) {
  let s = s0;
  let last = from ? Date.parse(from) : null;
  let hours = 0;
  let energySum = 0, energyN = 0;

  for (const o of obs) {
    const t = Date.parse(o.time);
    if (!Number.isFinite(t) || !(o.hsM > 0)) continue;
    if (last == null) { last = t; continue; }
    const dt = (t - last) / 36e5;
    last = t;
    // Skip absurd gaps: a stale state should not be stepped by a month of
    // assumed-constant energy in one jump.
    if (!(dt > 0) || dt > 12) continue;

    const E = energyOf(o.hsM);
    const Eeq = COEFFS.a * s + COEFFS.b;
    const C = E > Eeq ? COEFFS.cErode : COEFFS.cAccrete;
    s += C * Math.sqrt(E) * (Eeq - E) * dt;
    s = Math.max(COEFFS.sMin, Math.min(COEFFS.sMax, s));
    hours += dt;
    energySum += E; energyN++;
  }
  return {
    s,
    hoursStepped: Math.round(hours * 10) / 10,
    meanEnergy: energyN ? energySum / energyN : null,
    lastObservation: last ? new Date(last).toISOString() : null,
  };
}

/** Plain-language read on where the beach is and which way it is moving. */
export function describe(s, trend) {
  const level = s > 8 ? 'well built up' : s > 2.5 ? 'sand on it'
    : s < -8 ? 'stripped' : s < -2.5 ? 'thin' : 'about average';
  const moving = trend > 0.6 ? 'building' : trend < -0.6 ? 'eroding' : 'holding';
  const consequence = s > 2.5
    ? 'Bank is further in and shallower - it will close out earlier on a low tide.'
    : s < -2.5
      ? 'Bar has pulled offshore and flattened - it breaks further out and walls up more.'
      : 'Bar is in its usual place.';
  return {
    level, moving,
    summary: `Beach is ${level} and ${moving}.`,
    consequence,
  };
}

/**
 * Map the sand state onto the shape of the beach.
 *
 * Built up: the berm pushes seaward and the bar migrates onshore and steepens.
 * Stripped: the bar moves offshore and flattens, and the foreshore steepens.
 */
export function profileFor(s) {
  return {
    shorelineOffsetM: s,                                  // + = seaward
    barCrestM: 95 - s * 1.6,                              // eroded pushes it out
    barHeightM: Math.max(0.35, 1.0 + s * 0.022),
    foreshoreSlope: s < 0 ? 0.085 + Math.min(0.03, -s * 0.0018) : 0.085 - Math.min(0.02, s * 0.0012),
  };
}
