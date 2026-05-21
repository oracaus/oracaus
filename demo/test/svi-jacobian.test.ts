import { describe, expect, it } from "vitest";

import { rawPartials, reparamPartials } from "../src/svi/jacobian.js";
import type { SviParams } from "../src/svi/params.js";
import { levelFloor, validateParams } from "../src/svi/params.js";
import { fromReparam, type ReparamSviParams } from "../src/svi/reparam.js";
import { w } from "../src/svi/svi.js";

// Deterministic PRNG (mulberry32). No RNG in the fitter; the test sweep is
// reproducible across machines, so a fixed seed is sufficient.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function centralDiff(f: (x: number) => number, x: number, h: number): number {
  return (f(x + h) - f(x - h)) / (2 * h);
}

const TOLERANCE = 1e-7;
const H = 1e-6;
const N_SAMPLES = 1000;

function sampleParams(rng: () => number): SviParams {
  // Realistic equity-option calibration ranges, sampled uniformly. `a` is
  // forced strictly above the level floor so the level constraint passes.
  const b = 0.05 + rng() * 0.45;
  const rho = -0.95 + rng() * 1.9;
  const m = -0.3 + rng() * 0.6;
  const sigma = 0.05 + rng() * 0.45;
  const floor = levelFloor(b, rho, sigma);
  const a = floor + 0.001 + rng() * 0.05;
  const r = validateParams({ a, b, rho, m, sigma });
  if (!r.ok) throw new Error(`sampler invalid: ${r.reason}`);
  return r.params;
}

function withRaw(p: SviParams, key: keyof SviParams, value: number): SviParams {
  // Bypass validation — the cross-check probes points around the parameter
  // that may briefly violate level constraint at the perturbed step. The
  // partials are evaluated for the raw form regardless.
  return { ...p, [key]: value } as SviParams;
}

describe("Analytical Jacobian — raw partials", () => {
  it("matches central differences within 1e-7 across 1000 random samples", () => {
    const rng = mulberry32(42);
    let maxErr = 0;
    for (let i = 0; i < N_SAMPLES; i++) {
      const p = sampleParams(rng);
      const k = -1.5 + rng() * 3.0;
      const ana = rawPartials(k, p);
      const numA = centralDiff((x) => w(k, withRaw(p, "a", x)), p.a, H);
      const numB = centralDiff((x) => w(k, withRaw(p, "b", x)), p.b, H);
      const numR = centralDiff((x) => w(k, withRaw(p, "rho", x)), p.rho, H);
      const numM = centralDiff((x) => w(k, withRaw(p, "m", x)), p.m, H);
      const numS = centralDiff((x) => w(k, withRaw(p, "sigma", x)), p.sigma, H);
      maxErr = Math.max(
        maxErr,
        Math.abs(ana.da - numA),
        Math.abs(ana.db - numB),
        Math.abs(ana.dRho - numR),
        Math.abs(ana.dm - numM),
        Math.abs(ana.dSigma - numS),
      );
    }
    expect(maxErr).toBeLessThan(TOLERANCE);
  });

  it("∂w/∂a is identically 1", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 50; i++) {
      const p = sampleParams(rng);
      const k = -2 + rng() * 4;
      expect(rawPartials(k, p).da).toBe(1);
    }
  });

  it("at k = m, ∂w/∂σ = b (the smoother dominates)", () => {
    // r = √(0 + σ²) = σ, so ∂w/∂σ = b·σ / σ = b.
    const r = validateParams({
      a: 0.04,
      b: 0.123,
      rho: -0.4,
      m: 0.05,
      sigma: 0.2,
    });
    if (!r.ok) throw new Error("fixture invalid");
    const partials = rawPartials(0.05, r.params);
    expect(partials.dSigma).toBeCloseTo(0.123, 12);
  });

  it("at extreme log-moneyness, ∂w/∂σ → 0 and ∂w/∂m → −b·(ρ ± 1)", () => {
    const r = validateParams({
      a: 0.04,
      b: 0.1,
      rho: -0.3,
      m: 0.0,
      sigma: 0.2,
    });
    if (!r.ok) throw new Error("fixture invalid");
    const right = rawPartials(1e6, r.params);
    const left = rawPartials(-1e6, r.params);
    expect(right.dSigma).toBeCloseTo(0, 6);
    expect(left.dSigma).toBeCloseTo(0, 6);
    // km/r → +1 right, −1 left
    expect(right.dm).toBeCloseTo(-0.1 * (-0.3 + 1), 6);
    expect(left.dm).toBeCloseTo(-0.1 * (-0.3 - 1), 6);
  });

  it("∂w/∂ρ = b·(k − m) — exact, linear in k − m", () => {
    const r = validateParams({
      a: 0.04,
      b: 0.1,
      rho: -0.3,
      m: 0.05,
      sigma: 0.2,
    });
    if (!r.ok) throw new Error("fixture invalid");
    for (const k of [-0.5, -0.1, 0.0, 0.05, 0.1, 0.5]) {
      expect(rawPartials(k, r.params).dRho).toBeCloseTo(0.1 * (k - 0.05), 12);
    }
  });
});

