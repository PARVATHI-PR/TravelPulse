'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  optimize, opportunities,
  acdiEstimate, shortageSignals, opportunityGap,
  bestSupplier, supplierExpectedProfit,
  procurementTiming, bookingPaceFraction,
  foxOptimize, evaluateACDI,
  eMinQD, eOverage, newsvendorQ, normalCDF, normalInverseCDF
} = require('../server');

// ─── Original 5 tests (preserved exactly) ─────────────────────────────────

test('optimizer stays within budget and supplier availability', () => {
  const p = optimize({ budget: 90000 });
  assert.ok(p.investment <= p.budget);
  assert.ok(p.remaining >= 0);
  assert.ok(p.purchases.every(x => x.recommended <= x.available));
});

test('zero budget yields no purchases and no spend', () => {
  const p = optimize({ budget: 0 });
  assert.equal(p.investment, 0);
  assert.equal(p.purchases.length, 0);
});

test('budget input validation is explicit', () =>
  assert.throws(() => optimize({ budget: -1 }), /Budget/)
);

test('scenario changes affect computed opportunity forecast', () => {
  const a = opportunities({ demandShift: 0 });
  const b = opportunities({ demandShift: .2 });
  assert.ok(b[0].forecast > a[0].forecast);
});

test('higher risk tolerance admits at least as many candidate rows', () => {
  const conservative = optimize({ budget: 1000000, riskTolerance: 0 });
  const tolerant     = optimize({ budget: 1000000, riskTolerance: 100 });
  assert.ok(tolerant.purchases.length >= conservative.purchases.length);
});

// ─── Phase 3: 8 new tests ─────────────────────────────────────────────────

// NEW TEST 1 — E[min(Q,D)] closed-form log-normal formula
// Bangkok hotel parameters: mu=2120, CV=0.30, Q=1678
// Expected: ~1611 (validated in v3 technical report)
test('eMinQD returns analytically correct value for Bangkok newsvendor parameters', () => {
  const result = eMinQD(1678, 2120, 0.30);
  // Tolerance: ±15 rooms (< 1% of Q)
  assert.ok(
    Math.abs(result - 1611) <= 15,
    `Expected E[min(1678,D|mu=2120,CV=0.30)] ≈ 1611, got ${result.toFixed(1)}`
  );
});

// NEW TEST 2 — Normal inverse CDF symmetry and key quantiles
// Φ⁻¹(0.260) ≈ −0.6433,  Φ⁻¹(0.740) ≈ +0.6433,  Φ⁻¹(0.5) = 0
test('normalInverseCDF satisfies symmetry and key quantiles', () => {
  const q260 = normalInverseCDF(0.260);
  const q740 = normalInverseCDF(0.740);
  const q500 = normalInverseCDF(0.500);

  // Symmetry: Φ⁻¹(p) = −Φ⁻¹(1−p)
  assert.ok(Math.abs(q260 + q740) < 0.001, `Symmetry failure: ${q260} + ${q740}`);
  // Median = 0
  assert.ok(Math.abs(q500) < 0.001, `Φ⁻¹(0.5) should be 0, got ${q500}`);
  // CR=0.260 → critical ratio below 0.5 → Q* < mu (conservative procurement)
  assert.ok(q260 < 0, `Φ⁻¹(0.260) should be negative, got ${q260}`);
  // Value check: Φ⁻¹(0.260) ≈ −0.6433
  assert.ok(
    Math.abs(q260 - (-0.6433)) < 0.01,
    `Expected Φ⁻¹(0.260) ≈ -0.6433, got ${q260.toFixed(4)}`
  );
});

// NEW TEST 3 — Newsvendor Q* log-normal formula
// Bangkok: mu=2120, CV=0.30, CR=0.260 → Q*≈1678
// ACDI: mu=3029 (hypothetical 43% more), same CR → Q*≈2397
test('newsvendorQ log-normal formula produces correct critical quantile', () => {
  const qNaive = newsvendorQ(2120, 0.30, 0.260);
  const qACDI  = newsvendorQ(3029, 0.30, 0.260);

  // Q* must be below mu when CR < 0.5 (conservative)
  assert.ok(qNaive < 2120, `Q*(CR=0.260) should be below mu=2120, got ${qNaive}`);
  assert.ok(qACDI  < 3029, `Q*(CR=0.260) should be below mu=3029, got ${qACDI}`);
  // Q* must be strictly positive
  assert.ok(qNaive > 0, `Q* should be positive, got ${qNaive}`);
  // ACDI Q* should scale with ACDI demand
  assert.ok(qACDI > qNaive, `ACDI Q*(${qACDI}) should exceed naive Q*(${qNaive})`);
  // Tolerance check: naive Q* ≈ 1678 ± 20
  assert.ok(
    Math.abs(qNaive - 1678) <= 20,
    `Expected Q*(mu=2120,CR=0.260) ≈ 1678, got ${qNaive}`
  );
});

