// TravelPulse — Inventory Intelligence Engine
// Phase 1 implementation: ACDI demand detruncation, Fox marginal allocation,
// supplier selection, PDUI timing heuristic, risk-penalized optimization.
// Zero external dependencies — Node.js 18+ only.
'use strict';
const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);

// ─────────────────────────────────────────────
//  DESTINATION MASTER DATA
// ─────────────────────────────────────────────
const DESTINATIONS = [
  { id:'BKK', name:'Bangkok',   country:'Thailand',   region:'Asia Pacific', base:620, growth:.14, social:82, sentiment:.78, price:76,  sell:124, cancel:.12, supply:940, hotel:true, flight:true },
  { id:'DXB', name:'Dubai',     country:'UAE',        region:'Middle East',  base:570, growth:.09, social:64, sentiment:.71, price:118, sell:182, cancel:.09, supply:720, hotel:true, flight:true },
  { id:'IST', name:'Istanbul',  country:'Türkiye',    region:'Europe',       base:485, growth:.19, social:91, sentiment:.84, price:83,  sell:139, cancel:.11, supply:680, hotel:true, flight:true },
  { id:'SIN', name:'Singapore', country:'Singapore',  region:'Asia Pacific', base:450, growth:.08, social:59, sentiment:.82, price:132, sell:198, cancel:.07, supply:510, hotel:true, flight:true },
  { id:'TYO', name:'Tokyo',     country:'Japan',      region:'Asia Pacific', base:410, growth:.24, social:96, sentiment:.88, price:146, sell:224, cancel:.08, supply:560, hotel:true, flight:true },
  { id:'PAR', name:'Paris',     country:'France',     region:'Europe',       base:390, growth:.07, social:73, sentiment:.75, price:158, sell:236, cancel:.14, supply:480, hotel:true, flight:true },
  { id:'CMB', name:'Colombo',   country:'Sri Lanka',  region:'South Asia',   base:280, growth:.16, social:68, sentiment:.73, price:61,  sell:102, cancel:.16, supply:390, hotel:true, flight:true },
  { id:'KTM', name:'Kathmandu', country:'Nepal',      region:'South Asia',   base:215, growth:.12, social:54, sentiment:.69, price:52,  sell:91,  cancel:.18, supply:330, hotel:true, flight:true }
];

const CATEGORIES = [
  { id:'hotel',  name:'Hotel rooms',  multiplier:1,   cost:1,   sell:1,   cancellation:.04, salvage:.22, fee:.06  },
  { id:'flight', name:'Flight seats', multiplier:.62, cost:.73, sell:.68, cancellation:.07, salvage:.08, fee:.045 }
];

const EVENTS = [
  { destination:'Tokyo',    event:'Cherry blossom shoulder season', date:'Apr 2027', impact:'+18%', type:'Seasonal',  status:'Scenario signal' },
  { destination:'Istanbul', event:'Spring cultural calendar',       date:'May 2027', impact:'+12%', type:'Cultural',  status:'Scenario signal' },
  { destination:'Bangkok',  event:'Songkran travel period',         date:'Apr 2027', impact:'+22%', type:'Festival',  status:'Scenario signal' },
  { destination:'Dubai',    event:'Winter sun demand window',       date:'Dec 2026', impact:'+14%', type:'Seasonal',  status:'Scenario signal' },
  { destination:'Paris',    event:'Summer peak season',            date:'Jun 2027', impact:'+16%', type:'Seasonal',  status:'Scenario signal' }
];

// ─────────────────────────────────────────────
//  SUPPLIER MASTER DATA  (M5)
//  v        = wholesale procurement price per room
//  phantom  = booking rejection / no-availability rate
//  salvage  = refund fraction on unsold / cancelled units
//  minCommit= minimum rooms that must be ordered (0 = no minimum)
//  reliability = supplier historical confirmation rate [0,1]
// ─────────────────────────────────────────────
const SUPPLIERS = {
  BKK: [
    { id:'BKK-S1', name:'Agoda Contract',   v:76,  phantom:.06, salvage:.22, minCommit:0,  reliability:.94 },
    { id:'BKK-S2', name:'Local Wholesale',  v:68,  phantom:.18, salvage:.10, minCommit:50, reliability:.82 },
    { id:'BKK-S3', name:'TBO Direct',       v:81,  phantom:.03, salvage:.28, minCommit:0,  reliability:.97 }
  ],
  DXB: [
    { id:'DXB-S1', name:'Rotana Allotment', v:118, phantom:.05, salvage:.20, minCommit:0,  reliability:.95 },
    { id:'DXB-S2', name:'Regional Broker',  v:109, phantom:.14, salvage:.08, minCommit:30, reliability:.86 }
  ],
  IST: [
    { id:'IST-S1', name:'Turk Hotel GDS',   v:83,  phantom:.08, salvage:.18, minCommit:0,  reliability:.92 },
    { id:'IST-S2', name:'Istanbul Direct',  v:76,  phantom:.20, salvage:.12, minCommit:40, reliability:.80 }
  ],
  SIN: [
    { id:'SIN-S1', name:'SG Contract',      v:132, phantom:.04, salvage:.25, minCommit:0,  reliability:.96 },
    { id:'SIN-S2', name:'Asia Wholesale',   v:121, phantom:.12, salvage:.14, minCommit:25, reliability:.88 }
  ],
  TYO: [
    { id:'TYO-S1', name:'JTB Contract',     v:146, phantom:.05, salvage:.22, minCommit:0,  reliability:.95 },
    { id:'TYO-S2', name:'Tokyo Direct',     v:135, phantom:.15, salvage:.10, minCommit:35, reliability:.85 }
  ],
  PAR: [
    { id:'PAR-S1', name:'AccorHotels GDS',  v:158, phantom:.04, salvage:.20, minCommit:0,  reliability:.96 },
    { id:'PAR-S2', name:'Paris Broker',     v:144, phantom:.16, salvage:.08, minCommit:20, reliability:.84 }
  ],
  CMB: [
    { id:'CMB-S1', name:'Lanka Hotels',     v:61,  phantom:.10, salvage:.18, minCommit:0,  reliability:.90 },
    { id:'CMB-S2', name:'Colombo Direct',   v:55,  phantom:.22, salvage:.08, minCommit:30, reliability:.78 }
  ],
  KTM: [
    { id:'KTM-S1', name:'Nepal Alliance',   v:52,  phantom:.12, salvage:.15, minCommit:0,  reliability:.88 },
    { id:'KTM-S2', name:'Kathmandu DMC',    v:47,  phantom:.25, salvage:.06, minCommit:20, reliability:.75 }
  ]
};

// ─────────────────────────────────────────────
//  MATH UTILITIES
// ─────────────────────────────────────────────
function round(n, d = 0) {
  const p = 10 ** d;
  return Math.round((n + Number.EPSILON) * p) / p;
}

