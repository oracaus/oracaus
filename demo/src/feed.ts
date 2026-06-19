// Synthetic surface feed. Deterministic generative model:
//
//   Spot:        S_{t+Δt} = S_t · exp((r − σ_spot²/2)·Δt + σ_spot·√Δt · z)
//
//   Global SVI:  (a*, b*, ρ*, m*, σ*) drift as Ornstein-Uhlenbeck random
//                walks anchored on SPX-style equity-index defaults — ONE
//                global state, shared across the whole surface.
//
//   Per-slice:   a_T  = a* · T   (deterministic T-scaling on `a`)
//                b_T  = b*, ρ_T = ρ*, m_T = m*, σ_T = σ*  (shared)
//
//   IV:          per-(strike, maturity) IV_{k,T} = √(w(k, params_T) / T) + ε
//                with ε ~ N(0, σ_iv²) drawn independently per (k, T)
//
// The T-scaling on `a` makes the TRUE surface calendar-arb-free by
// construction: w(k, T_{i+1}) − w(k, T_i) = (a*·T_{i+1} − a*·T_i) =
// a*·(ΔT) ≥ 0 at every k (the non-`a` term is shared across maturities).
// The shared OU walk on globals shifts the whole surface together rather
// than letting per-slice random walks decouple, which would routinely
// produce calendar violations.
//
// Per-(k, T) IV noise is independent, so OBSERVED quotes can still
// produce per-slice fits that violate the calendar bound at a few
// strikes — exactly the noise-induced regime the repair pass is designed
// for. The true underlying surface is monotone in T at every k; that's
// verified by the calendarCheck test in `demo/test/`.
//
// Parameter clamps after each OU step enforce raw-SVI feasibility:
//   a* ∈ [0.001, 1.0], b* ∈ [0.01, 1.0], ρ* ∈ (−0.95, 0.95),
//   m* ∈ [−0.5, 0.5], σ* ∈ [0.01, 1.0].
// The level constraint a* + b*·σ*·√(1−ρ*²) ≥ 0 is re-validated post-clamp;
// if a step violates it (rare under these ranges), the step is rejected
// and the previous state is retained for that tick.
//
// Determinism: `mulberry32(seed)` drives every random draw; same seed →
// byte-identical sequence. URL params `?seed=<int>` and `?mode=recording`
// are read on App mount to lock the feed for reproducible recording takes.

import type { RawSviParams, SviParams } from "./svi/params.js";
import { validateParams } from "./svi/params.js";
import type { Slice } from "./svi/svi.js";
import { ivToVariance, w } from "./svi/svi.js";