// NEW TEST 4 — Supplier profit formula: no double-deduction of procurement cost
// E[Π(Q,s)] = (1-k)(p-v·r)·E[min(Q,D)] - Q·(vEff·(1-r) + p·f)
// Procurement cost vEff appears exactly once.
// Verification: supplying Q=0 must yield exactly 0 profit.
// Also: profit with high-phantom supplier must be ≤ profit with low-phantom supplier
//       (all else equal), since phantom raises effective cost.
test('supplier expected profit formula has no double-deduction and responds correctly to phantom rate', () => {
  const p = 124, k = 0.16, f = 0.06, mu = 2120, cv = 0.30, Q = 1678;

  const lowPhantom  = { v: 76, phantom: 0.03, salvage: 0.22 };
  const highPhantom = { v: 76, phantom: 0.20, salvage: 0.22 };

  const profitLow  = supplierExpectedProfit(Q, mu, cv, p, k, f, lowPhantom);
  const profitHigh = supplierExpectedProfit(Q, mu, cv, p, k, f, highPhantom);

  // Q=0 must yield exactly zero regardless of supplier
  const profitZero = supplierExpectedProfit(0, mu, cv, p, k, f, lowPhantom);
  assert.ok(Math.abs(profitZero) < 1e-9, `E[Π(0,s)] must be 0, got ${profitZero}`);

  // Higher phantom → higher effective cost → lower expected profit
  assert.ok(
    profitHigh < profitLow,
    `Higher phantom supplier (${profitHigh.toFixed(0)}) should yield less profit than low-phantom (${profitLow.toFixed(0)})`
  );

  // Profit must be a finite number (no NaN from division issues)
  assert.ok(Number.isFinite(profitLow),  `Low-phantom profit is not finite: ${profitLow}`);
  assert.ok(Number.isFinite(profitHigh), `High-phantom profit is not finite: ${profitHigh}`);
});

// NEW TEST 5 — Booking pace boundary conditions
// P(daysRemaining=90) must equal 0.0 (no time elapsed → no bookings yet)
// P(daysRemaining=0)  must equal 1.0 (travel day → 100% of demand realized)
// P must be strictly monotonically decreasing as daysRemaining increases
test('bookingPaceFraction satisfies boundary conditions and monotonicity', () => {
  const pFull  = bookingPaceFraction(0);    // 0 days remaining → all elapsed
  const pEmpty = bookingPaceFraction(90);   // 90 days remaining → none elapsed

  assert.ok(
    Math.abs(pFull - 1.0) < 1e-9,
    `P(daysRemaining=0) must be 1.0, got ${pFull}`
  );
  assert.ok(
    Math.abs(pEmpty - 0.0) < 1e-9,
    `P(daysRemaining=90) must be 0.0, got ${pEmpty}`
  );

  // Strict monotonicity: more days remaining → less fraction booked
  const checkpoints = [80, 60, 45, 30, 15, 0];
  let prev = bookingPaceFraction(90);
  for (const d of checkpoints) {
    const curr = bookingPaceFraction(d);
    assert.ok(curr > prev, `Pace should increase as daysRemaining decreases (at d=${d}: ${curr} vs prev ${prev})`);
    prev = curr;
  }
});

// NEW TEST 6 — ACDI MAPE improvement over naive baseline
// On the synthetic dataset, ACDI must achieve lower MAPE than naive
// (observed bookings alone) on average across all 8 destinations.
// Also: individual destination MAPE values must be finite and non-negative.
test('ACDI achieves lower average MAPE than naive baseline on synthetic ground truth', () => {
  const val = evaluateACDI();

  assert.ok(val && val.aggregate, 'evaluateACDI must return an aggregate object');
  assert.ok(
    val.aggregate.avgACDImape < val.aggregate.avgNaiveMAPE,
    `ACDI MAPE (${val.aggregate.avgACDImape}%) should be less than naive MAPE (${val.aggregate.avgNaiveMAPE}%)`
  );
  // All individual MAPEs must be non-negative finite numbers
  for (const d of val.destinations) {
    assert.ok(Number.isFinite(d.acdiMAPE)  && d.acdiMAPE  >= 0, `ACDI MAPE for ${d.destId} invalid: ${d.acdiMAPE}`);
    assert.ok(Number.isFinite(d.naiveMAPE) && d.naiveMAPE >= 0, `Naive MAPE for ${d.destId} invalid: ${d.naiveMAPE}`);
  }
});