describe("Analytical Jacobian — reparametrised partials", () => {
  it("matches central differences in u-space within 1e-7 across 1000 samples", () => {
    const rng = mulberry32(2024);
    let maxErr = 0;
    for (let i = 0; i < N_SAMPLES; i++) {
      // Sample raw, then map to reparam space via inverse — but we sample
      // directly in unconstrained space to cover the full domain.
      const u: ReparamSviParams = {
        a: -0.001 + rng() * 0.05,
        bTilde: -2 + rng() * 5, // softplus → b ∈ [≈0.13, ≈3.05]
        rhoTilde: -2 + rng() * 4, // tanh → ρ ∈ [≈-0.96, ≈0.96]
        m: -0.3 + rng() * 0.6,
        sigmaTilde: -2 + rng() * 5,
      };
      const raw = fromReparam(u);
      const floor = levelFloor(raw.b, raw.rho, raw.sigma);
      const aSafe = Math.max(u.a, floor + 0.001);
      const params = validateParams({ ...raw, a: aSafe });
      if (!params.ok) continue;
      const k = -1.5 + rng() * 3.0;

      const ana = reparamPartials(k, params.params);

      const evalAt = (uu: ReparamSviParams) =>
        w(k, { ...fromReparam(uu), a: uu.a } as SviParams);
      const numA = centralDiff(
        (x) => evalAt({ ...u, a: aSafe + (x - aSafe) }),
        aSafe,
        H,
      );
      const numBT = centralDiff(
        (x) => evalAt({ ...u, a: aSafe, bTilde: x }),
        u.bTilde,
        H,
      );
      const numRT = centralDiff(
        (x) => evalAt({ ...u, a: aSafe, rhoTilde: x }),
        u.rhoTilde,
        H,
      );
      const numM = centralDiff((x) => evalAt({ ...u, a: aSafe, m: x }), u.m, H);
      const numST = centralDiff(
        (x) => evalAt({ ...u, a: aSafe, sigmaTilde: x }),
        u.sigmaTilde,
        H,
      );
      maxErr = Math.max(
        maxErr,
        Math.abs(ana.da - numA),
        Math.abs(ana.dbTilde - numBT),
        Math.abs(ana.dRhoTilde - numRT),
        Math.abs(ana.dm - numM),
        Math.abs(ana.dSigmaTilde - numST),
      );
    }
    expect(maxErr).toBeLessThan(TOLERANCE);
  });

  it("chain-rule multipliers approach 0 at the bounds and 1 at the centre", () => {
    // b → 0  ⇒ 1 − e^{−b} → 0       (∂w/∂b̃ → 0)
    // |ρ| → 1 ⇒ 1 − ρ² → 0          (∂w/∂ρ̃ → 0)
    // σ → 0  ⇒ 1 − e^{−σ} → 0       (∂w/∂σ̃ → 0)
    const tight = validateParams({
      a: 0.0,
      b: 1e-6,
      rho: 0.0,
      m: 0,
      sigma: 1e-3,
    });
    if (!tight.ok) throw new Error("tight invalid");
    const partials = reparamPartials(0.1, tight.params);
    expect(Math.abs(partials.dbTilde)).toBeLessThan(1e-6);
    expect(Math.abs(partials.dSigmaTilde)).toBeLessThan(1e-6);

    const wide = validateParams({
      a: 0.04,
      b: 5.0,
      rho: 0.0,
      m: 0,
      sigma: 5.0,
    });
    if (!wide.ok) throw new Error("wide invalid");
    const wideRaw = rawPartials(0.1, wide.params);
    const wideRe = reparamPartials(0.1, wide.params);
    // 1 − e^{−5} ≈ 0.9933 — chain factor close to 1
    expect(wideRe.dbTilde).toBeCloseTo(wideRaw.db * (1 - Math.exp(-5)), 10);
    expect(wideRe.dSigmaTilde).toBeCloseTo(
      wideRaw.dSigma * (1 - Math.exp(-5)),
      10,
    );
  });
});