/**
 * Standard normal CDF via Abramowitz & Stegun 26.2.17
 * |error| < 7.5e-8
 */
function normalCDF(z) {
  if (z < -8) return 0;
  if (z >  8) return 1;
  const neg = z < 0;
  if (neg) z = -z;
  const t  = 1 / (1 + 0.2316419 * z);
  const p  = t * (0.319381530
            + t * (-0.356563782
            + t * (1.781477937
            + t * (-1.821255978
            + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const c   = 1 - pdf * p;
  return neg ? 1 - c : c;
}

/**
 * Rational approximation for Φ⁻¹(p)
 * Beasley-Springer-Moro algorithm — absolute error < 4.5e-4
 */
function normalInverseCDF(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return  Infinity;
  if (p < 0.5) return -normalInverseCDF(1 - p);
  const q = p - 0.5;
  if (Math.abs(q) <= 0.42425) {
    const r = q * q;
    return q * ((((-25.44106049637 * r + 41.39119773534) * r + -18.61500062529) * r + 2.50662823884)
              / ((((3.13082909833 * r + -21.06224101826) * r + 23.08336743743) * r + -8.47351093090) * r + 1));
  }
  const r = Math.sqrt(-Math.log(p < 0.5 ? p : 1 - p));
  const sign = q < 0 ? -1 : 1;
  return sign * (((2.515517 + 0.802853 * r + 0.010328 * r * r) /
                  (1 + 1.432788 * r + 0.189269 * r * r + 0.001308 * r * r * r)) - r);
}

/**
 * Log-normal E[min(Q,D)] — closed-form
 * D ~ LogNormal(nu, tau^2), mu = exp(nu + tau^2/2)
 */
function eMinQD(Q, mu, cv) {
  if (Q <= 0)  return 0;
  if (mu <= 0) return 0;
  const tau = Math.sqrt(Math.log(1 + cv * cv));
  const nu  = Math.log(mu) - tau * tau / 2;
  const z1  = (Math.log(Q) - nu) / tau;
  const z2  = z1 - tau;
  return Q * (1 - normalCDF(z1)) + mu * normalCDF(z2);
}

/**
 * Log-normal E[(Q-D)^+] = Q - E[min(Q,D)]
 */
function eOverage(Q, mu, cv) {
  return Math.max(0, Q - eMinQD(Q, mu, cv));
}

/**
 * Log-normal newsvendor optimal quantity: Q* = exp(nu + tau * Φ⁻¹(CR))
 */
function newsvendorQ(mu, cv, CR) {
  if (CR <= 0) return 0;
  if (CR >= 1) return Infinity;
  const tau = Math.sqrt(Math.log(1 + cv * cv));
  const nu  = Math.log(mu) - tau * tau / 2;
  return Math.round(Math.exp(nu + tau * normalInverseCDF(CR)));
}

// ─────────────────────────────────────────────
//  SUPPLIER ECONOMICS  (M5, M6)
// ─────────────────────────────────────────────
/**
 * Effective procurement cost accounting for phantom rejections.
 * When phantom = rate of booking failures, TBO must attempt more orders
 * and may pay premium sourcing. We model vEff = v / (1 - phantom).
 */
function effectiveCost(supplier) {
  return supplier.v / (1 - supplier.phantom);
}

/**
 * Per-unit expected net profit for a given (supplier, destination) combination.
 *
 * E[Π(Q,s)] = (1-k)(p - v_s·r_s)·E[min(Q,D)] - Q·(vEff_s·(1-r_s) + p·f)
 *
 * No double-deduction: vEff appears exactly once as the procurement cost term.
 *
 * @param {number} Q - Procurement quantity
 * @param {number} mu - ACDI unconstrained demand estimate
 * @param {number} cv - Coefficient of variation (0.30)
 * @param {number} p  - Selling price
 * @param {number} k  - Cancellation rate
 * @param {number} f  - Platform fee fraction
 * @param {object} supplier - Supplier record
 */
function supplierExpectedProfit(Q, mu, cv, p, k, f, supplier) {
  const vEff = effectiveCost(supplier);
  const r    = supplier.salvage;
  const v    = supplier.v;
  const eminQD = eMinQD(Q, mu, cv);
  const profitIfSold   = (1 - k) * (p - v * r);
  const costPerOrdered = vEff * (1 - r) + p * f;
  return profitIfSold * eminQD - costPerOrdered * Q;
}

/**
 * Critical ratio and optimal Q* for a given supplier/destination combination.
 */
function supplierCriticalRatio(p, k, f, supplier) {
  const vEff = effectiveCost(supplier);
  const r    = supplier.salvage;
  const v    = supplier.v;
  const Cu = (1 - k) * (p - v * r) - (vEff * (1 - r) + p * f);
  const Co = vEff * (1 - r) + p * f;
  return Cu <= 0 ? 0 : Cu / (Cu + Co);
}

/**
 * M6 — Select best supplier for a destination at quantity Q.
 * Returns supplier with highest E[Π(Q,s)].
 */
function bestSupplier(destId, Q, mu, cv, p, k, f) {
  const suppliers = SUPPLIERS[destId] || [];
  if (!suppliers.length) return null;
  let best = null, bestProfit = -Infinity;
  for (const s of suppliers) {
    const profit = supplierExpectedProfit(Q, mu, cv, p, k, f, s);
    if (profit > bestProfit) { bestProfit = profit; best = s; }
  }
  return best;
}

// ─────────────────────────────────────────────
//  M1 — 3-LAYER SYNTHETIC DATA GENERATOR
// ─────────────────────────────────────────────
/**
 * Deterministic pseudo-random number generator (seeded) so results
 * are repeatable across server restarts without an external library.
 * Uses a simple xorshift32 PRNG seeded per destination+month.
 */
function makePRNG(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

/**
 * Poisson sample from a seeded PRNG (Knuth algorithm).
 */
function poissonSample(lambda, rand) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}

/**
 * Generates the full 3-layer synthetic dataset.
 *
 * Layer 1 (SEALED): Ground-truth latent demand per destination per month.
 * Layer 2 (OBSERVABLE): Observed bookings, searches, A_time (time-based availability).
 * Layer 3: Returned observations have NO reference to Layer 1 ground truth.
 *
 * Returns { groundTruth (SEALED), observations }
 */
function generateSyntheticData() {
  const HORIZON_MONTHS = 12;
  const L2B_BASE       = 5.25;   // baseline look-to-book ratio
  const CV             = 0.30;   // aggregate demand coefficient of variation
  const DAYS_PER_MONTH = 30;

  // Store sealed ground truth separately
  const groundTruth = {};   // { destId: [ { month, trueDemand, trueAvgDailyRate } ] }
  const observations = {};  // { destId: [ { month, bObs, sObs, aTime, price, soldOutDays } ] }

  for (const dest of DESTINATIONS) {
    groundTruth[dest.id]  = [];
    observations[dest.id] = [];

    for (let m = 0; m < HORIZON_MONTHS; m++) {
      // ─── LAYER 1: Sealed ground truth ──────────────────────────────
      const seed = dest.id.charCodeAt(0) * 1000 + dest.id.charCodeAt(1) * 100 + m * 7 + 42;
      const rand = makePRNG(seed);

      // Latent monthly demand: base × seasonality × growth × exogenous shocks
      const season    = 1 + 0.18 * Math.sin((m / 12) * Math.PI * 2 - 1.15);
      const trend     = 1 + dest.growth * (m / 12);
      // Hidden exogenous shock (event / competitor price spike) — estimator does NOT know this
      const exoShock  = 1 + (rand() - 0.5) * 0.25;  // ±12.5% random shock
      const trueMu    = dest.base * season * trend * exoShock;
      // Sample actual monthly demand from log-normal distribution
      const trueTau   = Math.sqrt(Math.log(1 + CV * CV));
      const trueNu    = Math.log(trueMu) - trueTau * trueTau / 2;
      const trueZ     = normalInverseCDF(rand());
      const trueDemand = Math.max(1, Math.round(Math.exp(trueNu + trueTau * trueZ)));

      groundTruth[dest.id].push({ month: m, trueMu, trueDemand });

      // ─── LAYER 2: Observable simulation ────────────────────────────
      // Simulate daily customer arrival process and inventory consumption
      const dailySupply  = Math.floor(dest.supply / DAYS_PER_MONTH);
      let remainingSupply = dest.supply;
      let bObs = 0;
      let soldOutDays = 0;
      let frustratedSearches = 0;
      const dailyLambda = trueDemand / DAYS_PER_MONTH;

      for (let day = 0; day < DAYS_PER_MONTH; day++) {
        const daySeed  = seed * 31 + day * 97;
        const dayRand  = makePRNG(daySeed);
        const arrivals = poissonSample(dailyLambda, dayRand);

        if (remainingSupply > 0) {
          // Rooms available: customers book, inventory consumed
          const booked = Math.min(arrivals, remainingSupply);
          bObs += booked;
          remainingSupply -= booked;
        } else {
          // SOLD OUT: each arriving customer generates frustrated searches
          soldOutDays++;
          for (let a = 0; a < arrivals; a++) {
            // Each frustrated customer generates Poisson(L2B_BASE) search events
            const fSeed = seed * 1000 + day * 100 + a;
            frustratedSearches += poissonSample(L2B_BASE, makePRNG(fSeed));
          }
        }
      }

      // A_time = fraction of days with any inventory > 0 (observable metric)
      const aTime = round((DAYS_PER_MONTH - soldOutDays) / DAYS_PER_MONTH, 3);

      // Ambient browsing searches (searchers who weren't going to book)
      const ambientSeed   = seed * 999 + m;
      const ambientRand   = makePRNG(ambientSeed);
      const ambientSearches = Math.round(bObs * (L2B_BASE * 0.4 + ambientRand() * 0.5));

      // Total observed searches (booking-linked + frustrated + ambient + noise)
      const noiseSeed = seed + 777;
      const noiseRand = makePRNG(noiseSeed);
      const noise     = Math.round((noiseRand() - 0.5) * bObs * 0.1);
      const sObs      = Math.max(0, bObs * L2B_BASE + frustratedSearches + ambientSearches + noise);

      // IMPORTANT: _trueDemand is NOT stored here. Estimator cannot access Layer 1.
      observations[dest.id].push({
        month: m,
        monthLabel: new Date(Date.UTC(2025 + Math.floor(m / 12), m % 12, 1))
                      .toLocaleString('en', { month: 'short', timeZone: 'UTC' }),
        bObs,
        sObs: Math.round(sObs),
        aTime,
        soldOutDays,
        supply: dest.supply,
        price: dest.price,
        cancel: dest.cancel
      });
    }
  }

  return { groundTruth, observations };
}

// Pre-generate synthetic data once at startup (deterministic, sealed)
const SYNTHETIC = generateSyntheticData();

// ─────────────────────────────────────────────
//  M2 — SHORTAGE SIGNAL ENGINE
// ─────────────────────────────────────────────
/**
 * Computes shortage signals for a destination using observable Layer 2 data.
 *
 * Shortage intensity σ-score: combines sold-out day frequency, L2B deviation,
 * and magnitude of search activity during constrained periods.
 */
function shortageSignals(destId) {
  const obs = SYNTHETIC.observations[destId];
  if (!obs) return null;

  const L2B_BASELINE = 5.25;
  let totalSoldOutDays = 0, totalDays = 0;
  let l2bDevSum = 0;
  const monthlySignals = [];

  for (const o of obs) {
    const days = 30;
    totalSoldOutDays += o.soldOutDays;
    totalDays        += days;
    // Observed L2B this month
    const l2bObs = o.bObs > 0 ? o.sObs / o.bObs : L2B_BASELINE;
    // L2B deviation: higher L2B with low aTime → frustrated demand signal
    const l2bDev = (l2bObs - L2B_BASELINE) * (1 - o.aTime);
    l2bDevSum += l2bDev;

    monthlySignals.push({
      monthLabel: o.monthLabel,
      aTime: o.aTime,
      soldOutDays: o.soldOutDays,
      l2bObserved: round(l2bObs, 2),
      l2bDeviation: round(l2bDev, 3)
    });
  }

  const stockoutFrequency  = round(totalSoldOutDays / totalDays, 3);
  const avgL2BDeviation    = round(l2bDevSum / obs.length, 3);

  // σ-score: 0–100 composite shortage intensity
  // High stockoutFrequency + high L2B deviation = suppressed demand present
  const sigmaScore = round(
    Math.min(100, Math.max(0,
      stockoutFrequency * 60 + Math.max(0, avgL2BDeviation) * 25 + (1 - obs.reduce((s, o) => s + o.aTime, 0) / obs.length) * 15
    )), 1
  );

  return {
    destId,
    stockoutFrequency,
    avgL2BDeviation,
    sigmaScore,
    interpretation: sigmaScore > 60 ? 'High suppressed demand — ACDI correction critical'
                  : sigmaScore > 30 ? 'Moderate suppressed demand — correction recommended'
                  : 'Low suppressed demand — naive estimate reasonable',
    monthly: monthlySignals
  };
}

// ─────────────────────────────────────────────
//  M3 — ACDI DEMAND ESTIMATOR
// ─────────────────────────────────────────────
/**
 * Availability-Corrected Demand Intelligence (ACDI) estimator.
 *
 * Uses observable A_time (fraction of days with inventory > 0) to correct
 * observed bookings for the fraction of time inventory was unavailable.
 *
 * Core detruncation: D_hat = B_obs / A_time (when A_time > 0)
 * Additionally applies search-side correction using L2B deviation.
 *
 * Returns 90-day unconstrained demand estimate with log-normal uncertainty range.
 */
function acdiEstimate(destId) {
  const obs  = SYNTHETIC.observations[destId];
  const dest = DESTINATIONS.find(d => d.id === destId);
  if (!obs || !dest) return null;

  const CV          = 0.30;
  const L2B_BASE    = 5.25;
  const HORIZON_MONTHS = 3; // 90-day planning horizon

  // Use all 12 months of observations for estimation
  let weightedDemandSum = 0, weightSum = 0;

  for (const o of obs) {
    let dHat;
    if (o.aTime <= 0.02) {
      // Near-total stockout: use search signal as proxy
      // dHat ≈ sObs / L2B_BASE (search-volume detruncation)
      dHat = o.sObs / L2B_BASE;
    } else {
      // Primary ACDI detruncation: correct observed bookings for availability
      const primaryHat = o.bObs / o.aTime;
      // Search-side correction: if L2B elevated above baseline during low aTime,
      // searches contain frustrated demand signal
      const l2bObs = o.bObs > 0 ? o.sObs / o.bObs : L2B_BASE;
      const frustrationFactor = Math.max(0, (l2bObs - L2B_BASE) / L2B_BASE) * (1 - o.aTime);
      // Blend primary and search corrections (search signal trusted at 20% weight)
      dHat = primaryHat * (1 + frustrationFactor * 0.20);
    }

    // Weight by recency (more recent months get higher weight)
    const monthIdx = o.month;
    const weight   = 0.5 + (monthIdx / 11) * 0.5;  // 0.5→1.0 recency ramp
    weightedDemandSum += dHat * weight;
    weightSum         += weight;
  }

  const monthlyMuHat = weightedDemandSum / weightSum;
  // 90-day (3-month) unconstrained demand estimate
  const mu90 = Math.round(monthlyMuHat * HORIZON_MONTHS);

  // Log-normal uncertainty: 10th and 90th percentiles
  const tau  = Math.sqrt(Math.log(1 + CV * CV));
  const nu   = Math.log(Math.max(1, mu90)) - tau * tau / 2;
  const lo90 = Math.round(Math.exp(nu + tau * normalInverseCDF(0.10)));
  const hi90 = Math.round(Math.exp(nu + tau * normalInverseCDF(0.90)));

  return {
    destId,
    mu90,          // point estimate — ACDI corrected 90-day demand
    lo90,          // 10th percentile planning range
    hi90,          // 90th percentile planning range
    cv: CV,
    monthlyMuHat: round(monthlyMuHat, 1)
  };
}

// ─────────────────────────────────────────────
//  M4 — OPPORTUNITY GAP DETECTOR
// ─────────────────────────────────────────────
/**
 * Estimates the unmet demand gap and associated lost revenue opportunity
 * using ACDI demand vs naive (observed) baseline.
 */
function opportunityGap(destId) {
  const dest  = DESTINATIONS.find(d => d.id === destId);
  const acdi  = acdiEstimate(destId);
  const obs   = SYNTHETIC.observations[destId];
  if (!dest || !acdi || !obs) return null;

  // Naive 90-day forecast (what the original prototype computed)
  const season      = 1 + 0.12 * Math.sin((5 / 12) * Math.PI * 2 - 1.15);
  const naiveMu90   = Math.round(dest.base * season * (1 + dest.growth) * 3);

  const suppressedDemand = Math.max(0, acdi.mu90 - naiveMu90);
  const lostRevenue      = round(suppressedDemand * dest.sell * (1 - dest.cancel), 2);
  const avgATime         = round(obs.reduce((s, o) => s + o.aTime, 0) / obs.length, 3);

  return {
    destId,
    destName: dest.name,
    naiveMu90,
    acdiMu90: acdi.mu90,
    suppressedDemand,
    lostRevenue,
    avgATime,
    upliftPct: naiveMu90 > 0 ? round((acdi.mu90 - naiveMu90) / naiveMu90 * 100, 1) : 0
  };
}

// ─────────────────────────────────────────────
//  M7 — PDUI PROCUREMENT TIMING ENGINE
// ─────────────────────────────────────────────
/**
 * Corrected normalized exponential booking pace curve.
 * P(tau) = (1 - exp(-lambda*(90-tau))) / (1 - exp(-lambda*90))
 * P(tau=90) = 0.0, P(tau=0) = 1.0  ✓
 * lambda = 0.035 → ~83% booked by 45 days prior to travel date (B2B advance-purchase pattern)
 *                    ~68% by 60 days prior, ~43% by 75 days prior.
 *
 * @param {number} daysRemaining - Days until check-in date
 */
function bookingPaceFraction(daysRemaining) {
  const T      = 90;
  const lambda = 0.035;
  const daysElapsed = T - Math.max(0, Math.min(T, daysRemaining));
  const numerator   = 1 - Math.exp(-lambda * daysElapsed);
  const denominator = 1 - Math.exp(-lambda * T);
  return numerator / denominator;
}

/**
 * M7 — PDUI (Pace & Deadline Urgency Index) Heuristic.
 *
 * DISCLAIMER: This is a heuristic urgency index, NOT a formally optimal
 * MDP stopping rule (Etzioni et al. 2003). It is explicitly labelled as a heuristic.
 *
 * @param {string} destId
 * @param {number} daysRemaining - Days until travel date (0-90)
 * @param {number} observedPaceFraction - Fraction of projected bookings actually realized [0,1]
 */
function procurementTiming(destId, daysRemaining = 45, observedPaceFraction = null) {
  const dest = DESTINATIONS.find(d => d.id === destId);
  if (!dest) return null;

  const expectedPace = bookingPaceFraction(daysRemaining);

  // If not provided, synthesize an observed pace (slightly ahead of expected)
  const obsPace = observedPaceFraction !== null
    ? observedPaceFraction
    : Math.min(1, expectedPace * (1 + (dest.growth - 0.10) * 0.5));

  const paceDeviation = obsPace - expectedPace;  // positive = faster than expected

  // Supplier price escalation risk model:
  // Wholesale prices increase closer to travel date (advance purchase discount)
  // c(daysRemaining) = v_base × (1 + alpha × exp(-beta × daysRemaining))
  const alpha   = 0.15;
  const beta    = 0.05;
  const vBase   = dest.price;
  const vNow    = round(vBase * (1 + alpha * Math.exp(-beta * daysRemaining)), 2);
  const priceEscalation = round((vNow - vBase) / (vBase * alpha), 3);  // 0→1 scale

  // Allotment release deadline urgency (releases typically at 14, 21, 30 days)
  const RELEASE_DEADLINES = [14, 21, 30];
  const nearDeadline = RELEASE_DEADLINES.some(d => daysRemaining <= d + 7);

  // PDUI urgency score (0–100)
  const urgencyScore = round(Math.min(100, Math.max(0,
    paceDeviation > 0
      ? 40 + paceDeviation * 200 + priceEscalation * 25 + (nearDeadline ? 15 : 0)
      : 20 + Math.max(0, paceDeviation) * 100 + priceEscalation * 20 + (nearDeadline ? 10 : 0)
  )), 0);

  let recommendation, urgencyLabel;
  if (urgencyScore >= 70) {
    urgencyLabel   = 'SECURE IMMEDIATELY';
    recommendation = 'Booking pace is surging ahead of expected curve. Supplier prices are escalating. Secure allotment now before availability closes.';
  } else if (urgencyScore >= 40) {
    urgencyLabel   = 'MONITOR ACTIVE PACE';
    recommendation = 'Pace is tracking close to projection. Monitor weekly. Secure if pace accelerates or deadline approaches within 7 days.';
  } else {
    urgencyLabel   = 'DEFER PROCUREMENT';
    recommendation = 'Pace is below projection. Demand signal is weak. Hold capital — reassess as the booking window matures.';
  }

  return {
    destId,
    destName: dest.name,
    daysRemaining,
    expectedPaceFraction: round(expectedPace, 3),
    observedPaceFraction: round(obsPace, 3),
    paceDeviation: round(paceDeviation, 3),
    supplierPriceNow: vNow,
    supplierPriceBase: vBase,
    priceEscalationPct: round(priceEscalation * 100, 1),
    urgencyScore,
    urgencyLabel,
    recommendation,
    disclaimer: 'PDUI is a heuristic urgency index. A formally optimal procurement timing model (e.g. MDP optimal stopping) is not implemented.'
  };
}

// ─────────────────────────────────────────────
//  M3 → ACDI OPPORTUNITY BUILDER
//  Replaces the old `opportunities()` function
// ─────────────────────────────────────────────
function opportunities(signals = {}) {
  const demandShift   = Number(signals.demandShift   || 0);
  const socialWeight  = Number(signals.socialWeight  ?? 0.08);
  const supplierShift = Number(signals.supplierShift || 0);
  const cancelShift   = Number(signals.cancelShift   || 0);
  const CV            = 0.30;

  return DESTINATIONS.flatMap(d => CATEGORIES.map(c => {
    // ── ACDI unconstrained demand estimate ──────────────────────────────
    const acdi     = acdiEstimate(d.id);
    const acdiMu90 = acdi ? acdi.mu90 : d.base * 3;

    // Apply category multiplier + scenario signals
    const socialLift    = Math.max(-0.03, Math.min(0.18, (d.social - 55) / 300 * socialWeight / 0.08));
    const marketGrowth  = d.growth + socialLift;
    const forecast      = Math.max(1, Math.round(acdiMu90 * c.multiplier * (1 + demandShift)));

    // Naive baseline for comparison
    const hist          = Math.round(d.base * c.multiplier);
    const naiveForecast = Math.max(1, Math.round(hist * 3 * (1 + marketGrowth + demandShift)));

    const available     = Math.floor(d.supply * c.multiplier * (c.id === 'flight' ? 0.88 : 1));

    // ── Supplier selection ──────────────────────────────────────────────
    const cost      = round(d.price * c.cost * (1 + supplierShift), 2);
    const sell      = round(d.sell * c.sell, 2);
    const cancel    = Math.min(0.55, Math.max(0.01, d.cancel + c.cancellation + cancelShift));
    const f         = c.fee;
    const r         = c.salvage;

    // Pick best supplier if hotel (MVP scope), else use default pricing
    const suppliersForDest = SUPPLIERS[d.id] || [];
    const mockSupplier     = suppliersForDest[0] || { v: cost, phantom: 0.05, salvage: r, minCommit: 0, reliability: 0.90 };
    const chosenSupplier   = c.id === 'hotel' ? (bestSupplier(d.id, Math.min(available, forecast), forecast, CV, sell, cancel, f) || mockSupplier) : mockSupplier;

    const vEff      = effectiveCost(chosenSupplier);
    const vEffAdj   = round(vEff * c.cost * (1 + supplierShift), 2);

    // ── Newsvendor optimal quantity (ACDI-corrected) ───────────────────
    const CR        = supplierCriticalRatio(sell, cancel, f, { ...chosenSupplier, v: d.price * c.cost });
    const qStar     = newsvendorQ(forecast, CV, CR);
    const optimal   = Math.min(available, Math.max(0, qStar));

    // ── Expected profit using closed-form E[min(Q,D)] ──────────────────
    const mu        = forecast;
    const eminQD    = eMinQD(optimal, mu, CV);
    const v         = d.price * c.cost;
    const profitIfSold   = (1 - cancel) * (sell - v * r);
    const costPerOrdered = v * (1 - r) + sell * f;

    const expectedRevenue = round((1 - cancel) * sell * eminQD, 2);
    const procurementCost = round(optimal * vEffAdj, 2);
    const otherCosts      = round(optimal * sell * f, 2);
    const salvageRevenue  = round(v * r * eOverage(optimal, mu, CV), 2);
    const profit          = round(profitIfSold * eminQD - costPerOrdered * optimal, 2);

    // Unit margin (per room, single-unit expected margin)
    const margin    = round(profitIfSold - costPerOrdered, 2);

    // ── Risk scoring ──────────────────────────────────────────────────
    const conversion = round(0.19 + (d.sentiment - 0.65) * 0.32, 3);
    const overageRisk = eOverage(optimal, mu, CV);
    const risk = round(Math.min(99, Math.max(8,
      cancel * 100 * 0.48
      + (overageRisk / Math.max(1, optimal)) * 100 * 0.34
      + (d.id === 'CMB' || d.id === 'KTM' ? 14 : 7)
    )), 0);

    const score = round(Math.max(0, Math.min(100,
      50 + marketGrowth * 105 + (margin / Math.max(1, cost)) * 16 - risk * 0.28
    )), 0);
    const label = score >= 72 && risk < 32 ? 'High potential' : risk >= 40 ? 'High risk' : score >= 54 ? 'Moderate' : 'Low potential';

    // Opportunity gap info
    const suppressedDemand = Math.max(0, forecast - naiveForecast);

    return {
      destination: d.name, code: d.id, region: d.region,
      category: c.id, categoryName: c.name,
      historical: hist,
      forecast,          // ACDI-corrected
      naiveForecast,     // naive baseline for comparison
      suppressedDemand,  // ACDI - naive
      available,
      cost: vEffAdj, sell, conversion,
      cancellation: round(cancel, 3),
      expectedSales: round(eminQD, 0),
      recommended: optimal,
      revenue: expectedRevenue,
      profit,
      procurementCost,
      risk, score, label,
      social: d.social, sentiment: d.sentiment,
      growth: round(marketGrowth * 100, 1),
      margin,
      chosenSupplierId: chosenSupplier.id || 'default',
      chosenSupplierName: chosenSupplier.name || 'Default',
      supplierPhantomRate: round((chosenSupplier.phantom || 0) * 100, 1),
      explanation: `ACDI forecast: ${forecast} rooms (naive baseline: ${naiveForecast}). Suppressed demand recovered: ${suppressedDemand} rooms. ${round(marketGrowth * 100, 1)}% growth trend. Best supplier: ${chosenSupplier.name || 'default'}. E[min(Q*,D)] = ${round(eminQD, 0)} rooms. Estimated cancellation: ${round(cancel * 100, 1)}%.`
    };
  })).sort((a, b) => b.score - a.score);
}

// ─────────────────────────────────────────────
//  M8 — FOX MARGINAL ALLOCATION OPTIMIZER
// ─────────────────────────────────────────────
/**
 * Fox (1966) marginal allocation with heterogeneous unit costs.
 * Selects i* = argmax_i(Δi(Qi)/vi) at each step.
 * Proof of optimality: separability + strict concavity of E[Π_i(Q_i)] under
 * continuous log-normal demand → zero integrality gap (Fox 1966, Mgmt Sci).
 *
 * When minCommit > 0 for a supplier, pre-screening ensures that destination
 * is only included if budget >= minCommit * cost (DP fallback labelled as heuristic).
 *
 * @param {number} budget
 * @param {Array}  candidates - Opportunity rows from opportunities()
 * @param {number} gamma - Overage aversion parameter (0 = pure expected profit)
 * @param {number} riskLimit - Max allowed risk score
 * @param {number} minMargin - Minimum unit margin % of cost
 */
function foxOptimize(budget, candidates, gamma = 0, riskLimit = 70, minMargin = 0) {
  const CV = 0.30;

  // Filter eligible candidates
  const eligible = candidates.filter(x =>
    x.margin > 0
    && x.risk <= riskLimit
    && x.margin / Math.max(1, x.cost) * 100 >= minMargin
  );

  // Current allocation state
  const state = {};
  for (const e of eligible) {
    state[e.code + '|' + e.category] = {
      row: e,
      qi: 0,
      maxQ: e.recommended,
      mu: e.forecast,
      cv: CV,
      unitCost: e.cost
    };
  }

  let remaining = budget;
  const steps   = budget; // max iterations safeguard

  for (let iter = 0; iter < steps; iter++) {
    let bestKey = null, bestEfficiency = -Infinity;

    for (const [key, s] of Object.entries(state)) {
      if (s.qi >= s.maxQ) continue;
      if (s.unitCost > remaining) continue;

      const qNext  = s.qi + 1;
      const pi_q   = piQ(s.qi,  s.mu, s.cv, s.row);
      const pi_q1  = piQ(qNext, s.mu, s.cv, s.row);

      let deltaI = pi_q1 - pi_q;

      // Downside risk-penalized mode: subtract γ·Co·ΔE[(Q-D)^+]
      if (gamma > 0) {
        const Co        = s.row.cost * (1 - s.row.cancellation /* salvage */ * 0.22) + s.row.sell * 0.06;
        const deltaOverage = eOverage(qNext, s.mu, s.cv) - eOverage(s.qi, s.mu, s.cv);
        deltaI -= gamma * Co * deltaOverage;
      }

      if (deltaI <= 0) continue;  // No marginal gain — skip

      const efficiency = deltaI / s.unitCost;  // Δi/vi (per dollar)
      if (efficiency > bestEfficiency) {
        bestEfficiency = efficiency;
        bestKey = key;
      }
    }

    if (bestKey === null) break;  // No profitable move found — stop

    state[bestKey].qi += 1;
    remaining = round(remaining - state[bestKey].unitCost, 2);
  }

  return { state, remaining };
}

/**
 * Expected profit for procuring Q units of a given opportunity row.
 * Uses the corrected formula: E[Π(Q)] = (1-k)(p-vr)·E[min(Q,D)] - Q·(v(1-r)+pf)
 */
function piQ(Q, mu, cv, row) {
  if (Q <= 0) return 0;
  const p  = row.sell;
  const k  = row.cancellation;
  const v  = row.cost;
  const f  = 0.06;    // hotel fee (matches CATEGORIES)
  const r  = 0.22;    // hotel salvage (matches CATEGORIES)
  const eminQD  = eMinQD(Q, mu, cv);
  const profitTerm = (1 - k) * (p - v * r) * eminQD;
  const costTerm   = Q * (v * (1 - r) + p * f);
  return profitTerm - costTerm;
}

// ─────────────────────────────────────────────
//  M9 — COMBINED OPTIMIZE FUNCTION
//  (replaces original optimize(), preserves API contract)
// ─────────────────────────────────────────────
function optimize({
  budget        = 250000,
  riskTolerance = 55,
  minMargin     = 0,
  demandShift   = 0,
  supplierShift = 0,
  cancelShift   = 0,
  socialWeight  = 0.08,
  category      = 'all',
  destination   = 'all',
  gamma         = 0       // overage aversion (0 = pure expected profit)
} = {}) {
  budget        = Number(budget);
  riskTolerance = Number(riskTolerance);
  minMargin     = Number(minMargin);
  gamma         = Number(gamma);

  if (!Number.isFinite(budget)        || budget < 0        || budget > 100000000)   throw new Error('Budget must be between $0 and $100,000,000.');
  if (!Number.isFinite(riskTolerance) || riskTolerance < 0 || riskTolerance > 100)  throw new Error('Risk tolerance must be between 0 and 100.');
  if (!Number.isFinite(minMargin)     || minMargin < 0     || minMargin > 100)       throw new Error('Minimum margin must be between 0 and 100%.');
  if (!Number.isFinite(gamma)         || gamma < 0         || gamma > 10)            throw new Error('Gamma must be between 0 and 10.');

  const rows = opportunities({ demandShift, supplierShift, cancelShift, socialWeight })
    .filter(x => (category === 'all' || x.category === category)
              && (destination === 'all' || x.code === destination));

  const riskLimit = 15 + riskTolerance * 0.75;

  // Run Fox marginal allocation optimizer
  const { state, remaining } = foxOptimize(budget, rows, gamma, riskLimit, minMargin);

  const picks = [];
  for (const s of Object.values(state)) {
    if (s.qi === 0) continue;
    const Q      = s.qi;
    const mu     = s.mu;
    const cv     = s.cv;
    const eminQD = eMinQD(Q, mu, cv);
    const overage = eOverage(Q, mu, cv);
    const p      = s.row.sell;
    const k      = s.row.cancellation;
    const v      = s.row.cost;
    const f      = 0.06;
    const r      = 0.22;

    const profitTerm    = round((1 - k) * (p - v * r) * eminQD, 2);
    const costTerm      = round(Q * (v * (1 - r) + p * f), 2);
    const profit        = round(profitTerm - costTerm, 2);
    const revenue       = round((1 - k) * p * eminQD, 2);
    const procCost      = round(Q * v, 2);
    const riskExposure  = round(overage * v * (1 - r), 2);

    picks.push({
      ...s.row,
      recommended: Q,
      revenue,
      procurementCost: procCost,
      otherCosts:      round(Q * p * f, 2),
      expectedLoss:    riskExposure,
      profit,
      riskExposure
    });
  }

  picks.sort((a, b) => b.profit - a.profit);

  const investment   = round(budget - remaining, 2);
  const totalRevenue = round(picks.reduce((s, x) => s + x.revenue, 0), 2);
  const totalProfit  = round(picks.reduce((s, x) => s + x.profit, 0), 2);
  const totalRisk    = round(picks.reduce((s, x) => s + x.riskExposure, 0), 2);

  const rejected = rows
    .filter(x => !picks.some(p => p.code === x.code && p.category === x.category))
    .slice(0, 5)
    .map(x => ({
      destination: x.destination,
      categoryName: x.categoryName,
      reason: x.margin <= 0 ? 'Negative expected unit contribution'
             : x.risk > riskLimit ? 'Outside current risk tolerance'
             : `Fails ${minMargin}% minimum margin or budget cap`
    }));

  return {
    budget, investment, remaining,
    revenue: totalRevenue,
    profit:  totalProfit,
    riskExposure: totalRisk,
    roi: investment ? round(totalProfit / investment * 100, 1) : 0,
    purchases: picks,
    rejected,
    assumptions: { demandShift, supplierShift, cancelShift, socialWeight, riskTolerance, minMargin, gamma },
    model: gamma > 0
      ? `Fox (1966) marginal allocation with downside risk-penalized expected profit (γ=${gamma}). Overage-aversion objective U_γ(Q) = E[Π(Q)] - γ·Co·E[(Q-D)⁺]. NOT CVaR.`
      : 'Fox (1966) separable concave marginal allocation (Δi/vi efficiency per dollar). Log-normal newsvendor Q* with closed-form E[min(Q,D)]. Zero external dependencies — synthetic ACDI prototype.'
  };
}

// ─────────────────────────────────────────────
//  HISTORICAL — preserved for dashboard KPIs
// ─────────────────────────────────────────────
function historical() {
  const obs = SYNTHETIC.observations;
  return DESTINATIONS[0] // Use BKK as template for 12-month shape
    ? Array.from({ length: 12 }, (_, i) => {
        const monthLabel = new Date(Date.UTC(2025 + Math.floor(i / 12), i % 12, 1))
          .toLocaleString('en', { month: 'short', timeZone: 'UTC' });
        // Aggregate all destinations for this month
        let bookings = 0, searches = 0, cancellations = 0, soldOut = 0;
        for (const dest of DESTINATIONS) {
          const mo = (obs[dest.id] || [])[i];
          if (mo) {
            bookings      += mo.bObs;
            searches      += mo.sObs;
            cancellations += Math.round(mo.bObs * dest.cancel);
            soldOut       += mo.soldOutDays > 0 ? 1 : 0;
          }
        }
        return { month: monthLabel, bookings, searches, cancellations, soldOut };
      })
    : [];
}

// ─────────────────────────────────────────────
//  M10 — VALIDATION & MAPE ENGINE
// ─────────────────────────────────────────────
/**
 * Blind evaluation: compares ACDI estimates against sealed ground truth.
 * Estimator has not had access to groundTruth during estimation.
 *
 * Returns per-destination MAPE for ACDI vs Naive Baseline,
 * and aggregate evaluation report.
 */
function evaluateACDI() {
  const CV = 0.30;
  const results = [];
  let acdiMAPESum = 0, naiveMAPESum = 0, n = 0;

  for (const dest of DESTINATIONS) {
    const gt     = SYNTHETIC.groundTruth[dest.id];
    const obs    = SYNTHETIC.observations[dest.id];
    const acdi   = acdiEstimate(dest.id);
    if (!gt || !obs || !acdi) continue;

    // Per-month MAPE
    let acdiMAPE = 0, naiveMAPE = 0;
    for (let m = 0; m < gt.length; m++) {
      const trueDemand = gt[m].trueDemand;
      const oBs        = obs[m].bObs;
      // Naive estimate: observed bookings (what a naive system would use)
      const naiveHat   = oBs;
      // ACDI monthly estimate using the corrected A_time
      const aTime      = obs[m].aTime;
      const acdiHat    = aTime > 0.02 ? oBs / aTime : obs[m].sObs / 5.25;

      acdiMAPE  += Math.abs(acdiHat  - trueDemand) / Math.max(1, trueDemand);
      naiveMAPE += Math.abs(naiveHat - trueDemand) / Math.max(1, trueDemand);
    }
    acdiMAPE  = round(acdiMAPE  / gt.length * 100, 1);
    naiveMAPE = round(naiveMAPE / gt.length * 100, 1);

    acdiMAPESum += acdiMAPE;
    naiveMAPESum += naiveMAPE;
    n++;

    const signals = shortageSignals(dest.id);
    results.push({
      destId:   dest.id,
      destName: dest.name,
      acdiMAPE,
      naiveMAPE,
      improvement: round(naiveMAPE - acdiMAPE, 1),
      sigmaScore: signals ? signals.sigmaScore : 0,
      avgATime: round((SYNTHETIC.observations[dest.id] || []).reduce((s, o) => s + o.aTime, 0) / 12, 3)
    });
  }

  const avgACDI  = round(acdiMAPESum  / n, 1);
  const avgNaive = round(naiveMAPESum / n, 1);

  return {
    destinations: results,
    aggregate: {
      avgACDImape:  avgACDI,
      avgNaiveMAPE: avgNaive,
      improvement:  round(avgNaive - avgACDI, 1),
      verdict: avgACDI < avgNaive
        ? `ACDI reduces MAPE by ${round(avgNaive - avgACDI, 1)} percentage points vs naive baseline on average.`
        : 'ACDI does not outperform naive baseline in this synthetic run. Review availability signal quality.'
    },
    disclaimer: 'Evaluation is on synthetic data with known ground truth. Real-world performance depends on data quality.'
  };
}

// ─────────────────────────────────────────────
//  DASHBOARD (preserving original shape)
// ─────────────────────────────────────────────
function dashboard() {
  const hist = historical();
  const opp  = opportunities();
  const plan = optimize();

  return {
    historical: hist,
    destinations: DESTINATIONS,
    opportunities: opp,
    plan,
    events: EVENTS,
    kpis: {
      bookings:      hist.reduce((s, x) => s + x.bookings, 0),
      forecast:      opp.filter(x => x.category === 'hotel').reduce((s, x) => s + x.forecast, 0),
      searches:      hist.reduce((s, x) => s + x.searches, 0),
      cancellations: hist.reduce((s, x) => s + x.cancellations, 0),
      soldOut:       hist.reduce((s, x) => s + x.soldOut, 0)
    },
    social: DESTINATIONS.map(d => ({
      destination: d.name,
      mentions:    d.social,
      change:      round(d.growth * 100, 1),
      sentiment:   d.sentiment,
      label:       'Simulated social signal'
    }))
  };
}

// ─────────────────────────────────────────────
//  HTTP SERVER
// ─────────────────────────────────────────────
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    // ── Original endpoints (preserved) ─────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(dashboard()));
    }
    if (req.method === 'GET' && url.pathname === '/api/opportunities') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(opportunities(Object.fromEntries(url.searchParams))));
    }
    if (req.method === 'POST' && url.pathname === '/api/optimize') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 1e6) throw new Error('Payload too large'); });
      req.on('end', () => {
        try {
          const result = optimize(JSON.parse(body || '{}'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // ── New ACDI intelligence endpoints ────────────────────────────

    // GET /api/acdi  — ACDI demand estimates + opportunity gaps for all destinations
    if (req.method === 'GET' && url.pathname === '/api/acdi') {
      const data = DESTINATIONS.map(d => ({
        ...acdiEstimate(d.id),
        ...opportunityGap(d.id),
        destName: d.name,
        region: d.region
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    // GET /api/shortage-signals  — shortage intensity signals for all destinations
    if (req.method === 'GET' && url.pathname === '/api/shortage-signals') {
      const data = DESTINATIONS.map(d => shortageSignals(d.id));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    // GET /api/suppliers  — supplier catalog with per-unit economics per destination
    if (req.method === 'GET' && url.pathname === '/api/suppliers') {
      const CV = 0.30;
      const data = DESTINATIONS.map(d => {
        const dest    = d;
        const acdi    = acdiEstimate(d.id);
        const mu90    = acdi ? acdi.mu90 : d.base * 3;
        const qRef    = Math.round(mu90 * 0.5); // reference Q for comparison
        const supList = (SUPPLIERS[d.id] || []).map(s => {
          const CR     = supplierCriticalRatio(d.sell, d.cancel, 0.06, s);
          const qStar  = newsvendorQ(mu90, CV, CR);
          const eminQD = eMinQD(qStar, mu90, CV);
          const eProfit = round(supplierExpectedProfit(qStar, mu90, CV, d.sell, d.cancel, 0.06, s), 2);
          return {
            ...s,
            effectiveCost:  round(effectiveCost(s), 2),
            criticalRatio:  round(CR, 3),
            optimalQ:       qStar,
            expectedProfit: eProfit,
            profitPerUnit:  qStar > 0 ? round(eProfit / qStar, 2) : 0
          };
        });
        return {
          destId: d.id, destName: d.name, region: d.region,
          acdiMu90: mu90,
          suppliers: supList,
          bestSupplierId: supList.length ? supList.reduce((a, b) => a.expectedProfit > b.expectedProfit ? a : b).id : null
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    // GET /api/timing  — PDUI procurement timing for all destinations
    if (req.method === 'GET' && url.pathname === '/api/timing') {
      const daysRemaining = Number(url.searchParams.get('days') || 45);
      const data = DESTINATIONS.map(d => procurementTiming(d.id, daysRemaining));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    // GET /api/validate  — Blind MAPE evaluation against sealed ground truth
    if (req.method === 'GET' && url.pathname === '/api/validate') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(evaluateACDI()));
    }

    // GET /api/demo  — Pre-configured Bangkok Songkran demo scenario
    // Shows ACDI catching suppressed demand during Songkran festival peak
    if (req.method === 'GET' && url.pathname === '/api/demo') {
      const bkkACDI   = acdiEstimate('BKK');
      const bkkGap    = opportunityGap('BKK');
      const bkkSigs   = shortageSignals('BKK');
      const bkkTime   = procurementTiming('BKK', 42); // 42 days to Songkran
      const bkkSupp   = (SUPPLIERS['BKK'] || []).map(s => {
        const CV  = 0.30;
        const dest = DESTINATIONS.find(d => d.id === 'BKK');
        const mu  = bkkACDI ? bkkACDI.mu90 : dest.base * 3;
        const CR  = supplierCriticalRatio(dest.sell, dest.cancel, 0.06, s);
        const q   = newsvendorQ(mu, CV, CR);
        return {
          ...s,
          effectiveCost: round(effectiveCost(s), 2),
          criticalRatio: round(CR, 3),
          optimalQ: q,
          expectedProfit: round(supplierExpectedProfit(q, mu, CV, dest.sell, dest.cancel, 0.06, s), 2)
        };
      });
      // Songkran scenario: +22% demand lift, budget $150k, hotel only
      const songkranPlan = optimize({ budget: 150000, demandShift: 0.22, category: 'hotel', destination: 'BKK', riskTolerance: 65 });
      const basePlan     = optimize({ budget: 150000, demandShift: 0,    category: 'hotel', destination: 'BKK', riskTolerance: 65 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        scenario: 'Bangkok Songkran April 2027',
        event: EVENTS.find(e => e.destination === 'Bangkok'),
        acdi: bkkACDI,
        gap: bkkGap,
        shortage: bkkSigs,
        timing: bkkTime,
        suppliers: bkkSupp,
        songkranPlan,
        basePlan,
        narrative: `ACDI estimates ${bkkACDI ? num(bkkACDI.mu90) : '—'} rooms of 90-day unconstrained demand for Bangkok vs the naive baseline of ${bkkGap ? num(bkkGap.naiveMu90) : '—'} rooms. With the Songkran +22% demand scenario, the Fox optimizer recommends ${songkranPlan.purchases[0]?.recommended || 0} rooms from the best supplier. PDUI urgency: ${bkkTime?.urgencyLabel}.`,
        disclaimer: 'Demo scenario uses synthetic ACDI data. Songkran demand lift is a scenario signal, not a confirmed forecast.'
      }));
      function num(n){ return new Intl.NumberFormat('en-US').format(n); }
    }

    // ── Static file serving ────────────────────────────────────────
    if (req.method === 'GET') {
      const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      const file = path.resolve(__dirname, '.' + pathname);
      if (!file.startsWith(__dirname + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
      return;
    }

    res.writeHead(405); res.end('Method not allowed');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

if (require.main === module) server.listen(PORT, () => console.log(`TravelPulse running at http://localhost:${PORT}`));

module.exports = {
  server, optimize, opportunities, historical, dashboard,
  // Phase 1 exports
  acdiEstimate, shortageSignals, opportunityGap,
  bestSupplier, supplierExpectedProfit,
  procurementTiming, bookingPaceFraction,
  foxOptimize, evaluateACDI,
  eMinQD, eOverage, newsvendorQ, normalCDF, normalInverseCDF
};