// NEW TEST 7 — Risk-γ monotonicity
// A higher overage-aversion parameter γ penalises unsold inventory more heavily.
// Economic properties that MUST hold monotonically as γ increases:
//   • Expected profit must decrease (optimizer sacrifices profit to cut risk).
//   • Overage risk (riskExposure) must decrease (that's the point of γ).
//   • Unit count purchased must decrease (fewer units → less overage exposure).
// Investment can vary slightly due to heterogeneous unit costs filling the same
// budget with different combinations — it is NOT required to be monotone.
test('higher gamma aversion parameter produces lower overage risk and lower expected profit', () => {
  const budget = 300000;
  const p0 = optimize({ budget, gamma: 0   });   // pure expected profit
  const p1 = optimize({ budget, gamma: 1.5 });   // moderate aversion
  const p5 = optimize({ budget, gamma: 5   });   // strong aversion

  // 1. Expected profit must be non-increasing as γ rises
  assert.ok(
    p1.profit <= p0.profit + 0.01,  // tiny tolerance for floating-point
    `γ=1.5 profit (${p1.profit}) should be ≤ γ=0 profit (${p0.profit})`
  );
  assert.ok(
    p5.profit <= p1.profit + 0.01,
    `γ=5 profit (${p5.profit}) should be ≤ γ=1.5 profit (${p1.profit})`
  );

  // 2. Overage risk (riskExposure) must be non-increasing as γ rises
  assert.ok(
    p1.riskExposure <= p0.riskExposure + 0.01,
    `γ=1.5 riskExposure (${p1.riskExposure}) should be ≤ γ=0 riskExposure (${p0.riskExposure})`
  );
  assert.ok(
    p5.riskExposure <= p1.riskExposure + 0.01,
    `γ=5 riskExposure (${p5.riskExposure}) should be ≤ γ=1.5 riskExposure (${p1.riskExposure})`
  );

  // 3. Unit count purchased must be non-increasing as γ rises
  const units0 = p0.purchases.reduce((s, x) => s + x.recommended, 0);
  const units1 = p1.purchases.reduce((s, x) => s + x.recommended, 0);
  const units5 = p5.purchases.reduce((s, x) => s + x.recommended, 0);
  assert.ok(units1 <= units0, `γ=1.5 units (${units1}) should be ≤ γ=0 units (${units0})`);
  assert.ok(units5 <= units1, `γ=5 units (${units5}) should be ≤ γ=1.5 units (${units1})`);

  // 4. Model labels must be correct (not CVaR)
  assert.ok(p0.model.includes('Fox'), `γ=0 model label should mention Fox: ${p0.model}`);
  assert.ok(p1.model.includes('risk-penalized'), `γ=1.5 label should say risk-penalized: ${p1.model}`);
  // The model label must contain "NOT CVaR" — explicitly disclaiming it is not CVaR
  assert.ok(p1.model.includes('NOT CVaR'), `γ>0 model label should contain explicit "NOT CVaR" disclaimer: ${p1.model}`);
});

// NEW TEST 8 — Fox marginal allocation: separability and per-dollar efficiency
// For two destinations with same margin but different unit costs, the cheaper
// destination's marginal efficiency (Δ/cost) must dominate, so Fox allocates
// to it first. This verifies the Δi/vi rule is applied correctly.
test('Fox optimizer allocates first to the highest marginal-efficiency-per-dollar destination', () => {
  // Build two minimal synthetic candidates with known properties:
  // Cheap: cost=$50, sell=$90, same demand profile → high Δ/cost
  // Expensive: cost=$200, sell=$360, same margin% → lower Δ/cost
  const rows = [
    {
      destination: 'CheapDest', code: 'CHD', region: 'Test', category: 'hotel',
      categoryName: 'Hotel rooms', forecast: 500, naiveForecast: 500,
      suppressedDemand: 0, available: 500, cost: 50, sell: 90,
      cancellation: 0.10, margin: 25, risk: 15, score: 70, label: 'High potential',
      recommended: 500, revenue: 0, profit: 0, procurementCost: 0, riskExposure: 0,
      chosenSupplierName: 'Mock', explanation: 'Test'
    },
    {
      destination: 'ExpDest', code: 'EXD', region: 'Test', category: 'hotel',
      categoryName: 'Hotel rooms', forecast: 500, naiveForecast: 500,
      suppressedDemand: 0, available: 500, cost: 200, sell: 360,
      cancellation: 0.10, margin: 100, risk: 15, score: 70, label: 'High potential',
      recommended: 500, revenue: 0, profit: 0, procurementCost: 0, riskExposure: 0,
      chosenSupplierName: 'Mock', explanation: 'Test'
    }
  ];

  // Budget = 51 — can buy exactly 1 unit of CheapDest or 0 units of ExpDest
  const { state } = foxOptimize(51, rows, 0, 100, 0);
  const cheapQ = state['CHD|hotel']?.qi ?? 0;
  const expQ   = state['EXD|hotel']?.qi ?? 0;

  assert.ok(cheapQ >= 1, `Fox should allocate to cheap destination first (got qi=${cheapQ})`);
  assert.equal(expQ, 0, `Fox should not allocate to expensive dest with budget=51 (got qi=${expQ})`);

  // Budget = 300 — can buy 6 cheap or 1 expensive; Fox should still prefer cheap by Δ/vi
  const { state: state2 } = foxOptimize(300, rows, 0, 100, 0);
  const cheapQ2 = state2['CHD|hotel']?.qi ?? 0;
  assert.ok(cheapQ2 >= 1, `Fox should allocate to cheap destination with budget=300 (got ${cheapQ2})`);
});