// ─── PRNG ────────────────────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller from a uniform PRNG. Returns one standard-normal draw. */
function gaussian(rng: () => number): number {
  let u = rng();
  if (u === 0) u = Number.MIN_VALUE;
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ─── Anchors and config ──────────────────────────────────────────────────────

/**
 * SPX-style anchor for the global base SVI parameters. The OU random walk
 * mean-reverts to these; per-tick diffusion is small (see PER_TICK_DIFFUSION).
 * `a` here is the BASE level — per-slice `a_T = a · T`.
 */
const SVI_ANCHOR: RawSviParams = {
  a: 0.04,
  b: 0.1,
  rho: -0.5,
  m: 0.0,
  sigma: 0.2,
};

/**
 * Per-tick OU step parameters. Calibrated for visible drift on the smile
 * chart over a demo session, not for any particular real-world cadence.
 * Magnitudes target ~3–8 % parameter drift over 100 ticks under base
 * conditions, scaling × shockMultiplier under vol shock.
 *
 * Mean reversion caps the random-walk variance so params don't run away
 * from their SPX anchors over long demo sessions.
 */
const PER_TICK_REVERT = 0.005;

/** Per-tick Gaussian noise stddev for each global SVI parameter (no-shock baseline). */
const PER_TICK_DIFFUSION: Record<keyof RawSviParams, number> = {
  a: 6e-4,
  b: 1.2e-3,
  rho: 4e-3,
  m: 1.5e-3,
  sigma: 1.5e-3,
};

/** Parameter clamps enforced after each OU step. */
const CLAMPS = {
  a: { min: 0.001, max: 1.0 },
  b: { min: 0.01, max: 1.0 },
  rho: { min: -0.95, max: 0.95 },
  m: { min: -0.5, max: 0.5 },
  sigma: { min: 0.01, max: 1.0 },
} as const;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Spot defaults — typical SPX-style values. */
const SPOT_INITIAL = 100;
const RISK_FREE_RATE = 0.05;
const SPOT_VOL = 0.2;

/** Per-tick time step in years — used by the GBM spot evolution only. */
const TIME_STEP_YEARS = 1 / 252 / 50;

// ─── Surface dimensions ──────────────────────────────────────────────────────

/** Default surface: 70 expiries × 200 strikes (14 000 quotes). */
const DEFAULT_N_EXPIRIES = 70;
const DEFAULT_N_STRIKES = 200;

/**
 * Build a maturity ladder exponentially spaced from 1 week to 3 years.
 * Matches the bench-file ladder (single source of truth via this helper
 * for the synthetic surface; production adopters supply their own).
 */
export function buildExpiryLadder(nExpiries: number): number[] {
  const tMin = 7 / 365;
  const tMax = 3.0;
  return Array.from({ length: nExpiries }, (_, i) => {
    const u = i / (nExpiries - 1);
    return tMin * (tMax / tMin) ** u;
  });
}

/** Build a uniform log-moneyness grid spanning ±50 % in `k`. */
export function buildStrikeGrid(nStrikes: number): number[] {
  return Array.from({ length: nStrikes }, (_, i) => {
    const u = i / (nStrikes - 1);
    return -1.0 + 2.0 * u;
  });
}

// ─── Feed types ──────────────────────────────────────────────────────────────

export type FeedTick = {
  /**
   * Per-maturity slices for fitting — one Slice per configured expiry,
   * ordered by `timeToExpiry`. Calendar-arb-free in expectation (the
   * TRUE underlying surface is monotone in T at every k by construction;
   * noise on observed quotes can produce per-slice fits that violate
   * locally — the repair pass handles that).
   */
  readonly slices: readonly Slice[];
  /**
   * True per-slice SVI parameters that generated this tick. Aligned 1:1
   * with `slices`. Used by the verification UI to compute ground-truth
   * tracking error. Hidden from the fitter.
   */
  readonly trueParamsPerSlice: readonly SviParams[];
  /** Current spot. */
  readonly spot: number;
  /** Monotonic tick index since feed start. */
  readonly tickIndex: number;
  /** Wall-clock timestamp at emission (ms since epoch). */
  readonly emittedAt: number;
};

export type FeedConfig = {
  readonly seed: number;
  /** Number of expiries in the surface. Default 70. */
  readonly nExpiriesFitted: number;
  /** Strikes per slice. Default 200. */
  readonly nStrikesPerSlice: number;
  /**
   * σ noise added to each emitted IV (decimal). Default 0.001 = 10 bps —
   * SPX-ATM-realistic. The earlier default 0.005 = 50 bps produced
   * persistent calendar-arb violations at 70-slice scale (per-pair noise
   * larger than inter-slice variance gap on the short-T tail of the
   * exponential ladder), with every tick tripping `repair-failed`.
   * At 10 bps the demo emits clean (arb-free) output on the majority of
   * ticks, with occasional repair activity visible via the panel chip.
   */
  readonly ivNoise: number;
  /**
   * Vol-shock multiplier. 1 = no shock; 5 = strong shock. Multiplies spot σ
   * AND the OU diffusion of every parameter for the duration of the shock.
   */
  readonly shockMultiplier: number;
};

const DEFAULT_CONFIG: FeedConfig = {
  seed: 42,
  nExpiriesFitted: DEFAULT_N_EXPIRIES,
  nStrikesPerSlice: DEFAULT_N_STRIKES,
  ivNoise: 0.001,
  shockMultiplier: 1,
};

// Pre-baked per-quote IV noise pool. The default surface emits
// 14 000 noise draws per tick × 50 Hz = 700 K Box-Muller transforms
// per second — empirically the single largest main-thread cost in a
// steady-state quiescent feed trace (~40 % self time in `gaussian`,
// 16 % in the `mulberry32` closure). Pre-baking the pool at feed
// construction collapses the per-tick cost to 14 000 Float64Array
// reads — ~5 ns each, two orders of magnitude cheaper.
//
// Determinism is preserved: the pool is filled from the feed's seeded
// PRNG, so identical seeds still produce identical IV sequences. The
// pool advances the PRNG state by `POOL_SIZE × 2` reads (Box-Muller
// uses two uniforms per draw) before the first `step()` consumes
// spot / OU randomness, but both consumers (spot+OU) and per-quote
// noise stay tied to the same seed-derived stream — the byte-identical
// determinism property holds.
//
// Power-of-two size lets us wrap the cursor with a bit-AND mask
// instead of `%` — measurable on the hot path.
const NOISE_POOL_SIZE = 16384;
const NOISE_POOL_MASK = NOISE_POOL_SIZE - 1;

// ─── Feed state machine ──────────────────────────────────────────────────────

export class SyntheticFeed {
  private rng: () => number;
  private globalParams: RawSviParams;
  private spot: number;
  private tickIndex: number;
  // Maturities are mutable via `setMaturityCount` so the demo's
  // expiry-count selector can rebuild the ladder without resetting
  // the feed's evolving state. Strikes remain readonly (the demo has
  // no UI to change strike count; reset-on-construct is fine).
  private maturities: readonly number[];
  private readonly strikes: readonly number[];
  private ivNoise: number;
  private shockMultiplier: number;
  private readonly noisePool: Float64Array;
  private noiseCursor: number;

  constructor(config: Partial<FeedConfig> = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    this.rng = mulberry32(cfg.seed);
    this.globalParams = { ...SVI_ANCHOR };
    this.spot = SPOT_INITIAL;
    this.tickIndex = 0;
    this.maturities = buildExpiryLadder(cfg.nExpiriesFitted);
    this.strikes = buildStrikeGrid(cfg.nStrikesPerSlice);
    this.ivNoise = cfg.ivNoise;
    this.shockMultiplier = cfg.shockMultiplier;
    // Pre-fill the noise pool before any tick consumes randomness, so
    // pool reads remain free of cross-call PRNG state contention.
    // ~16 ms one-time cost on M-series Mac at this pool size.
    this.noisePool = new Float64Array(NOISE_POOL_SIZE);
    for (let i = 0; i < NOISE_POOL_SIZE; i++) {
      this.noisePool[i] = gaussian(this.rng);
    }
    this.noiseCursor = 0;
    // Defensive guard: a future config exposing `nStrikesPerSlice` or
    // `nExpiriesFitted` beyond their current ceilings could exceed the
    // pool size in a single tick, which would cause within-tick noise
    // repetition (adjacent strikes seeing identical noise). The current
    // ceilings (80 × 200 = 16 000) fit inside the 16 384 pool with
    // 384 entries of headroom; throw early if a future change breaks
    // this invariant.
    const perTick = cfg.nExpiriesFitted * cfg.nStrikesPerSlice;
    if (perTick > NOISE_POOL_SIZE) {
      throw new Error(
        `SyntheticFeed: per-tick noise demand ${perTick} exceeds pool size ${NOISE_POOL_SIZE}; increase NOISE_POOL_SIZE.`,
      );
    }
  }

  setShockMultiplier(value: number): void {
    this.shockMultiplier = value;
  }

  /**
   * Rebuild the maturity ladder for a different expiry count without
   * resetting the OU walk, spot, tick index, or noise pool. Used by
   * the demo's expiry-count selector: changing display granularity
   * shouldn't snap the underlying market back to anchor — the OU walk
   * should continue smoothly across UI-driven changes.
   *
   * Validates the noise-pool invariant against the new dimensions; a
   * future config that pushes per-tick noise demand past `NOISE_POOL_SIZE`
   * throws here just as the constructor does.
   */
  setMaturityCount(nExpiriesFitted: number): void {
    const perTick = nExpiriesFitted * this.strikes.length;
    if (perTick > NOISE_POOL_SIZE) {
      throw new Error(
        `SyntheticFeed.setMaturityCount: per-tick noise demand ${perTick} exceeds pool size ${NOISE_POOL_SIZE}; increase NOISE_POOL_SIZE.`,
      );
    }
    this.maturities = buildExpiryLadder(nExpiriesFitted);
  }

  /** Maturities used by this feed (also useful for chart axes). */
  getMaturities(): readonly number[] {
    return this.maturities;
  }

  /** Strikes used by this feed (also useful for chart axes). */
  getStrikes(): readonly number[] {
    return this.strikes;
  }

  /** Step state forward by one tick and emit the whole surface. */
  step(): FeedTick {
    // Spot — GBM step. shockMultiplier amplifies σ during a shock.
    const spotSigma = SPOT_VOL * this.shockMultiplier;
    const drift =
      (RISK_FREE_RATE - 0.5 * spotSigma * spotSigma) * TIME_STEP_YEARS;
    const diffusion =
      spotSigma * Math.sqrt(TIME_STEP_YEARS) * gaussian(this.rng);
    this.spot = this.spot * Math.exp(drift + diffusion);

    // Global SVI base params — OU step on each. The walk is global; per-slice
    // params are derived from these post-step. shockMultiplier amplifies
    // diffusion.
    const candidate: {
      a: number;
      b: number;
      rho: number;
      m: number;
      sigma: number;
    } = {
      a: this.globalParams.a,
      b: this.globalParams.b,
      rho: this.globalParams.rho,
      m: this.globalParams.m,
      sigma: this.globalParams.sigma,
    };
    for (const key of ["a", "b", "rho", "m", "sigma"] as const) {
      const meanRevert =
        PER_TICK_REVERT * (SVI_ANCHOR[key] - this.globalParams[key]);
      const noise =
        PER_TICK_DIFFUSION[key] * this.shockMultiplier * gaussian(this.rng);
      candidate[key] = this.globalParams[key] + meanRevert + noise;
    }
    // Clamp to keep params strictly inside the SVI feasible region.
    candidate.a = clamp(candidate.a, CLAMPS.a.min, CLAMPS.a.max);
    candidate.b = clamp(candidate.b, CLAMPS.b.min, CLAMPS.b.max);
    candidate.rho = clamp(candidate.rho, CLAMPS.rho.min, CLAMPS.rho.max);
    candidate.m = clamp(candidate.m, CLAMPS.m.min, CLAMPS.m.max);
    candidate.sigma = clamp(
      candidate.sigma,
      CLAMPS.sigma.min,
      CLAMPS.sigma.max,
    );

    // Validate against the level-coupling constraint a + b·σ·√(1−ρ²) ≥ 0.
    // If the candidate violates (rare given clamps above and the SPX-style
    // anchor), reject the step and retain the previous state.
    const candidateValidated = validateParams(candidate);
    if (candidateValidated.ok) {
      this.globalParams = candidate;
    }
    // else: silently retain previous globalParams for this tick.

    // Derive per-slice params: a_T = a* · T; b, ρ, m, σ shared.
    // The shared-params choice is deliberate — it makes the surface
    // calendar-arb-free at every k (since w(k, T_{i+1}) − w(k, T_i) =
    // (a*·T_{i+1} − a*·T_i) = a*·ΔT > 0). Real surfaces have term-structure
    // of skew; that's a refinement deferred to post-v1 if signal warrants.
    const trueParamsPerSlice: SviParams[] = [];
    const slices: Slice[] = [];
    for (const T of this.maturities) {
      const perSlice = {
        a: this.globalParams.a * T,
        b: this.globalParams.b,
        rho: this.globalParams.rho,
        m: this.globalParams.m,
        sigma: this.globalParams.sigma,
      };
      // Re-validate per slice — the a-scaling can in theory push a outside
      // its clamp range for large T, but the level constraint stays
      // satisfied (b·σ·√(1−ρ²) is unchanged; a only grows). Worst case
      // is a-clamp range cleared — accept the brand from validateParams.
      const v = validateParams(perSlice);
      if (!v.ok) {
        // Unreachable under SPX-style anchors + clamps: a* > 0 implies
        // a_T = a* · T > 0; level floor unchanged from the global validation.
        // Fall back to the validated global params (T = 1 effectively).
        const fallback = validateParams(this.globalParams);
        if (!fallback.ok) throw new Error("feed: globalParams invalid");
        trueParamsPerSlice.push(fallback.params);
      } else {
        trueParamsPerSlice.push(v.params);
      }
      const sliceParams = trueParamsPerSlice[trueParamsPerSlice.length - 1];
      if (sliceParams === undefined)
        throw new Error("feed: missing slice params");
      // Observed quotes — true IV at each strike + independent Gaussian noise.
      // Noise is drawn from the pre-baked pool (see NOISE_POOL_SIZE
      // header). Cursor wraps after each draw via the bit-AND mask.
      const quotes = this.strikes.map((k) => {
        const trueW = w(k, sliceParams);
        const trueIv = Math.sqrt(trueW / T);
        // The cursor is bit-masked to stay inside the pool, so the
        // indexed access is always in-bounds — the non-null assertion
        // is to satisfy `noUncheckedIndexedAccess`, not a real
        // possibility. Float64Array reads compile down to a single
        // bounds-checked load.
        const noise = this.noisePool[this.noiseCursor] as number;
        this.noiseCursor = (this.noiseCursor + 1) & NOISE_POOL_MASK;
        const noisyIv = trueIv + this.ivNoise * noise;
        const safeIv = noisyIv > 0.005 ? noisyIv : 0.005;
        return { logMoneyness: k, impliedVol: safeIv };
      });
      slices.push({ quotes, timeToExpiry: T });
    }

    this.tickIndex += 1;
    return {
      slices,
      trueParamsPerSlice,
      spot: this.spot,
      tickIndex: this.tickIndex,
      emittedAt: Date.now(),
    };
  }
}

// ─── URL-param parsing for recording mode ────────────────────────────────────

export type FeedSession = {
  readonly seed: number;
  readonly recording: boolean;
  /**
   * Initial feed tick rate in Hz, from `?rate=<n>`. Lets a capture or
   * recording take open straight at e.g. 500 Hz without touching the toolbar,
   * and survive the reload Lighthouse forces (the toolbar setting is React
   * state and resets on reload; the URL param does not). Clamped to
   * [1, 1000]; defaults to 50.
   */
  readonly tickRateHz: number;
};

const DEFAULT_TICK_RATE_HZ = 50;

export function readFeedSession(): FeedSession {
  if (typeof window === "undefined") {
    return { seed: 42, recording: false, tickRateHz: DEFAULT_TICK_RATE_HZ };
  }
  const params = new URLSearchParams(window.location.search);
  const seedRaw = params.get("seed");
  const seed = seedRaw !== null ? Number.parseInt(seedRaw, 10) : 42;
  const recording = params.get("mode") === "recording";
  const rateRaw = params.get("rate");
  const rateParsed =
    rateRaw !== null ? Number.parseInt(rateRaw, 10) : Number.NaN;
  const tickRateHz = Number.isFinite(rateParsed)
    ? Math.min(1000, Math.max(1, rateParsed))
    : DEFAULT_TICK_RATE_HZ;
  return {
    seed: Number.isFinite(seed) ? seed : 42,
    recording,
    tickRateHz,
  };
}

/** Anchor exported so verification UI can show "drift from anchor". */
export const FEED_ANCHOR = SVI_ANCHOR;

/** Convert variance to IV — re-exported for adopter convenience. */
export { ivToVariance };
