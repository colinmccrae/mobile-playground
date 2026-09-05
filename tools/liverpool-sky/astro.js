/* Sun and moon calculations, dependency-free.
 * Based on the algorithms in Jean Meeus' "Astronomical Algorithms" as popularised
 * by SunCalc (Vladimir Agafonkin, BSD-2). Accuracy: sun times within ~1 minute,
 * moon times within a few minutes. Angles are radians internally.
 */
(function (global) {
  'use strict';
  const { PI, sin, cos, tan, asin, atan2, acos, sqrt, round, abs } = Math;
  const rad = PI / 180;
  const dayMs = 86400000, J1970 = 2440588, J2000 = 2451545;
  const e = rad * 23.4397; // obliquity of the ecliptic

  const toJulian   = date => date.valueOf() / dayMs - 0.5 + J1970;
  const fromJulian = j => new Date((j + 0.5 - J1970) * dayMs);
  const toDays     = date => toJulian(date) - J2000;

  const rightAscension = (l, b) => atan2(sin(l) * cos(e) - tan(b) * sin(e), cos(l));
  const declination    = (l, b) => asin(sin(b) * cos(e) + cos(b) * sin(e) * sin(l));
  const azimuth        = (H, phi, dec) => atan2(sin(H), cos(H) * sin(phi) - tan(dec) * cos(phi));
  const altitude       = (H, phi, dec) => asin(sin(phi) * sin(dec) + cos(phi) * cos(dec) * cos(H));
  const siderealTime   = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;

  function astroRefraction(h) {
    if (h < 0) h = 0;
    return 0.0002967 / tan(h + 0.00312536 / (h + 0.08901179));
  }

  // ---- Sun -----------------------------------------------------------------
  const solarMeanAnomaly = d => rad * (357.5291 + 0.98560028 * d);
  function eclipticLongitude(M, d) {
    const C = rad * (1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M));
    const P = rad * (102.9373 + 0.00004708 * d); // longitude of perihelion, drifts ~1.72°/century
    return M + C + P + PI;
  }
  function sunCoords(d) {
    const M = solarMeanAnomaly(d), L = eclipticLongitude(M, d);
    return { dec: declination(L, 0), ra: rightAscension(L, 0) };
  }

  /** Sun azimuth (radians from north, clockwise) and altitude (radians). */
  function getSunPosition(date, lat, lng) {
    const lw = rad * -lng, phi = rad * lat, d = toDays(date);
    const c = sunCoords(d), H = siderealTime(d, lw) - c.ra;
    return { azimuth: azimuth(H, phi, c.dec) + PI, altitude: altitude(H, phi, c.dec) };
  }

  const J0 = 0.0009;
  const julianCycle   = (d, lw) => round(d - J0 - lw / (2 * PI));
  const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * PI) + n;
  const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * sin(M) - 0.0069 * sin(2 * L);
  const hourAngle     = (h, phi, d) => acos((sin(h) - sin(phi) * sin(d)) / (cos(phi) * cos(d)));
  function getSetJ(h, lw, phi, dec, n, M, L) {
    const w = hourAngle(h, phi, dec), a = approxTransit(w, lw, n);
    return solarTransitJ(a, M, L);
  }

  const SUN_TIMES = [
    [-0.833, 'sunrise',       'sunset'],
    [-0.3,   'sunriseEnd',    'sunsetStart'],
    [-6,     'dawn',          'dusk'],
    [-12,    'nauticalDawn',  'nauticalDusk'],
    [-18,    'nightEnd',      'night'],
    [6,      'goldenHourEnd', 'goldenHour'],
  ];

  /** Sun event times for the solar day nearest `date`. Missing events are `null`. */
  function getSunTimes(date, lat, lng) {
    const lw = rad * -lng, phi = rad * lat, d = toDays(date);
    const n = julianCycle(d, lw), ds = approxTransit(0, lw, n);
    const M = solarMeanAnomaly(ds), L = eclipticLongitude(M, ds), dec = declination(L, 0);
    const Jnoon = solarTransitJ(ds, M, L);
    const out = { solarNoon: fromJulian(Jnoon), nadir: fromJulian(Jnoon - 0.5) };
    for (const [angle, riseName, setName] of SUN_TIMES) {
      const Jset = getSetJ(angle * rad, lw, phi, dec, n, M, L);
      const Jrise = Jnoon - (Jset - Jnoon);
      out[riseName] = isNaN(Jrise) ? null : fromJulian(Jrise);
      out[setName]  = isNaN(Jset)  ? null : fromJulian(Jset);
    }
    return out;
  }

  // ---- Moon ----------------------------------------------------------------
  // Mean elements (degrees, per day since J2000) with the principal Meeus
  // perturbation terms. Good to roughly 0.05° in longitude.
  function moonCoords(d) {
    const L  = rad * (218.3165 + 13.17639648 * d);  // mean longitude
    const M  = rad * (134.9634 + 13.06499295 * d);  // mean anomaly
    const F  = rad * (93.2721  + 13.22935024 * d);  // argument of latitude
    const D  = rad * (297.8502 + 12.19074912 * d);  // mean elongation
    const Ms = rad * (357.5291 + 0.98560028 * d);   // sun mean anomaly

    const l = L + rad * (
        6.288774 * sin(M)          + 1.274027 * sin(2 * D - M)    + 0.658314 * sin(2 * D)
      + 0.213618 * sin(2 * M)      - 0.185116 * sin(Ms)           - 0.114332 * sin(2 * F)
      + 0.058793 * sin(2 * D - 2 * M) + 0.057066 * sin(2 * D - M - Ms) + 0.053322 * sin(2 * D + M)
      + 0.045758 * sin(2 * D - Ms) + 0.040923 * sin(M - Ms)       - 0.034720 * sin(D)
      - 0.030383 * sin(M + Ms)     + 0.015327 * sin(2 * D - 2 * F) - 0.012528 * sin(M + 2 * F)
      + 0.010980 * sin(M - 2 * F)  + 0.010675 * sin(4 * D - M)    + 0.010034 * sin(3 * M));
    const b = rad * (
        5.128122 * sin(F)          + 0.280602 * sin(M + F)        + 0.277693 * sin(M - F)
      + 0.173237 * sin(2 * D - F)  + 0.055413 * sin(2 * D - M + F) + 0.046271 * sin(2 * D - M - F)
      + 0.032573 * sin(2 * D + F)  + 0.017198 * sin(2 * M + F)    + 0.009266 * sin(2 * D + M - F)
      + 0.008822 * sin(2 * M - F));
    const dt = 385000.56
      - 20905.355 * cos(M)         - 3699.111 * cos(2 * D - M)    - 2955.968 * cos(2 * D)
      - 569.925 * cos(2 * M)       + 48.888 * cos(Ms)             + 246.158 * cos(2 * D - 2 * M)
      - 152.138 * cos(2 * D - M - Ms) - 170.733 * cos(2 * D + M)  - 204.586 * cos(2 * D - Ms)
      - 129.620 * cos(M - Ms)      + 108.743 * cos(D)             + 104.755 * cos(M + Ms)
      + 79.661 * cos(M - 2 * F)    - 34.782 * cos(4 * D - M);
    return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt, lon: l };
  }

  /** Moon azimuth (from north), altitude (refraction-corrected) and distance in km. */
  function getMoonPosition(date, lat, lng) {
    const lw = rad * -lng, phi = rad * lat, d = toDays(date);
    const c = moonCoords(d), H = siderealTime(d, lw) - c.ra;
    let h = altitude(H, phi, c.dec);
    h += astroRefraction(h);
    return { azimuth: azimuth(H, phi, c.dec) + PI, altitude: h, distance: c.dist };
  }

  /** fraction: illuminated 0..1; phase: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
  function getMoonIllumination(date) {
    const d = toDays(date), s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
    const phi = acos(sin(s.dec) * sin(m.dec) + cos(s.dec) * cos(m.dec) * cos(s.ra - m.ra));
    const inc = atan2(sdist * sin(phi), m.dist - sdist * cos(phi));
    // Phase from the difference in ecliptic longitude: monotonic, no sign flips.
    const sunLon = eclipticLongitude(solarMeanAnomaly(d), d);
    const phase = (((m.lon - sunLon) / (2 * PI)) % 1 + 1) % 1;
    return { fraction: (1 + cos(inc)) / 2, phase };
  }

  /** Moonrise / moonset within the 24 h starting at `dayStart` (a Date). */
  function getMoonTimes(dayStart, lat, lng) {
    const t = new Date(dayStart.valueOf());
    const hc = 0.133 * rad;
    let h0 = getMoonPosition(t, lat, lng).altitude - hc;
    let rise, set, ye, h1, h2, a, b, xe, d, roots, x1, x2, dx;
    for (let i = 1; i <= 24; i += 2) {
      h1 = getMoonPosition(hoursLater(t, i), lat, lng).altitude - hc;
      h2 = getMoonPosition(hoursLater(t, i + 1), lat, lng).altitude - hc;
      a = (h0 + h2) / 2 - h1;
      b = (h2 - h0) / 2;
      xe = -b / (2 * a);
      ye = (a * xe + b) * xe + h1;
      d = b * b - 4 * a * h1;
      roots = 0;
      if (d >= 0) {
        dx = sqrt(d) / (abs(a) * 2);
        x1 = xe - dx; x2 = xe + dx;
        if (abs(x1) <= 1) roots++;
        if (abs(x2) <= 1) roots++;
        if (x1 < -1) x1 = x2;
      }
      if (roots === 1) {
        if (h0 < 0) rise = i + x1; else set = i + x1;
      } else if (roots === 2) {
        rise = i + (ye < 0 ? x2 : x1);
        set  = i + (ye < 0 ? x1 : x2);
      }
      if (rise !== undefined && set !== undefined) break;
      h0 = h2;
    }
    const out = { rise: null, set: null, alwaysUp: false, alwaysDown: false };
    if (rise !== undefined) out.rise = hoursLater(t, rise);
    if (set !== undefined)  out.set  = hoursLater(t, set);
    if (rise === undefined && set === undefined) out[ye > 0 ? 'alwaysUp' : 'alwaysDown'] = true;
    return out;
  }
  const hoursLater = (date, h) => new Date(date.valueOf() + h * 3600000);

  /** Next time (after `from`) the moon phase reaches `target` (0 = new, 0.5 = full). */
  function nextMoonPhase(from, target) {
    const dist = p => ((p - target) % 1 + 1) % 1;   // how far past the target, 0..1
    let t0 = from.valueOf(), p0 = dist(getMoonIllumination(from).phase);
    for (let i = 1; i <= 24 * 32; i++) {
      const t1 = from.valueOf() + i * 3600000, p1 = dist(getMoonIllumination(new Date(t1)).phase);
      if (p1 < p0 - 0.5) {                            // wrapped from ~1 to ~0: crossed the target
        let lo = t0, hi = t1;                          // bisect to the minute
        while (hi - lo > 60000) {
          const mid = (lo + hi) / 2;
          if (dist(getMoonIllumination(new Date(mid)).phase) < 0.5) hi = mid; else lo = mid;
        }
        return new Date(hi);
      }
      t0 = t1; p0 = p1;
    }
    return null;
  }

  /** Clear-sky UV index estimate (Allaart et al. 2004): 12.5 · cos(SZA)^2.42 · (O3/300)^-1.23 */
  function uvIndex(sunAltitudeRad, ozoneDU) {
    const mu = sin(sunAltitudeRad);
    if (mu <= 0) return 0;
    return 12.5 * Math.pow(mu, 2.42) * Math.pow(ozoneDU / 300, -1.23);
  }

  global.Astro = { getSunPosition, getSunTimes, getMoonPosition, getMoonIllumination,
                   getMoonTimes, nextMoonPhase, uvIndex };
})(window);
